import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckoutStatusUnknownError,
  buildCalculateRequest,
  checkCalculatedPayment,
  checkoutMismatches,
  parseCheckoutResponse,
  parsePurchaseIntent,
  purchaseIntentRequest,
  withPaymentMethod,
} from "../src/tw-api.js";
import { UnsupportedPaymentMethodError } from "../src/payment-method.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", name), "utf-8"));

const intent = fixture("tw-purchase-intent.masked.json");
const selection = fixture("tw-payment-selection.masked.json");
const cart = fixture("tw-cart-calculate.masked.json");

test("purchase intent request matches the captured call", () => {
  assert.deepEqual(purchaseIntentRequest("test01", 278, 366, "TWD"), intent.request);
});

test("purchase intent: bound LINE Pay and cash are usable, other methods are listed as not supported", () => {
  const parsed = parsePurchaseIntent(intent.response);
  assert.equal(parsed.intentId, "intent-0001");
  assert.deepEqual(
    parsed.options.map((o) => [o.choice, o.method, o.publicId, o.displayableName]),
    [
      ["linepay", "line_pay", "linepay-bound-instrument-id", "NEXTGEN_PAYMENT_SELECTION_LINE_PAY"],
      ["cash", "payment_on_delivery", "cash-instrument-id", "NEXTGEN_PAYMENT_SELECTION_PAYMENT_ON_DELIVERY"],
    ]
  );
  assert.match(parsed.options[0].label, /LINE Pay .*0000$/);
  // The credit card is visible on the site; hidden methods (no_payment, invoice, balance) are not listed.
  assert.deepEqual(parsed.notSupported, ["cybersource_creditcard"]);
  assert.deepEqual(parsed.unavailable, []);
});

test("LINE Pay without a bound account is not offered", () => {
  const resp = structuredClone(intent.response);
  const linePay = resp.data.paymentMethodDetails.paymentMethods.find((m: any) => m.name === "line_pay");
  linePay.paymentInstruments = [];
  const parsed = parsePurchaseIntent(resp);
  assert.deepEqual(parsed.options.map((o) => o.choice), ["cash"]);
  assert.deepEqual(parsed.unavailable, [{ choice: "linepay", reason: "no bound LINE Pay account" }]);
});

test("an unhealthy instrument or method is not offered", () => {
  const resp = structuredClone(intent.response);
  const cash = resp.data.paymentMethodDetails.paymentMethods.find((m: any) => m.name === "payment_on_delivery");
  cash.status = "UNHEALTHY";
  const linePay = resp.data.paymentMethodDetails.paymentMethods.find((m: any) => m.name === "line_pay");
  linePay.paymentInstruments[0].status = "EXPIRED";
  const parsed = parsePurchaseIntent(resp);
  assert.deepEqual(parsed.options, []);
  assert.equal(parsed.unavailable.length, 2);
});

for (const choice of ["linepay", "cash"] as const) {
  test(`selecting ${choice} puts exactly the captured entry in cart/calculate`, () => {
    const option = parsePurchaseIntent(intent.response).options.find((o) => o.choice === choice)!;
    const base = buildCalculateRequest(cart.request.products, cart.request.vendor, 25.033964, 121.564468);
    const body = withPaymentMethod(base, option, 366);
    assert.deepEqual(body.payment, selection[choice].request.payment);
    assert.deepEqual(base.payment.methods, [], "the base request is not changed");
    // foodpanda's echo of the same method is accepted
    assert.doesNotThrow(() => checkCalculatedPayment(selection[choice].response, option));
  });
}

test("a calculate answer with another or no payment method is refused, never used", () => {
  const linePay = parsePurchaseIntent(intent.response).options.find((o) => o.choice === "linepay")!;
  assert.throws(() => checkCalculatedPayment(selection.cash.response, linePay), UnsupportedPaymentMethodError);
  assert.throws(() => checkCalculatedPayment(cart.response, linePay), /No other payment method was used/);
});

test("checkout response: an order code and nothing pending is a placed order", () => {
  const outcome = parseCheckoutResponse({ id: "abcd-1234", payment: { result: "success", action: null }, expedition: { expected_delivery_duration: 35 } });
  assert.equal(outcome.orderCode, "abcd-1234");
  assert.equal(outcome.status, "success");
  assert.equal(outcome.estimatedDelivery, "35 min");
});

test("checkout response: an order code with no success status is 'status unknown'", () => {
  for (const resp of [{ id: "o6" }, { order_code: "o6", payment: {} }, { id: "o6", total: 366 }]) {
    assert.throws(() => parseCheckoutResponse(resp), /does not say the order succeeded.*order code o6/s);
  }
});

test("checkout response: success values are matched whole and in any key style", () => {
  for (const resp of [
    { id: "o", status: "SUCCESS" },
    { id: "o", paymentStatus: "paid" },
    { id: "o", order: { orderState: "Confirmed" } },
    { id: "o", data: { result: "completed" } },
    { id: "o", payment: { status: "paid" }, vouchers: [{ code: "x" }] },
    { id: "o", data: { order: { status: "confirmed" } } },
    { id: "o", status: "success", payment: { amount_due: 0, pending_amount: 0 } },
  ]) {
    assert.doesNotThrow(() => parseCheckoutResponse(resp), JSON.stringify(resp));
  }
  for (const value of ["unpaid", "not_confirmed", "success_pending", "paid_partially"]) {
    assert.throws(() => parseCheckoutResponse({ id: "o", status: value }), CheckoutStatusUnknownError, value);
  }
});

