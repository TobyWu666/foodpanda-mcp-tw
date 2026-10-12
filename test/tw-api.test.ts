// Fixtures are trimmed, masked copies of traffic captured on www.foodpanda.com.tw
// (scripts/mask-capture.mjs --check passes on every one; vendor names are replaced).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCalculateRequest,
  buildCartProduct,
  chainOutletsOperation,
  parseCalculate,
  parseChainOutlets,
  parseProductChoices,
  parseRestaurantPage,
  parseSearchResults,
  productOperation,
  restaurantDetailsOperation,
  searchOperation,
  selectChoices,
} from "../src/tw-api.js";
import type { CartProductPayload } from "../src/types.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", name), "utf-8"));

const search = fixture("tw-search.masked.json");
const outlets = fixture("tw-chain-outlets.masked.json");
const details = fixture("tw-restaurant-details.masked.json");
const product = fixture("tw-product.masked.json");
const cart = fixture("tw-cart-calculate.masked.json");

const where = { latitude: 25.033964, longitude: 121.564468, locale: "zh_TW", languageId: 6 };

/** The captured body without what the web app adds and we leave out on purpose. */
function captured(req: any): any {
  const copy = structuredClone(req);
  delete copy.extensions.clientLibrary;
  return copy;
}

// ---- request bodies match what the tw web app sends ----

test("search request matches the captured SearchResults call", () => {
  const req = search.request;
  const op = searchOperation(req.extensions.persistedQuery.sha256Hash, "麥當勞", where);
  assert.equal(op.name, "SearchResults");
  assert.equal(op.displayContext, "SEARCH");
  assert.deepEqual(op.body, captured(req));
});

test("chain outlets request matches the captured call, minus the web app's A/B feature flags", () => {
  const req = captured(outlets.request);
  delete req.variables.input.featureFlags;
  const op = chainOutletsOperation(req.extensions.persistedQuery.sha256Hash, "co4jt", where);
  assert.equal(op.displayContext, "RLP");
  assert.deepEqual(op.body, req);
});

test("restaurant details request matches the captured call", () => {
  const req = details.request;
  const op = restaurantDetailsOperation(req.extensions.persistedQuery.sha256Hash, "b6wb");
  assert.equal(op.displayContext, "RESTAURANT_DETAIL_PAGE");
  assert.deepEqual(op.body, captured(req));
});

test("product request matches the captured call (no operationName in the body)", () => {
  const req = product.request;
  const op = productOperation(req.extensions.persistedQuery.sha256Hash, "b6wb", 157379049, "388886");
  assert.equal(op.name, "RestaurantProductQuery");
  assert.equal(op.displayContext, "ITEM_MODIFIER");
  assert.deepEqual(op.body, req);
});

// ---- responses ----

test("search results: chain data is read from inside vendorData", () => {
  const rs = parseSearchResults(search.response);
  assert.equal(rs.length, 3);
  const r = rs[0];
  assert.equal(r.id, "b2wy");
  assert.equal(r.chain_code, "co4jt");
  assert.equal(r.chain_name, "McDonald's 麥當勞");
  assert.equal(r.total_outlets, 6);
  assert.deepEqual(r.cuisine, ["歐美"]);
  assert.equal(r.delivery_fee, 29);
  assert.equal(r.minimum_order, 79);
  assert.equal(r.delivery_time, "20-30 min");
  assert.equal(r.rating, 4.8);
  assert.equal(r.is_open, true);
  assert.equal(r.distance_km, 1); // masked to 1000 m in the fixture
});

test("chain outlets parse", () => {
  const rs = parseChainOutlets(outlets.response);
  assert.equal(rs.length, 2);
  assert.ok(rs.every((r) => r.chain_code === "co4jt"));
});

