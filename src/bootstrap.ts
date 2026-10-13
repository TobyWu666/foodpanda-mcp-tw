/**
 * Shared start-up for both entry points (stdio in index.ts, HTTP in http-server.ts):
 * read the region and location from the environment, log what is configured, load
 * the saved login, and build the client.
 */

import { FoodpandaClient, type FoodpandaClientOptions } from "./foodpanda-client.js";
import { loadPersistedToken } from "./token-manager.js";
import { getRegionConfig } from "./config.js";
import { tokenProblem } from "./token-check.js";

export function createClientFromEnv(options: Pick<FoodpandaClientOptions, "confirmSend" | "reportOutcome"> = {}): FoodpandaClient {
  // Region (endpoints, locale, currency, GraphQL hashes) — FOODPANDA_COUNTRY=tw by default.
  const cfg = getRegionConfig();

  function envToken(): string | null {
    const token = (process.env.FOODPANDA_SESSION_TOKEN || "").trim();
    if (!token) return null;
    const problem = tokenProblem(token);
    if (problem) {
      console.error(`foodpanda-mcp: ignoring FOODPANDA_SESSION_TOKEN (${problem})`);
      return null;
    }
    return token;
  }

  // Token loading priority: persisted file (same region, not expired) > env var > null (tokenless startup)
  const sessionToken = loadPersistedToken() || envToken();

  const latitude = parseFloat(process.env.FOODPANDA_LATITUDE || "");
  const longitude = parseFloat(process.env.FOODPANDA_LONGITUDE || "");

  if (isNaN(latitude) || isNaN(longitude)) {
    console.error(
      "Error: FOODPANDA_LATITUDE and FOODPANDA_LONGITUDE environment variables are required.\n" +
        "These should be the coordinates of your delivery address.\n" +
        "Example: FOODPANDA_LATITUDE=25.0330 FOODPANDA_LONGITUDE=121.5654"
    );
    process.exit(1);
  }

  console.error(
    `foodpanda-mcp: region=${cfg.countryLabel} api=${cfg.apiBase} web=${cfg.webHost} ` +
      `locale=${cfg.locale} currency=${cfg.currency} entity=${cfg.globalEntityId || "(unset)"} ` +
      `language_id=${cfg.languageId ?? "(unset)"} transport=${cfg.browserTransport ? "browser" : "fetch"}`
  );

  const missing: string[] = [];
  if (!cfg.searchHash) missing.push("FOODPANDA_GQL_SEARCH_HASH (search_restaurants)");
  if (!cfg.vendorListHash) missing.push("FOODPANDA_GQL_VENDOR_LIST_HASH (list_outlets)");
  if (missing.length > 0) {
    console.error(
      `foodpanda-mcp: note — not set: ${missing.join(", ")}.\n` +
        "  Those Apollo persisted-query hashes are needed before the matching tool works.\n" +
        "  Harvest them from a browser that clears PerimeterX:\n" +
        "  FOODPANDA_HEADLESS=0 node scripts/discover-hashes.mjs"
    );
  }

  if (sessionToken) {
    console.error("foodpanda-mcp: loaded session token");
  } else {
    console.error(
      "foodpanda-mcp: no session token — browsing works (search, menus, details); " +
        "cart and checkout need a login via the refresh_token tool."
    );
  }

  return new FoodpandaClient(sessionToken, latitude, longitude, options);
}
