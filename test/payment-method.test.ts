import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_PAYMENT_METHODS,
  UnsupportedPaymentMethodError,
  isSupportedPaymentMethod,
  parsePaymentMethodChoice,
} from "../src/payment-method.js";

test("only linepay and cash are supported", () => {
  assert.deepEqual([...SUPPORTED_PAYMENT_METHODS], ["linepay", "cash"]);
  assert.equal(isSupportedPaymentMethod("linepay"), true);
  assert.equal(isSupportedPaymentMethod("cash"), true);
  assert.equal(isSupportedPaymentMethod("creditcard"), false);
  assert.equal(isSupportedPaymentMethod(undefined), false);
});

test("parse normalises case and whitespace", () => {
  assert.equal(parsePaymentMethodChoice(" LinePay "), "linepay");
  assert.equal(parsePaymentMethodChoice("CASH"), "cash");
});

for (const bad of ["creditcard", "jkopay", "", "line pay", undefined, null, 1]) {
  test(`unsupported method ${JSON.stringify(bad)} throws a typed error`, () => {
    assert.throws(
      () => parsePaymentMethodChoice(bad),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedPaymentMethodError);
        assert.equal(err.code, "UNSUPPORTED_PAYMENT_METHOD");
        assert.equal(err.requested, String(bad));
        return true;
      }
    );
  });
}

test("a supported method that the account lacks is rejected, not swapped", () => {
  assert.throws(
    () => parsePaymentMethodChoice("linepay", ["cash"]),
    (err: unknown) => {
      assert.ok(err instanceof UnsupportedPaymentMethodError);
      assert.deepEqual(err.available, ["cash"]);
      assert.match(err.message, /Supported and available: cash/);
      assert.match(err.message, /No other payment method was used/);
      return true;
    }
  );
});

test("error message says none when nothing is available", () => {
  const err = new UnsupportedPaymentMethodError("cash", []);
  assert.match(err.message, /Supported and available: none/);
});