test("restaurant page gives details, menu, menu id and the vendor location", () => {
  const page = parseRestaurantPage(details.response);
  assert.equal(page.menuId, "388886");
  assert.equal(page.details.id, "b6wb");
  assert.equal(page.details.is_open, true);
  assert.equal(page.details.is_delivery_available, true);
  assert.deepEqual(page.details.cuisine, ["漢堡", "歐美"]);
  assert.equal(page.details.delivery_fee, 69);
  assert.deepEqual(page.details.opening_hours[0], {
    weekday: 1, opening_type: "delivery", opening_time: "05:00", closing_time: "10:15",
  });
  const meal = page.categories.flatMap((c) => c.items).find((i) => i.id === 157379049);
  assert.ok(meal);
  assert.equal(meal.code, "2|33978%68877");
  assert.equal(meal.price, 255);
  assert.equal(meal.variation.id, 160594762);
  assert.equal(meal.is_customizable, true);
  assert.ok(page.categories.flatMap((c) => c.items).some((i) => i.is_customizable === false));
});

test("product choices: groups with min/max and priced options", () => {
  const groups = parseProductChoices(product.response, 160594762);
  assert.equal(groups.length, 8);
  assert.equal(groups[0].name, "配餐選擇 Side Order");
  assert.equal(groups[0].quantity_minimum, 1);
  assert.equal(groups[0].quantity_maximum, 1);
  const yuzu = groups[2].options.find((o) => o.id === 416083287);
  assert.equal(yuzu?.price, 20);
  assert.throws(() => parseProductChoices(product.response, 1), /not offered/);
});

// ---- cart lines ----

const MEAL_CHOICES = [416083281, 416083284, 416083287, 416083311, 416083314, 416083316];

function mealLine(): CartProductPayload {
  const page = parseRestaurantPage(details.response);
  const meal = page.categories.flatMap((c) => c.items).find((i) => i.id === 157379049)!;
  const groups = parseProductChoices(product.response, meal.variation.id);
  const choices = selectChoices(meal.name, groups, MEAL_CHOICES);
  return buildCartProduct(meal, meal.variation, choices, 1, "");
}

test("a meal with options builds exactly the cart line the web app sent", () => {
  const sent = cart.request.products.find((p: any) => p.id === 157379049);
  assert.deepEqual(mealLine(), sent);
  assert.equal(mealLine().price, 275); // 255 + 20 for the drink
});

test("a missing required choice is rejected with the allowed options", () => {
  const groups = parseProductChoices(product.response, 160594762);
  assert.throws(
    () => selectChoices("套餐", groups, MEAL_CHOICES.filter((id) => id !== 416083287)),
    /needs 1 choice\(s\) from "飲料 Drink".*416083287/
  );
});

test("too many choices in one group, or an unknown id, are rejected", () => {
  const groups = parseProductChoices(product.response, 160594762);
  assert.throws(() => selectChoices("套餐", groups, [...MEAL_CHOICES, 416083288]), /at most 1/);
  assert.throws(() => selectChoices("套餐", groups, [...MEAL_CHOICES, 999]), /not an option/);
});

test("optional groups may be left empty", () => {
  const groups = parseProductChoices(product.response, 160594762);
  // Without the ketchup (group min 0)
  const picked = selectChoices("套餐", groups, MEAL_CHOICES.filter((id) => id !== 416083316));
  assert.equal(picked.length, 5);
});

// ---- cart/calculate ----

test("calculate request matches the captured one, apart from the saved address", () => {
  const sent = structuredClone(cart.request);
  delete sent.expedition.delivery_address; // added with the locked address in stage 4
  const body = buildCalculateRequest(sent.products, sent.vendor, 25.033964, 121.564468);
  assert.deepEqual(JSON.parse(JSON.stringify(body)), sent);
});

test("calculate response gives the totals and per-line prices", () => {
  const sent: CartProductPayload[] = cart.request.products;
  const calc = parseCalculate(cart.response, sent);
  assert.equal(calc.subtotal, 278);
  assert.equal(calc.deliveryFee, 69);
  assert.equal(calc.serviceFee, 19);
  assert.equal(calc.total, 366);
  assert.deepEqual(calc.lines.map((l) => l.unitPrice), [3, 275]);
  assert.ok(calc.lines.every((l) => l.isAvailable));
});

test("a line missing from the response is reported unavailable", () => {
  const sent: CartProductPayload[] = [...cart.request.products, { ...mealLine(), id: 1, variation_id: 1 }];
  const calc = parseCalculate(cart.response, sent);
  assert.equal(calc.lines[2].isAvailable, false);
});