// The reviewer's probes, plus a few more: anything pending, anywhere, is "status unknown".
const PENDING_SHAPES: Array<[string, unknown]> = [
  // First review
  ["payment.redirect_url", { id: "o1", status: "success", payment: { redirect_url: "https://example.invalid/pay" } }],
  ["payment.client_action", { order_code: "o2", status: "success", payment: { client_action: { type: "LINE_PAY" } } }],
  ["payment.status pending", { order_code: "o3", payment: { status: "pending" } }],
  ["data.redirect_url", { data: { order_code: "o4", status: "success", redirect_url: "https://example.invalid/pay" } }],
  ["top-level redirect_url", { id: "o5", status: "success", redirect_url: "https://example.invalid/pay" }],
  ["payment.action string", { id: "o7", status: "success", payment: { action: "redirect" } }],
  ["deeplink", { id: "o8", status: "success", payment: { line_pay: { deeplink: "line://pay/x" } } }],
  ["status waiting_for_payment", { id: "o9", status: "WAITING_FOR_PAYMENT" }],
  ["result requires_action", { id: "o10", payment: { result: "requires_action" } }],
  ["order status failed", { order: { code: "o11", status: "failed" } }],
  ["nested in an array", { id: "o12", status: "success", payment: { steps: [{ action_url: "https://example.invalid" }] } }],
  // Re-review: each of these passed as a success before
  ["camelCase paymentStatus PENDING", { id: "p1", status: "success", paymentStatus: "PENDING" }],
  ["order.orderStatus AWAITING_PAYMENT", { id: "p2", status: "success", order: { orderStatus: "AWAITING_PAYMENT" } }],
  ["status object", { id: "p3", status: "success", payment: { status: { code: "PENDING" } } }],
  ["requires_payment true", { id: "p4", status: "success", requires_payment: true }],
  ["is_pending true", { id: "p5", status: "success", is_pending: true }],
  ["paid false", { id: "p6", status: "success", paid: false }],
  ["next_step", { id: "p7", status: "success", next_step: { type: "PAY" } }],
  ["webview", { id: "p8", status: "success", webview: { html: "x" } }],
  ["form_html", { id: "p9", status: "success", form_html: "<form action='x'></form>" }],
  ["location LINE Pay URL", { id: "p10", status: "success", location: "https://pay.line.me/x" }],
  ["target LINE Pay URL", { id: "p11", status: "success", target: "https://pay.line.me/x" }],
  ["any http(s) string", { id: "p12", status: "success", payment: { info: "https://pay.line.me/x" } }],
  ["status CREATED", { id: "p13", status: "CREATED" }],
  ["status NEW", { id: "p14", status: "NEW" }],
  ["transactionStatus INIT", { id: "p15", status: "success", transactionStatus: "INIT" }],
  ["requiresAction camelCase", { id: "p16", status: "success", payment: { requiresAction: true } }],
  ["isPaid false", { id: "p17", status: "success", isPaid: false }],
  // Third review: app deep links count as links
  ["line:// deep link", { id: "d1", status: "success", payment: { info: "line://pay/payment/x" } }],
  ["intent:// deep link", { id: "d2", status: "success", payment: { open: "intent://pay#Intent;scheme=line;end" } }],
  ["custom scheme", { id: "d3", status: "success", payment: { open: "linepay-app://checkout?x=1" } }],
  // Third review: a success on something other than the order is not a success
  ["success only on a voucher", { id: "s1", vouchers: [{ status: "success" }] }],
  ["success only on an incentive", { id: "s2", incentive: { status: "accepted" } }],
  ["success only on an item", { id: "s3", order: { items: [{ status: "confirmed" }] } }],
  ["bare pay.line.me", { id: "d4", status: "success", payment: { info: "pay.line.me/web/payment/x" } }],
  ["*_uri key", { id: "d5", status: "success", payment: { callback_uri: "/pay/x" } }],
  ["awaiting_*", { id: "k1", status: "success", awaiting_confirmation: true }],
  ["needs_*", { id: "k2", status: "success", payment: { needsAuthentication: true } }],
  ["pending_*", { id: "k3", status: "success", pending_amount: 366 }],
  ["amount_due", { id: "k4", status: "success", payment: { amount_due: 366 } }],
  ["outstanding", { id: "k5", status: "success", outstanding: 366 }],
];
for (const [label, resp] of PENDING_SHAPES) {
  test(`checkout response: ${label} is 'status unknown', not a success`, () => {
    assert.throws(() => parseCheckoutResponse(resp), (err: Error) => {
      assert.ok(err instanceof CheckoutStatusUnknownError);
      assert.match(err.message, /unfinished step or status|does not say the order succeeded/);
      assert.match(err.message, /Do not retry/);
      return true;
    });
  });
}

test("checkout response: errors or no order code are 'status unknown'", () => {
  for (const resp of [{ errors: [{ message: "x" }] }, { error: "x" }, { status: "ok" }, null, [], "text"]) {
    assert.throws(() => parseCheckoutResponse(resp), CheckoutStatusUnknownError);
  }
});

test("checkout response: a reported total or method that differs from the confirmed order is flagged", () => {
  const expected = { total: 366, method: "line_pay" };
  const same = parseCheckoutResponse({ id: "o", status: "success", total: 366, payment: { methods: [{ method: "line_pay" }] } });
  assert.deepEqual(checkoutMismatches(same, expected), []);
  const silent = parseCheckoutResponse({ id: "o", status: "success" });
  assert.deepEqual(checkoutMismatches(silent, expected), [], "nothing reported, nothing to compare");
  const other = parseCheckoutResponse({ id: "o", status: "success", payment: { total: 380, methods: [{ method: "payment_on_delivery" }] } });
  const found = checkoutMismatches(other, expected);
  assert.equal(found.length, 2);
  assert.match(found[0], /total 380 instead of the confirmed 366/);
  assert.match(found[1], /payment_on_delivery instead of the confirmed line_pay/);
});
