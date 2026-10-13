import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { getRegionConfig, stateDir } from "./config.js";
import { browserTransport } from "./browser-transport.js";
import { persistedTokenProblem, type PersistedToken } from "./token-check.js";

const TOKEN_DIR = stateDir();
const TOKEN_FILE = join(TOKEN_DIR, "token.json");
const BROWSER_DATA_DIR = join(TOKEN_DIR, "browser-data");

/**
 * The saved token, if it belongs to this region and has not expired.
 * A rejected file is left on disk (the next login overwrites it) and the reason is logged.
 */
export function loadPersistedToken(): string | null {
  try {
    if (!existsSync(TOKEN_FILE)) return null;
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8")) as PersistedToken;
    const problem = persistedTokenProblem(data, getRegionConfig().apiBase);
    if (problem) {
      console.error(`foodpanda-mcp: ignoring saved token (${problem}); log in again with refresh_token`);
      return null;
    }
    return data.token;
  } catch {
    return null;
  }
}

export function persistToken(token: string): void {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const cfg = getRegionConfig();
  const data: PersistedToken = {
    token,
    savedAt: new Date().toISOString(),
    region: cfg.apiBase,
  };
  writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

export function browserProfileDir(): string {
  mkdirSync(BROWSER_DATA_DIR, { recursive: true, mode: 0o700 });
  return BROWSER_DATA_DIR;
}

/**
 * Open the regional storefront in the SHARED persistent browser context and
 * intercept the Bearer token the web app sends to the regional fd-api host.
 *
 * Reusing the shared context matters: that context is also the one the API
 * transport uses, so it already holds the PerimeterX clearance cookie plus the
 * login cookies after the user authenticates.
 */
export async function refreshTokenViaBrowser(
  timeoutSeconds: number = 300
): Promise<string> {
  const cfg = getRegionConfig();
  const apiHost = new URL(cfg.apiBase).host;

  // A headless browser has no window to log in through: the call would just time out.
  if (cfg.headless) {
    throw new Error(
      "Logging in needs a visible browser window, but FOODPANDA_HEADLESS is on. " +
        "Remove FOODPANDA_HEADLESS (or set it to 0) in this MCP server's env and restart it, then call refresh_token again."
    );
  }

  const context = await browserTransport().getContext();
  const page = context.pages()[0] || (await context.newPage());

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `Login timed out after ${timeoutSeconds} seconds. Please try again.`
          )
        );
      }, timeoutSeconds * 1000);

      page.on("request", (request: any) => {
        const url = request.url();
        if (!url.includes(apiHost)) return;

        const authHeader = request.headers()["authorization"];
        if (!authHeader || !authHeader.startsWith("Bearer ")) return;

        const token = authHeader.slice("Bearer ".length).trim();
        if (token.length === 0) return;

        // Validate JWT structure (header.payload.signature)
        if (token.split(".").length !== 3) return;

        clearTimeout(timer);
        resolve(token);
      });

      page.goto(cfg.webHost).catch((err: Error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to navigate to ${cfg.webHost}: ${err.message}`));
      });
    });
  } finally {
    if (context.pages()[0] !== page) await page.close().catch(() => {});
  }
}