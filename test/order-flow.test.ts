/**
 * The whole two-step order through the MCP server, with foodpanda replaced by a fake.
 * Nothing here reaches the network: the client's HTTP function is injected, and the
 * fake's checkout only records that it was called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { FoodpandaClient, type HttpFunction } from "../src/foodpanda-client.js";
import { OrderGuard } from "../src/order-guard.js";

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

interface Call {
  method: string;
  path: string;
  body: any;
  headers: Record<string, string>;
}

/** A stand-in for foodpanda that answers from the masked capture. */
function fakeFoodpanda() {
  const calls: Call[] = [];
  const state = {
    total: 366,
    intent: structuredClone(intent.response),
    addresses: structuredClone(addresses),
    /** What checkout answers; a function so a test can throw (network failure). */
    checkout: (): { status: number; text: string } => ({
      status: 200,
      text: JSON.stringify({ id: "fake-order-1", payment: { result: "success", action: null } }),
    }),
  };
  const http: HttpFunction = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, body, headers: init.headers ?? {} });
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
    if (u.pathname === "/api/v5/purchase/intent") return ok(state.intent);
    if (u.pathname === "/api/v5/customers") return ok(customer);
    if (u.pathname === "/api/v5/customers/addresses") return ok(state.addresses);
    if (u.pathname === "/api/v5/cart/checkout") {
      const r = state.checkout();
      return { ...r, ok: r.status >= 200 && r.status < 300 };
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
  };
  const checkouts = () => calls.filter((c) => c.path === "/api/v5/cart/checkout");
  return { http, calls, state, checkouts };
}

async function setup(guard?: OrderGuard) {
  const fake = fakeFoodpanda();
  const fp = new FoodpandaClient(null, 25.033964, 121.564468, { http: fake.http, guard });
  const server = createServer(fp);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await mcp.callTool({ name, arguments: args });
    return { isError: !!res.isError, text: res.content[0].text as string };
  };
  const close = async () => {
    await mcp.close();
    await server.close();
  };
  return { fake, call, close };
}

async function fillCart(call: (n: string, a?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>) {
  const res = await call("add_to_cart", {
    restaurant_id: "test01",
    items: [{ item_id: MEAL, quantity: 1, topping_ids: MEAL_CHOICES }],
  });
  assert.equal(res.isError, false, res.text);
}

async function prepare(call: (n: string, a?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>, method = "linepay") {
  const res = await call("prepare_order", { payment_method: method, delivery_instructions: "放門口" });
  assert.equal(res.isError, false, res.text);
  return JSON.parse(res.text);
}

test("prepare_order shows everything that will be ordered and locks it with a code", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    const summary = await prepare(call);
    assert.match(summary.confirmation_code, /^[2-9A-HJ-NP-Z]{8}$/);
    assert.equal(summary.restaurant.id, "test01");
    assert.equal(summary.items.length, 1);
    assert.equal(summary.items[0].quantity, 1);
    assert.ok(summary.items[0].options.some((o: string) => /\+20/.test(o)), "priced option shown");
    assert.equal(summary.subtotal, 278);
    assert.equal(summary.service_fee, 19);
    assert.equal(summary.total, 366);
    assert.equal(summary.currency, "TWD");
    assert.equal(summary.payment_method.payment_method, "linepay");
    assert.equal(summary.delivery_address.id, 990000001);
    assert.equal(summary.delivery_instructions, "放門口");
    assert.match(summary.next_step, /explicitly agree/);

    // The last calculate carried the captured LINE Pay entry, at the saved address' location.
    const calc = fake.calls.filter((c) => c.path === "/api/v5/cart/calculate").at(-1)!;
    assert.deepEqual(calc.body.payment, selection.linepay.request.payment);
    assert.equal(calc.body.expedition.latitude, 25.033964);
    assert.equal(fake.checkouts().length, 0, "prepare_order never checks out");
  } finally {
    await close();
  }
});

test("place_order with the code sends checkout exactly once, with the prepared payment and address", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    const res = await call("place_order", { confirmation_code });
    assert.equal(res.isError, false, res.text);
    assert.equal(JSON.parse(res.text).order_id, "fake-order-1");

    assert.equal(fake.checkouts().length, 1);
    const body = fake.checkouts()[0].body;
    assert.equal(body.expected_total_amount, 366);
    assert.deepEqual(body.payment.methods, [
      { amount: 366, metadata: { token: "linepay-bound-instrument-id" }, method: "line_pay" },
    ]);
    assert.equal(body.payment.purchase_intent_id, "intent-0001");
    assert.equal(body.payment.currency, "TWD");
    assert.equal(body.customer.address_id, "990000001");
    assert.equal(body.expedition.instructions, "放門口");
    assert.equal(fake.checkouts()[0].headers["x-global-entity-id"], "FP_TW");

    // The code is spent and the cart is empty.
    const again = await call("place_order", { confirmation_code });
    assert.equal(again.isError, true);
    assert.equal(fake.checkouts().length, 1);
  } finally {
    await close();
  }
});

