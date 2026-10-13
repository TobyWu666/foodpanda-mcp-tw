/**
 * Browser-backed HTTP transport.
 *
 * Why this exists: fd-api is fronted by PerimeterX (the "Access to this page has
 * been denied" / px-captcha wall). Anonymous or cookie-less fetch() calls get a
 * 403 challenge payload before the API ever sees the request, which is exactly
 * what we measured from a French IP against both ph.fd-api.com and
 * hk.fd-api.com. A real browser context solves the challenge once and then holds
 * the _px3 cookie, so requests issued *from that context* are served normally.
 *
 * Everything goes through one persistent Playwright context:
 *   - it is the same context the login flow uses, so login cookies are reused;
 *   - cookies (auth, PX, session) live in one place;
 *   - the browser profile on disk keeps the PX clearance between runs.
 */

import { mkdirSync, rmSync, existsSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { join } from "path";
import { getRegionConfig, stateDir } from "./config.js";

export interface TransportResponse {
  status: number;
  ok: boolean;
  text: string;
}

// Same directory as token-manager's browserProfileDir(): honours FOODPANDA_STATE_DIR.
const PROFILE_DIR = join(stateDir(), "browser-data");

interface BrowserLike {
  launchPersistentContext: (dir: string, options: Record<string, unknown>) => Promise<any>;
}

/** Playwright proxy object from a URL string ("", http://h:p, socks5://u:p@h:p). */
export function proxyOptions(url: string): { server: string; username?: string; password?: string } | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const server = `${u.protocol}//${u.host}`;
    const opts: { server: string; username?: string; password?: string } = { server };
    if (u.username) opts.username = decodeURIComponent(u.username);
    if (u.password) opts.password = decodeURIComponent(u.password);
    return opts;
  } catch {
    throw new Error(`FOODPANDA_PROXY is not a valid proxy URL: ${url}`);
  }
}

/** How the browser gets a screen. */
export type DisplayPlan =
  | { kind: "none" } // headless, or the OS's own window system (macOS, Windows)
  | { kind: "existing"; display: string } // an X server the user already runs
  | { kind: "xvfb" }; // start a private Xvfb (Linux server with no screen)

/**
 * Decide where a headed browser draws. Xvfb only exists for X11 on Linux: macOS and
 * Windows open the window on their own display.
 */
export function planDisplay(input: {
  headless: boolean;
  autoXvfb: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): DisplayPlan {
  if (input.headless) return { kind: "none" }; // new-headless needs no X server
  if (input.env.DISPLAY) return { kind: "existing", display: input.env.DISPLAY };
  if (input.platform !== "linux") return { kind: "none" };
  if (!input.autoXvfb) return { kind: "none" };
  return { kind: "xvfb" };
}

/** What the display code touches outside the process; replaced in tests. */
export interface DisplayDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: (command: string, args: string[], options: { stdio: "ignore" }) => ChildProcess;
  socketExists?: (path: string) => boolean;
  config?: () => { headless: boolean; autoXvfb: boolean };
  pollMs?: number;
  /** Pause between PerimeterX warm-up attempts (default 2s + 3s per attempt). */
  challengeDelayMs?: (attempt: number) => number;
}

export class BrowserTransport {
  private context: any = null;
  private launch: Promise<any> | null = null;
  private warmed = false;
  private xvfb: ChildProcess | null = null;
  private display: string | null = null;
  private page: any = null;

  constructor(private readonly deps: DisplayDeps = {}) {}

