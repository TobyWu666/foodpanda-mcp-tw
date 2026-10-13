/**
 * What an approval hub in front of this server relies on (mcp-check's foodpanda_tw
 * adapter, github.com/TobyWu666/mcp-check, server/src/adapters/foodpanda-tw.ts):
 * the prepare_order fields it shows on the phone and compares before sending, the
 * place_order success field, and whether a place_order error means "nothing was
 * sent" or "maybe ordered". Changing any of these breaks that hub.
 *
 * foodpanda is replaced by a fake; nothing reaches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { FoodpandaClient, type HttpFunction } from "../src/foodpanda-client.js";
import { CHECKOUT_MAYBE_SENT, CHECKOUT_NOT_SENT } from "../src/place-order-failure.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", name), "utf-8"));

const details = fixture("tw-restaurant-details.masked.json");
const product = fixture("tw-product.masked.json");
const cart = fixture("tw-cart-calculate.masked.json");
const selection = fixture("tw-payment-selection.masked.json");
const intent = fixture("tw-purchase-intent.masked.json");
const customer = fixture("tw-customer.masked.json");
const addresses = fixture("tw-addresses.masked.json");

const MEAL = "157379049";
const MEAL_CHOICES = ["416083281", "416083284", "416083287", "416083311", "416083314", "416083316"];

/** mcp-check's test for "refused before anything was sent" (isPreSendRefusal), copied as-is. */
function hubReadsAsNotSent(text: string): boolean {
  if (/status is unknown/i.test(text)) return false;
  return /confirmation code|ORDER_CONFIRMATION_INVALID|changed since prepare_order|Call prepare_order again/i.test(text);
}

function fakeFoodpanda() {
  const state = {
    total: 366,
    intentFail: false,
    checkout: (): { status: number; text: string } => ({
      status: 200,
      text: JSON.stringify({ id: "fake-order-1", payment: { result: "success", action: null } }),
    }),
  };
  let checkouts = 0;
  const http: HttpFunction = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (value: unknown) => ({ status: 200, ok: true, text: JSON.stringify(value) });
    if (u.pathname === "/graphql") {
      const op = init.headers?.["x-apollo-operation-name"];
      if (op === "GetRestaurantDetailsPage") return ok(details.response);
      if (op === "RestaurantProductQuery") return ok(product.response);
      throw new Error(`unexpected GraphQL ${op}`);
    }
    if (u.pathname === "/api/v5/cart/calculate") {
      const sentIds = new Set(body.products.map((p: any) => p.id));
      const resp = structuredClone(cart.response);
      resp.products = resp.products.filter((p: any) => sentIds.has(p.id));
      const chosen = body.payment.methods[0]?.method;
      const key = chosen === "line_pay" ? "linepay" : chosen === "payment_on_delivery" ? "cash" : null;
      if (key) resp.payment = structuredClone(selection[key].response.payment);
      resp.payment.total = state.total;
      resp.payment.payable_total = state.total;
      return ok(resp);
    }
    if (u.pathname === "/api/v5/purchase/intent") {
      if (state.intentFail) return { status: 401, ok: false, text: "{}" };
      return ok(structuredClone(intent.response));
    }
    if (u.pathname === "/api/v5/customers") return ok(customer);
    if (u.pathname === "/api/v5/customers/addresses") return ok(structuredClone(addresses));
    if (u.pathname === "/api/v5/cart/checkout") {
      checkouts++;
      const r = state.checkout();
      return { ...r, ok: r.status >= 200 && r.status < 300 };
    }
    throw new Error(`unexpected ${u.pathname}`);
  };
  return { http, state, checkouts: () => checkouts };
}

async function setup() {
  const fake = fakeFoodpanda();
  const fp = new FoodpandaClient(null, 25.033964, 121.564468, { http: fake.http, lockFile: null });
  const server = createServer(fp);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: res.content[0].text as string };
  };
  const res = await call("add_to_cart", {
    restaurant_id: "test01",
    items: [{ item_id: MEAL, quantity: 1, topping_ids: MEAL_CHOICES }],
  });
  assert.equal(res.isError, false, res.text);
  const prepare = async () => {
    const r = await call("prepare_order", { payment_method: "cash", delivery_instructions: "放門口" });
    assert.equal(r.isError, false, r.text);
    return JSON.parse(r.text);
  };
  const close = async () => {
    await mcp.close();
    await server.close();
  };
  return { fake, call, prepare, close };
}

