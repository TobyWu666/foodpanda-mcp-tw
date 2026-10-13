#!/usr/bin/env node
/**
 * Live check of the foodpanda Taiwan MCP server, up to prepare_order. NEVER orders.
 *
 * Run from the repo checkout (main, after `npm install && npm run build`):
 *   FOODPANDA_LATITUDE=… FOODPANDA_LONGITUDE=… node /path/to/live-check.mjs [options]
 *
 * Options:
 *   --login             open the browser to log in first (refresh_token)
 *   --query 麥當勞       search text (default 麥當勞)
 *   --vendor CODE       use this restaurant instead of the first open result
 *   --item CODE         use this menu item instead of the first simple one
 *   --payment cash      cash (default) or linepay
 *   --address ID        saved address id (needed if the account has several)
 *
 * It starts the server (build/index.js) as an MCP client would, calls the tools in
 * order, and refuses to call place_order under any circumstances. At the end it
 * empties the cart again. Output stays in this terminal only.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
if (!existsSync(join(repo, "build", "index.js"))) {
  console.error("Run this from the repo folder after `npm run build` (build/index.js not found).");
  process.exit(2);
}
const req = createRequire(join(repo, "package.json"));
const load = async (spec) => import(pathToFileURL(req.resolve(spec)).href);
const { Client } = await load("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await load("@modelcontextprotocol/sdk/client/stdio.js");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const query = opt("query", "麥當勞");
const payment = opt("payment", "cash");
const addressId = opt("address");
if (!["cash", "linepay"].includes(payment)) {
  console.error("--payment must be cash or linepay");
  process.exit(2);
}
if (!process.env.FOODPANDA_LATITUDE || !process.env.FOODPANDA_LONGITUDE) {
  console.error("Set FOODPANDA_LATITUDE and FOODPANDA_LONGITUDE (your delivery location).");
  process.exit(2);
}

// ---- Output masking: this output may be pasted somewhere, so no address, phone or coordinates. ----
const ADDRESS_KEYS = /^(address|formatted_customer_address|formatted_address|address_line\d|label|title|text|street|building|floor|room|postcode|city|district|delivery_instructions)$/i;
const DROP_KEYS = /^(latitude|longitude|lat|lng|phone|phone_number|mobile_number|mobile|email|first_name|last_name|name_on_card)$/i;

/** First few characters, then ***: enough to recognise your own address, not to find it. */
function fragment(value) {
  const s = String(value ?? "");
  if (!s) return s;
  return `${[...s].slice(0, 3).join("")}***`;
}

function maskJson(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => maskJson(v, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.test(k)) out[k] = "***";
      else if (key === "delivery_address" && ADDRESS_KEYS.test(k) && typeof v === "string") out[k] = fragment(v);
      else if (/address/i.test(k) && typeof v === "string") out[k] = fragment(v);
      else out[k] = maskJson(v, k);
    }
    return out;
  }
  return value;
}

/** Mask a tool's text output, JSON or not. */
function scrub(text) {
  let out = text;
  const json = safeJson(text);
  if (json !== null && typeof json === "object") out = JSON.stringify(maskJson(json), null, 2);
  // "- address_id 123: label, full address" lines from prepare_order's address list
  out = out.replace(/^(- address_id \d+: )(.*)$/gm, (_, head, rest) => head + fragment(rest));
  // Taiwanese phone numbers, emails and anything that looks like a coordinate
  out = out.replace(/(?:\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, "***");
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "***");
  out = out.replace(/-?\b\d{2,3}\.\d{4,}\b/g, "***");
  return out;
}

console.log(
  "NOTE: do not post this output publicly. Addresses are masked, but the nearby restaurants still reveal your area.\n"
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repo, "build", "index.js")],
  env: { ...process.env, FOODPANDA_HEADLESS: flag("login") ? "0" : process.env.FOODPANDA_HEADLESS ?? "1" },
  stderr: "inherit",
});
const client = new Client({ name: "live-check", version: "1" });
await client.connect(transport);