  /**
   * A headed browser is what gets past PerimeterX, but a server has no screen. On Linux
   * with no DISPLAY, start a private Xvfb and hand its DISPLAY to the browser process.
   * Everywhere else the browser uses the native display.
   */
  private async ensureDisplay(): Promise<string | undefined> {
    const cfg = (this.deps.config ?? getRegionConfig)();
    const plan = planDisplay({
      headless: cfg.headless,
      autoXvfb: cfg.autoXvfb,
      platform: this.deps.platform ?? process.platform,
      env: this.deps.env ?? process.env,
    });
    if (plan.kind === "none") return undefined;
    if (plan.kind === "existing") return plan.display;
    if (this.display) return this.display;

    const spawnXvfb = this.deps.spawn ?? spawn;
    const socketExists = this.deps.socketExists ?? existsSync;
    const pollMs = this.deps.pollMs ?? 250;
    for (const n of [99, 98, 97, 96, 95]) {
      const socket = `/tmp/.X11-unix/X${n}`;
      if (socketExists(socket)) continue;
      let failed = null as Error | null;
      let child: ChildProcess;
      try {
        child = spawnXvfb("Xvfb", [`:${n}`, "-screen", "0", "1440x900x24", "-nolisten", "tcp"], {
          stdio: "ignore",
        });
      } catch (err) {
        throw xvfbError(err);
      }
      // Without a listener, a failed spawn (ENOENT: Xvfb not installed) is an
      // unhandled 'error' event and takes the whole MCP server down.
      child.on("error", (err) => {
        failed = err;
        if (this.xvfb === child) {
          this.xvfb = null;
          this.display = null;
        }
      });
      child.on("exit", () => {
        if (this.xvfb === child) {
          this.xvfb = null;
          this.display = null;
        }
      });
      this.xvfb = child;

      for (let i = 0; i < 40; i++) {
        if (failed) break;
        if (socketExists(socket)) {
          this.display = `:${n}`;
          console.error(`foodpanda-mcp: started Xvfb on DISPLAY=${this.display}`);
          return this.display;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (this.xvfb === child) this.xvfb = null;
      if (failed) throw xvfbError(failed);
      child.kill();
    }
    throw xvfbError(null);
  }

  private async getBrowser(): Promise<BrowserLike> {
    try {
      const pw: any = await import("playwright-extra");
      const stealthModule: any = await import("puppeteer-extra-plugin-stealth");
      const StealthPlugin = stealthModule.default;
      pw.chromium.use(StealthPlugin());
      return pw.chromium as BrowserLike;
    } catch {
      throw new Error(
        "Playwright is not installed. Run: npm install playwright-extra puppeteer-extra-plugin-stealth && npx playwright install chromium"
      );
    }
  }

  /** Shared persistent context — reused by the login flow and by API calls. */
  async getContext(): Promise<any> {
    if (this.context) return this.context;
    if (this.launch) return this.launch;

    this.launch = (async () => {
      const cfg = getRegionConfig();
      const chromium = await this.getBrowser();
      mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
      const display = await this.ensureDisplay();
      try {
        const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
          headless: cfg.headless,
          ...(display ? { env: { ...process.env, DISPLAY: display } } : {}),
          ...(cfg.browserExecutable
            ? { executablePath: cfg.browserExecutable }
            : cfg.browserChannel
              ? { channel: cfg.browserChannel }
              : {}),
          ...(proxyOptions(cfg.proxy) ? { proxy: proxyOptions(cfg.proxy) } : {}),
          viewport: {
            width: 1280 + Math.floor(Math.random() * 140),
            height: 800 + Math.floor(Math.random() * 120),
          },
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
        this.context = ctx;
        return ctx;
      } catch (err) {
        throw new Error(
          `Failed to launch browser (run 'npx playwright install chromium'): ${(err as Error).message}`
        );
      } finally {
        this.launch = null;
      }
    })();

    return this.launch;
  }

  /**
   * Visit the storefront once so PerimeterX hands out its clearance cookie.
   * Subsequent API calls from this context inherit it.
   *
   * A challenge verdict is sticky: an unsolved visit leaves PX cookies that mark the
   * profile as suspicious, and every later launch from that profile is challenged again.
   * So a blocked attempt first drops only the PerimeterX cookies and retries; the login
   * cookies stay, so the user is not logged out. Only when that is still blocked is the
   * whole profile thrown away (the live run on 2026-10-13 saw one challenge per start, and
   * wiping the profile each time meant logging in again every hour).
   */
  async warmUp(attempts: number = 3): Promise<void> {
    if (this.warmed) return;
    const cfg = getRegionConfig();
    let lastTitle = "";

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ctx = await this.getContext();
      const page = ctx.pages()[0] || (await ctx.newPage());
      try {
        await page.goto(cfg.webHost, { waitUntil: "domcontentloaded", timeout: 60000 });
        // Let the PX sensor script run, then behave like a visitor rather than a crawler.
        await page.waitForTimeout(3500);
        await page.mouse.move(200 + Math.floor(Math.random() * 400), 200 + Math.floor(Math.random() * 200));
        await page.mouse.wheel(0, 400 + Math.floor(Math.random() * 400));
        await page.waitForTimeout(2500);

        lastTitle = await page.title().catch(() => "");
        if (!/denied|px-captcha/i.test(lastTitle)) {
          this.warmed = true;
          this.page = page; // keep it: requests are issued from this page's context
          return;
        }
      } finally {
        if (ctx.pages()[0] !== page && !ctx.pages().includes(page)) {
          await page.close().catch(() => {});
        }
      }

      console.error(
        `foodpanda-mcp: PerimeterX challenged ${cfg.webHost} (attempt ${attempt}/${attempts}, title: "${lastTitle}")`
      );
      if (attempt < attempts) {
        if (attempt < attempts - 1) {
          await this.clearChallenge();
        } else {
          console.error("foodpanda-mcp: still challenged; resetting the browser profile (this logs out)");
          await this.resetProfile();
        }
        const delay = this.deps.challengeDelayMs ?? ((n: number) => 2000 + n * 3000);
        await new Promise((r) => setTimeout(r, delay(attempt)));
      }
    }

    throw new Error(
      `PerimeterX rejected ${cfg.webHost} after ${attempts} attempts from a clean profile ` +
        `(last page title: "${lastTitle}"). The block is on this network/identity. ` +
        `Set FOODPANDA_PROXY to egress elsewhere, or run the server on a network foodpanda serves.`
    );
  }

  /**
   * Forget the PerimeterX verdict but keep the login: drop the PX cookies (named _px…,
   * like the _px3 clearance cookie) from the open context and warm up again next time.
   */
  async clearChallenge(): Promise<void> {
    this.warmed = false;
    if (!this.context) return;
    try {
      await this.context.clearCookies({ name: /^_px/ });
    } catch {
      // An older Playwright without filtered clearCookies: fall back to a clean profile.
      await this.resetProfile();
    }
  }

  /** Drop the browser profile (cookies, PX verdicts, cached identity) and close the context. */
  async resetProfile(): Promise<void> {
    await this.close();
    try {
      rmSync(PROFILE_DIR, { recursive: true, force: true });
    } catch {
      /* profile may be locked; the next launch recreates it */
    }
  }

  /**
   * Issue the request from inside the warm storefront page rather than from the context's
   * request API. Page-origin fetches carry Origin/Referer, sec-fetch-* and the cookies the
   * page itself acquired — which is what PerimeterX expects on the REST endpoints that it
   * rejects when asked by an out-of-page client.
   */
  async fetchViaPage(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<TransportResponse> {
    const cfg = getRegionConfig();
    const ctx = await this.getContext();
    let page = this.page || ctx.pages()[0] || (await ctx.newPage());
    this.page = page;

    const current = page.url();
    if (!current || current === "about:blank") {
      await page.goto(cfg.webHost, { waitUntil: "domcontentloaded", timeout: 60000 });
    }

    return page.evaluate(
      async (args: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
        const response = await fetch(args.url, {
          method: args.method,
          headers: args.headers,
          body: args.body,
          credentials: "include",
        });
        return {
          status: response.status,
          ok: response.ok,
          text: await response.text(),
        };
      },
      {
        url,
        method: init.method || "GET",
        headers: init.headers || {},
        body: init.body,
      }
    );
  }

  async fetch(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<TransportResponse> {
    const ctx = await this.getContext();
    const response = await ctx.request.fetch(url, {
      method: init.method || "GET",
      headers: init.headers || {},
      data: init.body,
      timeout: 60000,
      failOnStatusCode: false,
    });
    const text = await response.text();
    return { status: response.status(), ok: response.ok(), text };
  }

  async close(): Promise<void> {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.warmed = false;
    this.page = null;
    if (this.xvfb) {
      this.xvfb.kill();
      this.xvfb = null;
      this.display = null;
    }
  }
}

function xvfbError(cause: unknown): Error {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  const why = code === "ENOENT" ? "Xvfb is not installed" : cause ? String((cause as Error).message ?? cause) : "it did not come up";
  return new Error(
    `Could not start Xvfb (${why}). A headed browser is required to clear PerimeterX: ` +
      "install Xvfb (apt-get install xvfb), set DISPLAY to a running X server, or run on a desktop."
  );
}

let singleton: BrowserTransport | null = null;

export function browserTransport(): BrowserTransport {
  if (!singleton) singleton = new BrowserTransport();
  return singleton;
}
