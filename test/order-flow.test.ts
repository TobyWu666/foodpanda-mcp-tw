/**
 * The whole two-step order through the MCP server, with foodpanda replaced by a fake.
 * Nothing here reaches the network: the client's HTTP function is injected, and the
 * fake's checkout only records that it was called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import {
  FoodpandaClient,
  type FoodpandaClientOptions,
  type HttpFunction,
  type SendOutcome,
} from "../src/foodpanda-client.js";
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
  via?: string;
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
    calls.push({ method, path: u.pathname, body, headers: init.headers ?? {}, via: init.via });
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

async function setup(
  guard?: OrderGuard,
  lockFile: string | null = null,
  confirmSend?: FoodpandaClientOptions["confirmSend"],
  reportOutcome?: FoodpandaClientOptions["reportOutcome"]
) {
  const fake = fakeFoodpanda();
  const fp = new FoodpandaClient(null, 25.033964, 121.564468, {
    http: fake.http,
    guard,
    lockFile,
    confirmSend,
    reportOutcome,
  });
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
    assert.equal(summary.other_charges, undefined, "the captured parts add up to the total");
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

    // The storefront page cannot read GET /api/v5/customers ("Failed to fetch" in the live
    // run), so it goes through the browser context; the addresses still come from the page.
    const customers = fake.calls.filter((c) => c.path === "/api/v5/customers");
    assert.ok(customers.length > 0);
    assert.ok(customers.every((c) => c.via === "context"));
    assert.ok(fake.calls.filter((c) => c.path === "/api/v5/customers/addresses").every((c) => c.via === undefined));
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
    assert.match(res.text, /unfinished step or status/);
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

test("after a 'status unknown', the cart is emptied and a new order needs the user's check first", async () => {
  const { fake, call, close } = await setup();
  try {
    fake.state.checkout = () => ({
      status: 200,
      text: JSON.stringify({ id: "fake-order-3", payment: { status: "pending" } }),
    });
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    const res = await call("place_order", { confirmation_code });
    assert.match(res.text, /order status is unknown/);
    assert.equal((await call("get_cart")).text, "Cart is empty.");

    // The agent tries to order again straight away: refused until the user has checked.
    await fillCart(call);
    const blocked = await call("prepare_order", { payment_method: "linepay" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /previous order's status is unknown.*check the foodpanda app/s);

    const allowed = await call("prepare_order", { payment_method: "linepay", previous_order_checked_in_app: true });
    assert.equal(allowed.isError, false, allowed.text);
    assert.equal(fake.checkouts().length, 1);
  } finally {
    await close();
  }
});

test("rebinding or unbinding LINE Pay after prepare_order voids the code", async () => {
  for (const change of ["rebind", "unbind"] as const) {
    const { fake, call, close } = await setup();
    try {
      await fillCart(call);
      const { confirmation_code } = await prepare(call);
      const linePay = fake.state.intent.data.paymentMethodDetails.paymentMethods.find((m: any) => m.name === "line_pay");
      if (change === "rebind") linePay.paymentInstruments[0].publicId = "another-linepay-instrument";
      else linePay.paymentInstruments = [];
      const res = await call("place_order", { confirmation_code });
      assert.equal(res.isError, true, change);
      assert.match(res.text, /payment_method|can no longer be used/, change);
      assert.equal(fake.checkouts().length, 0, change);
    } finally {
      await close();
    }
  }
});

test("prepare_order with unbound LINE Pay says it is not bound", async () => {
  const { fake, call, close } = await setup();
  try {
    await fillCart(call);
    const linePay = fake.state.intent.data.paymentMethodDetails.paymentMethods.find((m: any) => m.name === "line_pay");
    linePay.paymentInstruments = [];
    const res = await call("prepare_order", { payment_method: "linepay" });
    assert.match(res.text, /LINE Pay not bound/);
  } finally {
    await close();
  }
});

test("an order whose reported total or method differs is flagged prominently", async () => {
  const { fake, call, close } = await setup();
  try {
    fake.state.checkout = () => ({
      status: 200,
      text: JSON.stringify({ id: "fake-order-4", status: "success", total: 380, payment: { methods: [{ method: "line_pay" }] } }),
    });
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    const res = await call("place_order", { confirmation_code });
    const result = JSON.parse(res.text);
    assert.equal(Object.keys(result)[0], "attention", "the warning comes first");
    assert.match(result.attention, /MISMATCH: foodpanda reports total 380 instead of the confirmed 366/);
    assert.equal(result.order_id, "fake-order-4");
  } finally {
    await close();
  }
});

test("a bare order code is 'status unknown' and locks ordering", async () => {
  const { fake, call, close } = await setup();
  try {
    fake.state.checkout = () => ({ status: 200, text: JSON.stringify({ id: "fake-order-5" }) });
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    const res = await call("place_order", { confirmation_code });
    assert.match(res.text, /order status is unknown.*does not say the order succeeded/s);
    assert.match(res.text, /fake-order-5/);
    await fillCart(call);
    assert.match((await call("prepare_order", { payment_method: "cash" })).text, /previous order's status is unknown/);
  } finally {
    await close();
  }
});

test("the check-the-app lock survives a restart, holds no order details, and is lifted only with the flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-lock-"));
  const lockFile = join(dir, "order-check-required.json");
  try {
    const first = await setup(undefined, lockFile);
    try {
      first.fake.state.checkout = () => {
        throw new Error("socket hang up");
      };
      await fillCart(first.call);
      const { confirmation_code } = await prepare(first.call);
      assert.match((await first.call("place_order", { confirmation_code })).text, /order status is unknown/);
    } finally {
      await first.close();
    }

    const saved = readFileSync(lockFile, "utf-8");
    assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ["at", "reason"]);
    assert.doesNotMatch(saved, /test01|990000001|366|line_pay|socket/);

    // A new server process (same state dir) still refuses.
    const second = await setup(undefined, lockFile);
    try {
      await fillCart(second.call);
      assert.match((await second.call("prepare_order", { payment_method: "cash" })).text, /previous order's status is unknown/);
      const ok = await second.call("prepare_order", { payment_method: "cash", previous_order_checked_in_app: true });
      assert.equal(ok.isError, false, ok.text);
      assert.equal(existsSync(lockFile), false, "lifted once the user has checked");
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a client without an injected http cannot reach the network from a test", async () => {
  const fp = new FoodpandaClient(null, 25.033964, 121.564468);
  await assert.rejects(fp.searchRestaurants("x"), /Network access in a test/);
});

test("if the lock file cannot be written, place_order still says 'status unknown' and the lock holds in memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-lock-"));
  // A path under a regular file can never be created.
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "x");
  const { fake, call, close } = await setup(undefined, join(blocker, "order-check-required.json"));
  try {
    fake.state.checkout = () => ({ status: 200, text: JSON.stringify({ id: "fake-order-6" }) });
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    const res = await call("place_order", { confirmation_code });
    assert.match(res.text, /order status is unknown/);
    await fillCart(call);
    assert.match((await call("prepare_order", { payment_method: "cash" })).text, /previous order's status is unknown/);
  } finally {
    await close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a login token counts only when /api/v5/customers knows the account", async () => {
  const answer = (status: number, value: unknown) => async () => ({
    status,
    ok: status >= 200 && status < 300,
    text: JSON.stringify(value),
  });
  const check = (http: HttpFunction) =>
    new FoodpandaClient(null, 25.033964, 121.564468, { http, lockFile: null }).isAccountToken("a.b.c");

  let seen: { auth?: string; via?: string; noWarmUp?: boolean } = {};
  const record: HttpFunction = async (url, init) => {
    seen = { auth: init.headers?.Authorization, via: init.via, noWarmUp: init.noWarmUp };
    return answer(200, customer)();
  };
  assert.equal(await check(record), true);
  // Its own token, from the browser context, without navigating the login page.
  assert.deepEqual(seen, { auth: "Bearer a.b.c", via: "context", noWarmUp: true });

  assert.equal(await check(answer(401, {})), false);
  assert.equal(await check(answer(412, {})), false);
  assert.equal(await check(answer(200, { status_code: 200, data: {} })), false, "no customer id");
  await assert.rejects(
    check(async () => ({ status: 403, ok: false, text: "<title>Access to this page has been denied</title>" })),
    /PerimeterX/
  );
});

test("with a send confirmation, a 'no' sends nothing and needs a new prepare_order", async () => {
  const asked: any[] = [];
  const { fake, call, close } = await setup(undefined, null, async (order) => {
    asked.push(order);
    return false;
  });
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call, "cash");
    const res = await call("place_order", { confirmation_code });
    assert.equal(res.isError, true);
    assert.match(res.text, /Not sent/);
    assert.equal(fake.checkouts().length, 0);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].total, 366);
    assert.equal(asked[0].currency, "TWD");
    assert.equal(asked[0].items[0].quantity, 1);
    assert.equal(asked[0].delivery_instructions, "放門口");

    // The code is spent; a declined send is not a "status unknown", so prepare_order works again.
    assert.equal((await call("place_order", { confirmation_code })).isError, true);
    assert.equal(fake.checkouts().length, 0);
    await prepare(call, "cash");
  } finally {
    await close();
  }
});

test("with a send confirmation, a 'yes' sends checkout exactly once; a failing dialog counts as 'no'", async () => {
  {
    const { fake, call, close } = await setup(undefined, null, async () => true);
    try {
      await fillCart(call);
      const { confirmation_code } = await prepare(call);
      const res = await call("place_order", { confirmation_code });
      assert.equal(res.isError, false, res.text);
      assert.equal(fake.checkouts().length, 1);
    } finally {
      await close();
    }
  }
  {
    const { fake, call, close } = await setup(undefined, null, async () => {
      throw new Error("osascript missing");
    });
    try {
      await fillCart(call);
      const { confirmation_code } = await prepare(call);
      const res = await call("place_order", { confirmation_code });
      assert.equal(res.isError, true);
      assert.match(res.text, /Not sent/);
      assert.equal(fake.checkouts().length, 0);
    } finally {
      await close();
    }
  }
});

test("a cart change while the person decides stops the order even if they say yes", async () => {
  let callTool: ((n: string, a?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>) | undefined;
  const { fake, call, close } = await setup(undefined, null, async () => {
    const res = await callTool!("add_to_cart", {
      restaurant_id: "test01",
      items: [{ item_id: MEAL, quantity: 1, topping_ids: MEAL_CHOICES }],
    });
    assert.equal(res.isError, false, res.text);
    return true;
  });
  callTool = call;
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    const res = await call("place_order", { confirmation_code });
    assert.equal(res.isError, true);
    assert.match(res.text, /changed while waiting/);
    assert.equal(fake.checkouts().length, 0);
  } finally {
    await close();
  }
});

test("after a confirmed send, the outcome is reported; a 'no' reports nothing", async () => {
  {
    const outcomes: SendOutcome[] = [];
    const { call, close } = await setup(undefined, null, async () => false, (o) => outcomes.push(o));
    try {
      await fillCart(call);
      const { confirmation_code } = await prepare(call);
      await call("place_order", { confirmation_code });
      assert.deepEqual(outcomes, [], "nothing to report when the person said no");
    } finally {
      await close();
    }
  }
  {
    const outcomes: SendOutcome[] = [];
    const { fake, call, close } = await setup(undefined, null, async () => true, (o) => outcomes.push(o));
    try {
      await fillCart(call);
      const { confirmation_code } = await prepare(call);
      const res = await call("place_order", { confirmation_code });
      assert.equal(fake.checkouts().length, 1);
      assert.equal(outcomes.length, 1);
      const o = outcomes[0];
      if (o.kind === "result") assert.equal(o.result.order_id, JSON.parse(res.text).order_id);
      else assert.equal(o.checkoutSent, true);
    } finally {
      await close();
    }
  }
  {
    const outcomes: SendOutcome[] = [];
    const { fake, call, close } = await setup(undefined, null, async () => true, (o) => outcomes.push(o));
    fake.state.checkout = () => {
      throw new Error("network down");
    };
    try {
      await fillCart(call);
      const { confirmation_code } = await prepare(call);
      assert.equal((await call("place_order", { confirmation_code })).isError, true);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].kind, "error");
      assert.equal((outcomes[0] as any).checkoutSent, true, "the send was attempted, so its result is unknown");
    } finally {
      await close();
    }
  }
});

test("a cart change during confirmation is reported as not sent", async () => {
  const outcomes: SendOutcome[] = [];
  let callTool: ((n: string, a?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>) | undefined;
  const { fake, call, close } = await setup(
    undefined,
    null,
    async () => {
      await callTool!("add_to_cart", {
        restaurant_id: "test01",
        items: [{ item_id: MEAL, quantity: 1, topping_ids: MEAL_CHOICES }],
      });
      return true;
    },
    (o) => outcomes.push(o)
  );
  callTool = call;
  try {
    await fillCart(call);
    const { confirmation_code } = await prepare(call);
    await call("place_order", { confirmation_code });
    assert.equal(fake.checkouts().length, 0);
    assert.equal(outcomes.length, 1);
    assert.deepEqual({ ...outcomes[0], message: undefined }, { kind: "error", checkoutSent: false, message: undefined });
    assert.match((outcomes[0] as any).message, /changed while waiting/);
  } finally {
    await close();
  }
});