test("cash on delivery uses the cash instrument", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call, "cash");
    const res = await call("place_order", { confirmation_code });
    assert.equal(res.isError, false, res.text);
    assert.deepEqual(fake.checkouts()[0].body.payment.methods, [
      { amount: 366, metadata: { token: "cash-instrument-id" }, method: "payment_on_delivery" },
    ]);
  } finally {
    await close();
  }
});

test("no checkout without a valid code: missing, wrong, or after the cart changed", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call);

    assert.match((await call("place_order", { confirmation_code: "" })).text, /required/);
    assert.match((await call("place_order", { confirmation_code: "WRONG234" })).text, /Unknown confirmation code/);
    // A wrong code ends the attempt, so the real code is void too.
    assert.match((await call("place_order", { confirmation_code })).text, /already been used|Unknown/);

    const fresh = await prepare(call);
    await fillCart(call); // changes the cart
    const res = await call("place_order", { confirmation_code: fresh.confirmation_code });
    assert.equal(res.isError, true);
    assert.equal(fake.checkouts().length, 0);
  } finally {
    await close();
  }
});

test("a price change between prepare and place stops the order", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    fake.state.total = 380;
    const res = await call("place_order", { confirmation_code });
    assert.equal(res.isError, true);
    assert.match(res.text, /changed since prepare_order \(price\)/);
    assert.equal(fake.checkouts().length, 0);
  } finally {
    await close();
  }
});

test("an edited delivery address stops the order", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    fake.state.addresses.data.items[0].formatted_customer_address = "another place";
    const res = await call("place_order", { confirmation_code });
    assert.match(res.text, /address/);
    assert.equal(fake.checkouts().length, 0);
  } finally {
    await close();
  }
});

test("an expired code stops the order", async () => {
  let now = 1_000_000;
  const { fake, call, close } = await setup(new OrderGuard({ now: () => now }));
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    now += 5 * 60 * 1000;
    const res = await call("place_order", { confirmation_code });
    assert.match(res.text, /expired/);
    assert.equal(fake.checkouts().length, 0);
  } finally {
    await close();
  }
});

test("checkout is never retried: a PerimeterX block, a network failure or a 500 is 'status unknown'", async () => {
  const answers: Array<() => { status: number; text: string }> = [
    () => ({ status: 403, text: "<html>px-captcha Access to this page has been denied</html>" }),
    () => {
      throw new Error("socket hang up");
    },
    () => ({ status: 500, text: "{}" }),
    () => ({ status: 200, text: "not json" }),
  ];
  for (const answer of answers) {
    const { fake, call, close } = await setup();
    try {
      fake.state.checkout = answer;
      await fillCart(call);
      const { confirmation_code } = await prepare(call);
      const res = await call("place_order", { confirmation_code });
      assert.equal(res.isError, true);
      assert.match(res.text, /order status is unknown/);
      assert.match(res.text, /Do not retry/);
      assert.equal(fake.checkouts().length, 1, "sent once, never again");
    } finally {
      await close();
    }
  }
});

test("bound LINE Pay asking for a redirect is reported, not treated as paid, and not retried with cash", async () => {
  const { fake, call, close } = await setup();
  try {
    fake.state.checkout = () => ({
      status: 200,
      text: JSON.stringify({ id: "fake-order-2", redirect_url: "https://example.invalid/linepay" }),
    });
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    const res = await call("place_order", { confirmation_code });
    assert.match(res.text, /extra payment step/);
    assert.equal(fake.checkouts().length, 1);
    assert.equal(fake.checkouts()[0].body.payment.methods[0].method, "line_pay");
  } finally {
    await close();
  }
});

test("unsupported or unavailable payment methods are refused with no fallback", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    for (const method of ["credit_card", "cybersource_creditcard", "全支付", ""]) {
      const res = await call("prepare_order", { payment_method: method });
      assert.equal(res.isError, true);
      assert.match(res.text, /not supported/);
    }
    // No bound LINE Pay: linepay is refused, cash is not picked instead.
    const linePay = fake.state.intent.data.paymentMethodDetails.paymentMethods.find((m: any) => m.name === "line_pay");
    linePay.paymentInstruments = [];
    const res = await call("prepare_order", { payment_method: "linepay" });
    assert.equal(res.isError, true);
    assert.match(res.text, /Supported and available: cash. No other payment method was used/);

    const listed = JSON.parse((await call("list_payment_methods")).text);
    assert.deepEqual(listed.available.map((m: any) => m.payment_method), ["cash"]);
    assert.deepEqual(listed.not_supported_by_this_server, ["cybersource_creditcard"]);
    assert.equal(fake.checkouts().length, 0);
  } finally {
    await close();
  }
});

test("with several saved addresses, prepare_order asks instead of guessing", async () => {
  const { fake, call, close } = await setup();
  try {
    const second = structuredClone(fake.state.addresses.data.items[0]);
    second.id = 990000009;
    fake.state.addresses.data.items.push(second);
    await fillCart(call);
    const res = await call("prepare_order", { payment_method: "cash" });
    assert.equal(res.isError, true);
    assert.match(res.text, /2 saved addresses.*address_id/s);
    const ok = await call("prepare_order", { payment_method: "cash", address_id: 990000009 });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(JSON.parse(ok.text).delivery_address.id, 990000009);
  } finally {
    await close();
  }
});