test("prepare_order returns, as JSON, every field the hub shows and compares", async () => {
  const { prepare, close } = await setup();
  try {
    const p = await prepare();
    assert.equal(typeof p.confirmation_code, "string");
    assert.equal(typeof p.expires_at, "string");
    assert.equal(typeof p.restaurant.id, "string");
    assert.equal(typeof p.restaurant.name, "string");
    assert.ok(Array.isArray(p.items) && p.items.length > 0);
    for (const i of p.items) {
      assert.equal(typeof i.name, "string");
      assert.equal(typeof i.quantity, "number");
      assert.ok(Array.isArray(i.options));
      assert.equal(typeof i.special_instructions, "string");
      assert.equal(typeof i.total_price, "number");
    }
    for (const k of ["subtotal", "delivery_fee", "service_fee", "total"]) assert.equal(typeof p[k], "number", k);
    assert.equal(p.currency, "TWD");
    assert.equal(p.payment_method.payment_method, "cash");
    assert.equal(typeof p.payment_method.label, "string");
    assert.equal(typeof p.delivery_address.id, "number");
    assert.equal(typeof p.delivery_address.address, "string");
    assert.equal(p.delivery_instructions, "放門口");
  } finally {
    await close();
  }
});

test("preparing twice for the same cart gives the same order apart from the code", async () => {
  // The hub prepares once to ask the person, and again just before sending; it sends
  // only if both match.
  const { prepare, close } = await setup();
  try {
    const { confirmation_code: a, expires_at: _a, ...first } = await prepare();
    const { confirmation_code: b, expires_at: _b, ...second } = await prepare();
    assert.notEqual(a, b);
    assert.deepEqual(second, first);
  } finally {
    await close();
  }
});

test("a sent order returns order_id", async () => {
  const { call, prepare, close } = await setup();
  try {
    const { confirmation_code } = await prepare();
    const res = await call("place_order", { confirmation_code });
    assert.equal(res.isError, false, res.text);
    assert.equal(JSON.parse(res.text).order_id, "fake-order-1");
  } finally {
    await close();
  }
});

test("an error before checkout says nothing was sent, in words the hub reads as 'not sent'", async () => {
  // A login that expired between prepare_order and place_order: nothing is sent.
  const { fake, call, prepare, close } = await setup();
  try {
    const { confirmation_code } = await prepare();
    fake.state.intentFail = true;
    const res = await call("place_order", { confirmation_code });
    assert.equal(res.isError, true);
    assert.equal(fake.checkouts(), 0);
    assert.ok(res.text.endsWith(CHECKOUT_NOT_SENT), res.text);
    assert.equal(hubReadsAsNotSent(res.text), true);
  } finally {
    await close();
  }

  // A wrong code and a price change are "not sent" too.
  const second = await setup();
  try {
    const wrong = await second.call("place_order", { confirmation_code: "ZZZZZZZZ" });
    assert.ok(wrong.text.endsWith(CHECKOUT_NOT_SENT));
    assert.equal(hubReadsAsNotSent(wrong.text), true);

    const { confirmation_code } = await second.prepare();
    second.fake.state.total = 400;
    const changed = await second.call("place_order", { confirmation_code });
    assert.ok(changed.text.endsWith(CHECKOUT_NOT_SENT));
    assert.equal(hubReadsAsNotSent(changed.text), true);
    assert.equal(second.fake.checkouts(), 0);
  } finally {
    await second.close();
  }
});

test("an error once checkout went out says it may have been placed, never 'not sent'", async () => {
  const answers: Array<() => { status: number; text: string }> = [
    () => {
      throw new Error("socket hang up");
    },
    () => ({ status: 500, text: "{}" }),
    () => ({ status: 200, text: JSON.stringify({ id: "fake-order-2" }) }),
  ];
  for (const answer of answers) {
    const { fake, call, prepare, close } = await setup();
    try {
      fake.state.checkout = answer;
      const { confirmation_code } = await prepare();
      const res = await call("place_order", { confirmation_code });
      assert.equal(res.isError, true);
      assert.equal(fake.checkouts(), 1);
      assert.ok(res.text.endsWith(CHECKOUT_MAYBE_SENT), res.text);
      assert.equal(hubReadsAsNotSent(res.text), false);
    } finally {
      await close();
    }
  }
});
