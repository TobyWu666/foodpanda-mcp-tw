// Run: npm run build && node --test test/*.test.mjs
// All personal data below is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskCapture } from "../scripts/mask-capture.mjs";
import { redactForLog } from "../build/redact.js";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoidHcxMjM0NTYifQ.c2lnbmF0dXJlc2lnbmF0dXJl";

const checkoutBody = {
  id: "ab12-cd34",
  status: "accepted",
  customer: { name: "王小明", first_name: "小明", last_name: "王", email: "ming@example.com", mobile_number: "0912-345-678", code: "tw123456" },
  delivery_address: {
    address_line1: "信義路五段7號",
    floor: "89F",
    latitude: 25.12345,
    longitude: 121.54321,
    delivery_instructions: "請打 0912345678",
  },
  vendor: { name: "Good Noodles", latitude: 25.1, longitude: 121.5 },
  items: [{ name: "牛肉麵", price: 180, quantity: 1 }],
  payment: { method: "linepay", metadata: { token: "pi_abcdef" } },
};

const har = {
  log: {
    entries: [
      {
        request: {
          method: "POST",
          url: "https://tw.fd-api.com/api/v5/cart/checkout?latitude=25.12345&longitude=121.54321&vendor=abc1",
          headers: [
            { name: "Authorization", value: `Bearer ${JWT}` },
            { name: "Cookie", value: "_px3=abc; token=xyz" },
            { name: "x-global-entity-id", value: "FP_TW" },
            { name: "dps-session-id", value: "eyJzZXNzaW9uIjoiMTIzIn0=" },
          ],
          cookies: [{ name: "_pxvid", value: "1234-5678" }],
          queryString: [
            { name: "latitude", value: "25.12345" },
            { name: "vendor", value: "abc1" },
          ],
          postData: { mimeType: "application/json", text: JSON.stringify({ customer: { phone: "+886 912 345 678" } }) },
        },
        response: {
          status: 200,
          headers: [{ name: "Set-Cookie", value: "session=abc" }, { name: "content-type", value: "application/json" }],
          content: {
            mimeType: "application/json",
            encoding: "base64",
            text: Buffer.from(JSON.stringify(checkoutBody)).toString("base64"),
          },
        },
      },
    ],
  },
};

const LEAKS = [JWT, "王小明", "小明", "ming@example.com", "0912-345-678", "0912345678", "912 345 678", "信義路", "89F", "25.12345", "121.54321", "tw123456", "pi_abcdef", "_px3=abc", "1234-5678", "session=abc", "eyJzZXNzaW9uIjoiMTIzIn0="];

test("mask-capture removes credentials and personal data from a HAR", () => {
  const { masked, changes } = maskCapture(har);
  const out = JSON.stringify(masked);
  for (const leak of LEAKS) assert.ok(!out.includes(leak), `still contains ${leak}`);
  assert.ok(changes.length > 0);
});

test("mask-capture keeps what fixtures need", () => {
  const { masked } = maskCapture(har);
  const entry = masked.log.entries[0];
  assert.equal(entry.request.headers.find((h) => h.name === "x-global-entity-id").value, "FP_TW");
  assert.match(entry.request.url, /^https:\/\/tw\.fd-api\.com\/api\/v5\/cart\/checkout\?/);
  assert.match(entry.request.url, /vendor=abc1/);
  const body = JSON.parse(entry.response.content.text);
  assert.equal(body.vendor.name, "Good Noodles");
  assert.equal(body.items[0].name, "牛肉麵");
  assert.equal(body.items[0].price, 180);
  assert.equal(body.payment.method, "linepay");
  assert.equal(typeof body.delivery_address.latitude, "number");
  assert.equal(entry.response.content.encoding, undefined);
});

test("mask-capture is idempotent, so --check passes on its own output", () => {
  const once = maskCapture(har).masked;
  const twice = maskCapture(once);
  assert.deepEqual(twice.masked, once);
  assert.equal(twice.changes.length, 0);
});

test("mask-capture --check flags an unmasked file", () => {
  assert.ok(maskCapture(checkoutBody).changes.length > 0);
});

test("redactForLog strips personal data from a checkout response", () => {
  const out = redactForLog(checkoutBody);
  for (const leak of ["王小明", "ming@example.com", "0912-345-678", "0912345678", "信義路", "89F", "25.12345", "tw123456", "pi_abcdef"]) {
    assert.ok(!out.includes(leak), `still contains ${leak}`);
  }
  assert.ok(out.includes("ab12-cd34"));
  assert.ok(out.includes("Good Noodles"));
});

test("redactForLog handles raw error text", () => {
  const out = redactForLog(`{"error":"bad","customer":{"phone":"0912345678"}}`);
  assert.ok(!out.includes("0912345678"));
  const plain = redactForLog(`upstream said: call 02-2345-6789 or mail a@b.co, auth Bearer ${JWT}`);
  assert.ok(!plain.includes("2345-6789"));
  assert.ok(!plain.includes("a@b.co"));
  assert.ok(!plain.includes(JWT));
});
