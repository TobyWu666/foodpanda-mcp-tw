#!/usr/bin/env node
/**
 * Harvest the Apollo persisted-query hashes used by the regional foodpanda web app.
 *
 * Why: `search_restaurants` and `list_outlets` send an Apollo "persisted query" (a sha256
 * hash) instead of a full GraphQL document. Those hashes are compiled into each regional web
 * build, so upstream's PH hashes mean nothing to foodpanda.hk — the API answers
 * `PersistedQueryNotFound`.
 *
 * How: open the storefront through the same browser transport the MCP server uses, so this
 * script inherits the Xvfb-backed headed browser, the PerimeterX warm-up (with profile reset
 * on a challenge) and the proxy if one is configured — then read the hashes straight off the
 * app's own /graphql requests.
 *
 * Usage — build first, then:
 *   FOODPANDA_HEADLESS=0 node scripts/discover-hashes.mjs
 *
 * The script runs a search itself. While it waits, open a chain's branch list, a restaurant
 * and one item with options in the browser window, so those queries fire too.
 *
 * Exits non-zero if nothing was captured. Results are also written to
 * $FOODPANDA_STATE_DIR/gql-hashes.json.
 */

import { mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const { browserTransport } = await import("../build/browser-transport.js");
const { getRegionConfig } = await import("../build/config.js");

const cfg = getRegionConfig();
const STATE_DIR = process.env.FOODPANDA_STATE_DIR || join(homedir(), ".foodpanda-mcp");
const OUT_FILE = join(STATE_DIR, "gql-hashes.json");

/**
 * Which tool each persisted query belongs to. The tw web app names its operations (in the body,
 * or only in the x-apollo-operation-name header for RestaurantProductQuery); a marker in the
 * variables tells the chain listing apart from other GetVendorListPage calls.
 */
const SIGNATURES = [
  { kind: "search", operation: "SearchResults" },
  { kind: "vendor_list", operation: "GetVendorListPage", marker: "CHAIN_LISTING_PAGE" },
  { kind: "restaurant_details", operation: "GetRestaurantDetailsPage" },
  { kind: "product", operation: "RestaurantProductQuery" },
  // Builds without operation names (upstream PH/HK) are recognised by their variables.
  { kind: "search", marker: "searchResultsParams" },
];

const found = new Map();
const seen = new Map();

function record(postData, headerOperation) {
  let body;
  try {
    body = JSON.parse(postData || "{}");
  } catch {
    return;
  }
  const hash = body?.extensions?.persistedQuery?.sha256Hash;
  if (!hash) return;
  const operation = body.operationName || headerOperation || "";
  const variables = JSON.stringify(body.variables ?? {});
  if (!seen.has(hash)) seen.set(hash, `${operation} ${variables.slice(0, 160)}`);
  for (const sig of SIGNATURES) {
    if (found.has(sig.kind)) continue;
    if (sig.operation && sig.operation !== operation) continue;
    if (sig.marker && !variables.includes(sig.marker)) continue;
    found.set(sig.kind, hash);
  }
}

const transport = browserTransport();
await transport.resetProfile();

const context = await transport.getContext();
const page = context.pages()[0] || (await context.newPage());
page.on("request", (request) => {
  if (request.method() === "POST" && request.url().includes("/graphql")) {
    record(request.postData(), request.headers()["x-apollo-operation-name"]);
  }
});

console.error(`Opening ${cfg.webHost} ...`);
try {
  await transport.warmUp(3);
  console.error("PerimeterX cleared.");
} catch (err) {
  console.error(`\nCould not get past PerimeterX: ${err.message.split("\n")[0]}`);
  console.error(
    "A headed browser is required (PerimeterX blocks headless ones). Set FOODPANDA_HEADLESS=0;\n" +
      "the transport starts its own Xvfb, so Xvfb must be installed."
  );
  await transport.close().catch(() => {});
  process.exit(2);
}

// Drive the on-page search so the app issues its search query. No extra navigation:
// a second document load can be challenged again.
await page.waitForTimeout(3000);
try {
  const field = (await page.$('input[type="search"]')) || (await page.$("[role=searchbox]"));
  if (field) {
    await field.click();
    await field.type(process.env.FOODPANDA_DISCOVER_QUERY || "麥當勞", { delay: 90 });
    await page.waitForTimeout(2000);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(8000);
    console.error("Now open a chain's branch list, a restaurant and an item with options (60 s) ...");
    await page.waitForTimeout(60000);
  } else {
    console.error("(no search field found — search manually on the page while this runs)");
  }
} catch (err) {
  console.error(`(could not drive the search field: ${String(err).split("\n")[0]})`);
}

mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
writeFileSync(OUT_FILE, JSON.stringify(Object.fromEntries(found), null, 2), { mode: 0o600 });

console.error(`\nWrote ${OUT_FILE}`);
if (seen.size > 0) {
  console.error("All persisted queries seen (hash -> variables):");
  for (const [hash, vars] of seen) console.error(`  ${hash}\n    ${vars}`);
}

const ENV_NAMES = {
  search: "FOODPANDA_GQL_SEARCH_HASH",
  vendor_list: "FOODPANDA_GQL_VENDOR_LIST_HASH",
  restaurant_details: "FOODPANDA_GQL_RESTAURANT_DETAILS_HASH",
  product: "FOODPANDA_GQL_PRODUCT_HASH",
};
for (const [kind, env] of Object.entries(ENV_NAMES)) {
  const hash = found.get(kind);
  if (hash) console.log(`${env}=${hash}`);
  else console.error(`(not seen: ${kind} — open the matching page in the browser and re-run)`);
}

await transport.close();
process.exit(search ? 0 : 1);