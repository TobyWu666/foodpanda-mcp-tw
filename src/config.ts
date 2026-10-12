/**
 * Region configuration for the foodpanda MCP server.
 *
 * Upstream (johnwhoyou/foodpanda-mcp) hardcodes foodpanda.ph. This fork makes
 * the region a first-class, env-overridable setting so the same server can run
 * against foodpanda.com.tw (the default), foodpanda.hk or any other fd-api
 * country without editing sources.
 *
 * Every tw value below was read off traffic captured on www.foodpanda.com.tw
 * while logged in. Values the capture did not show are left unset, not guessed.
 */

import { homedir } from "os";
import { join } from "path";

/** Where the token file and the browser profile live (FOODPANDA_STATE_DIR, default ~/.foodpanda-mcp). */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  return env.FOODPANDA_STATE_DIR || join(homedir(), ".foodpanda-mcp");
}

export interface RegionConfig {
  /** fd-api host for the region, no trailing slash. */
  apiBase: string;
  /** Web storefront host, used for the browser login flow and payment redirects. */
  webHost: string;
  /** Locale sent to the REST + GraphQL APIs, e.g. en_HK. */
  locale: string;
  /**
   * foodpanda language id, sent as x-pd-language-id and in GraphQL variables.
   * null = not known for this region: the header and variable are left out.
   */
  languageId: number | null;
  /** x-global-entity-id header value, e.g. FP_TW. "" = not known for this region. */
  globalEntityId: string;
  /** ISO currency code for the basket, e.g. HKD. */
  currency: string;
  /** Display name used in tool descriptions and error messages. */
  countryLabel: string;
  /** Apollo persisted-query hashes. Region builds publish different hashes. */
  searchHash: string;
  vendorListHash: string;
  /**
   * Route API calls through a real browser context (carries PerimeterX cookies).
   * PerimeterX (the "Access to this page has been denied" wall) challenges plain
   * fetch() calls on fd-api; a browser context that has solved the challenge
   * sends a valid _px3 cookie and is allowed through.
   */
  browserTransport: boolean;
  /** Run the transport/login browser headless (server use) or headed (desktop use). */
  headless: boolean;
  /**
   * Chromium build to drive. "chromium" = the full build (new headless mode), which
   * avoids Playwright's separate chromium-headless-shell download; set to "" to let
   * Playwright pick (headless then needs the headless-shell build).
   */
  browserChannel: string;
  /**
   * Explicit browser binary to drive (system Chrome/Chromium or an already-installed
   * Playwright build). When set, it wins over browserChannel and Playwright skips its
   * own revision checks.
   */
  browserExecutable: string;
  /**
   * Proxy for the browser (and therefore for every API call, since API calls run through
   * the browser context). Accepts Playwright proxy syntax: http://host:port,
   * socks5://host:port, or http://user:pass@host:port. Use this to egress through a
   * network foodpanda serves when the machine running the server is blocked.
   */
  proxy: string;
  /**
   * Start a private Xvfb when a headed browser is needed and DISPLAY is unset.
   * A headed browser is what clears PerimeterX; a server has no screen.
   */
  autoXvfb: boolean;
}

/**
 * Known-good hashes from the upstream PH build. They are kept only as a
 * bootstrap default: a HK build almost certainly publishes different hashes.
 * Harvest them with `node scripts/discover-hashes.mjs` from a network location
 * that foodpanda serves (see README-HK.md) and set FOODPANDA_GQL_SEARCH_HASH /
 * FOODPANDA_GQL_VENDOR_LIST_HASH.
 */
const PH_SEARCH_HASH =
  "6d4dea2e0c8ab03c0d2934ca3db20b8914fc17e4109fb103307e4c077ba8506d";
const PH_VENDOR_LIST_HASH =
  "ee02950ba8ef08427ef979e3954e3c1367c5636b18d6fc8a850ebf5fbf49d999";

