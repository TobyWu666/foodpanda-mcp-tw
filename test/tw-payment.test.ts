import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckoutStatusUnknownError,
  buildCalculateRequest,
  checkCalculatedPayment,
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

test("checkout response: an order code is a placed order", () => {
  const outcome = parseCheckoutResponse({ id: "abcd-1234", payment: { result: "success", action: null }, expedition: { expected_delivery_duration: 35 } });
  assert.deepEqual(outcome, { orderCode: "abcd-1234", status: "success", estimatedDelivery: "35 min" });
});

test("checkout response: a redirect or payment action is a clear 'status unknown', not a success", () => {
  for (const resp of [
    { id: "abcd-1234", redirect_url: "https://example.invalid/pay" },
    { id: "abcd-1234", payment: { action: "redirect" } },
    { id: "abcd-1234", payment: { action: { type: "REDIRECT", url: "https://example.invalid" } } },
  ]) {
    assert.throws(() => parseCheckoutResponse(resp), (err: Error) => {
      assert.ok(err instanceof CheckoutStatusUnknownError);
      assert.match(err.message, /extra payment step/);
      assert.match(err.message, /Do not retry/);
      return true;
    });
  }
});

test("checkout response: errors or no order code are 'status unknown'", () => {
  for (const resp of [{ errors: [{ message: "x" }] }, { error: "x" }, { status: "ok" }, null]) {
    assert.throws(() => parseCheckoutResponse(resp), CheckoutStatusUnknownError);
  }
});