const results = [];
async function call(name, input = {}) {
  if (name === "place_order") throw new Error("live-check never calls place_order");
  const started = Date.now();
  const res = await client.callTool({ name, arguments: input });
  const text = res.content?.[0]?.text ?? "";
  const ok = !res.isError;
  results.push({ step: name, ok, seconds: ((Date.now() - started) / 1000).toFixed(1) });
  console.log(`\n=== ${name} ${ok ? "OK" : "ERROR"} (${results.at(-1).seconds}s)`);
  return { ok, text, json: ok ? safeJson(text) : null };
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function stop(message) {
  console.log(`\nStopped: ${message}`);
  return finish(1);
}
async function finish(code) {
  try {
    const cart = await client.callTool({ name: "get_cart", arguments: {} });
    const items = safeJson(cart.content?.[0]?.text ?? "")?.items ?? [];
    for (const item of items) {
      await client.callTool({ name: "remove_from_cart", arguments: { cart_item_id: item.cart_item_id } });
    }
  } catch {}
  console.log("\nSummary (no order was placed):");
  for (const r of results) console.log(`  ${r.ok ? "OK   " : "ERROR"} ${r.step} (${r.seconds}s)`);
  await client.close();
  process.exit(code);
}

// The order tools must be the two-step ones.
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log("Tools:", tools.join(", "));
if (!tools.includes("prepare_order") || tools.includes("preview_order")) {
  await stop("this build does not have the two-step order tools; check the branch.");
}

if (flag("login")) {
  const login = await call("refresh_token", { timeout: 300 });
  console.log(scrub(login.text));
  if (!login.ok) await stop("login failed.");
}

// 1. Search
const search = await call("search_restaurants", { query, limit: 5 });
if (!search.ok) {
  console.log(scrub(search.text));
  await stop("search failed.");
}
const found = Array.isArray(search.json) ? search.json : search.json?.restaurants ?? [];
for (const r of found) console.log(`  ${r.id}  ${r.name}${r.chain_name ? `  (chain ${r.chain_code}, ${r.total_outlets} outlets)` : ""}`);
const vendor = opt("vendor", found[0]?.id);
if (!vendor) await stop("no restaurant found.");

// 2. Details and menu
const details = await call("get_restaurant_details", { restaurant_id: vendor });
console.log(details.ok ? `  ${details.json?.name}: open=${details.json?.is_open} delivery=${details.json?.is_delivery_available}` : scrub(details.text));
const menu = await call("get_menu", { restaurant_id: vendor });
if (!menu.ok) {
  console.log(scrub(menu.text));
  await stop("menu failed.");
}
const items = (menu.json ?? []).flatMap((c) => c.items);
console.log(`  ${menu.json?.length ?? 0} categories, ${items.length} items`);
const wanted = opt("item");
const item =
  (wanted && items.find((i) => i.code === wanted)) ||
  items.find((i) => !i.is_sold_out && !i.has_options && i.price > 0) ||
  items.find((i) => !i.is_sold_out);
if (!item) await stop("no orderable item.");
console.log(`  using item ${item.code}  ${item.name}  ${item.price}`);

// 3. Options, if any: the first available choice of every required group
let toppingIds = [];
if (item.has_options) {
  const det = await call("get_item_details", { restaurant_id: vendor, item_code: item.code });
  if (!det.ok) {
    console.log(scrub(det.text));
    await stop("item details failed.");
  }
  for (const g of det.json?.topping_groups ?? det.json?.item?.topping_groups ?? []) {
    console.log(`  group ${g.id} ${g.name} (min ${g.quantity_minimum}, max ${g.quantity_maximum})${g.unsupported ? " UNSUPPORTED" : ""}`);
    if (g.quantity_minimum > 0) {
      const choice = g.options.find((o) => !o.is_sold_out);
      if (choice) toppingIds.push(String(choice.id));
    }
  }
}

// 4. Cart validation (no order)
const add = await call("add_to_cart", {
  restaurant_id: vendor,
  items: [{ item_id: item.code, quantity: 1, ...(toppingIds.length ? { topping_ids: toppingIds } : {}) }],
});
console.log(scrub(add.text));
if (!add.ok) await stop("cart validation failed.");

// 5. Payment methods
const methods = await call("list_payment_methods");
console.log(scrub(methods.text));

// 6. prepare_order: shows the whole order and a code. The code is NOT used.
const prepare = await call("prepare_order", {
  payment_method: payment,
  ...(addressId ? { address_id: Number(addressId) } : {}),
});
console.log(scrub(prepare.text));
if (prepare.ok) console.log("\n(The confirmation code above is not used. place_order is never called.)");

await finish(results.every((r) => r.ok) ? 0 : 1);