const PRESETS: Record<string, Partial<RegionConfig>> = {
  tw: {
    apiBase: "https://tw.fd-api.com",
    webHost: "https://www.foodpanda.com.tw",
    locale: "zh_TW",
    currency: "TWD",
    globalEntityId: "FP_TW",
    countryLabel: "foodpanda Taiwan",
  },
  hk: {
    apiBase: "https://hk.fd-api.com",
    webHost: "https://www.foodpanda.hk",
    locale: "en_HK",
    languageId: 1,
    currency: "HKD",
    countryLabel: "foodpanda Hong Kong",
  },
  ph: {
    apiBase: "https://ph.fd-api.com",
    webHost: "https://www.foodpanda.ph",
    locale: "en_PH",
    languageId: 1,
    currency: "PHP",
    globalEntityId: "FP_PH",
    countryLabel: "foodpanda Philippines",
    searchHash: PH_SEARCH_HASH,
    vendorListHash: PH_VENDOR_LIST_HASH,
  },
};

type Env = Record<string, string | undefined>;

function envFlag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const DEFAULT_COUNTRY = "tw";

export function loadRegionConfig(env: Env = process.env): RegionConfig {
  const country = (env.FOODPANDA_COUNTRY || DEFAULT_COUNTRY).trim().toLowerCase();
  const preset = PRESETS[country];

  if (!preset) {
    throw new Error(
      `Unknown FOODPANDA_COUNTRY='${country}'. Known presets: ${Object.keys(PRESETS).join(", ")}. ` +
        `For another country set FOODPANDA_API_BASE / FOODPANDA_WEB_HOST / FOODPANDA_LOCALE / FOODPANDA_CURRENCY explicitly.`
    );
  }

  const apiBase = (env.FOODPANDA_API_BASE || preset.apiBase || "").replace(/\/+$/, "");
  const webHost = (env.FOODPANDA_WEB_HOST || preset.webHost || "").replace(/\/+$/, "");

  if (!apiBase || !webHost) {
    throw new Error(
      "Region endpoints are not fully configured: set FOODPANDA_API_BASE and FOODPANDA_WEB_HOST for this country."
    );
  }

  const rawLanguageId = env.FOODPANDA_LANGUAGE_ID?.trim();
  let languageId: number | null = preset.languageId ?? null;
  if (rawLanguageId) {
    languageId = parseInt(rawLanguageId, 10);
    if (!Number.isFinite(languageId)) {
      throw new Error(`FOODPANDA_LANGUAGE_ID must be an integer, got '${rawLanguageId}'.`);
    }
  }

  return {
    apiBase,
    webHost,
    locale: env.FOODPANDA_LOCALE || preset.locale || "en_PH",
    languageId,
    globalEntityId: (env.FOODPANDA_GLOBAL_ENTITY_ID || preset.globalEntityId || "").trim(),
    currency: env.FOODPANDA_CURRENCY || preset.currency || "PHP",
    countryLabel: preset.countryLabel || country.toUpperCase(),
    searchHash: env.FOODPANDA_GQL_SEARCH_HASH || preset.searchHash || "",
    vendorListHash: env.FOODPANDA_GQL_VENDOR_LIST_HASH || preset.vendorListHash || "",
    browserTransport: envFlag(env, "FOODPANDA_BROWSER_TRANSPORT", true),
    headless: envFlag(env, "FOODPANDA_HEADLESS", true),
    browserChannel:
      env.FOODPANDA_BROWSER_CHANNEL === undefined
        ? "chromium"
        : env.FOODPANDA_BROWSER_CHANNEL.trim(),
    browserExecutable: (env.FOODPANDA_BROWSER_EXECUTABLE || "").trim(),
    proxy: (env.FOODPANDA_PROXY || "").trim(),
    autoXvfb: envFlag(env, "FOODPANDA_XVFB", true),
  };
}

let cached: RegionConfig | null = null;

export function getRegionConfig(): RegionConfig {
  if (!cached) cached = loadRegionConfig();
  return cached;
}

/** Persisted-query hash resolution with an explicit failure mode. */
export function requireHash(kind: "search" | "vendor_list"): string {
  const cfg = getRegionConfig();
  const hash = kind === "search" ? cfg.searchHash : cfg.vendorListHash;
  if (!hash) {
    throw new Error(
      `No Apollo persisted-query hash configured for ${kind} in ${cfg.countryLabel}. ` +
        `Harvest it with 'node scripts/discover-hashes.mjs' and set ` +
        `${kind === "search" ? "FOODPANDA_GQL_SEARCH_HASH" : "FOODPANDA_GQL_VENDOR_LIST_HASH"}.`
    );
  }
  return hash;
}
