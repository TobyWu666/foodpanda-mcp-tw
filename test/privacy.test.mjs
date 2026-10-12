// Run: npm run build && node --test test/*.test.mjs
// All personal data below is made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maskCapture, checkFixture, detectLeaks } from "../scripts/mask-capture.mjs";
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

// --- Gaps found in review ------------------------------------------------------------------

const fullAddress = {
  delivery_address: {
    id: 987654,
    formatted_customer_address: "台北市信義區松仁路100號",
    district: "信義區",
    city: "台北市",
    title: "王小明的家",
    label: "Home",
    intercom: "B2",
    structure: "apartment",
    latitude: 25.03518,
    longitude: 121.56781,
  },
  addresses: [{ address_line4: "忠孝東路四段1巷2弄3號", is_selected: true }],
};

test("1. address objects are masked whole, whatever the field names", () => {
  const { masked } = maskCapture(fullAddress);
  const out = JSON.stringify(masked);
  for (const leak of ["松仁路", "信義區", "台北市", "王小明的家", "B2", "忠孝東路", "25.03518", "121.56781"]) {
    assert.ok(!out.includes(leak), `still contains ${leak}`);
  }
  assert.equal(masked.delivery_address.id, 987654);
  assert.equal(masked.addresses[0].is_selected, true);
});

test("1. redactForLog drops address objects whole", () => {
  const out = redactForLog({ order: { id: "x1" }, ...fullAddress });
  for (const leak of ["松仁路", "信義區", "王小明的家", "B2", "忠孝東路", "25.03518"]) {
    assert.ok(!out.includes(leak), `still contains ${leak}`);
  }
  assert.ok(out.includes("x1"));
  assert.ok(!redactForLog("delivery failed for 台北市信義區松仁路100號").includes("松仁路"));
});

test("2. coordinates in headers like customer-latitude are masked", () => {
  const { masked } = maskCapture({
    log: { entries: [{ request: { headers: [
      { name: "customer-latitude", value: "25.03518" },
      { name: "customer-longitude", value: "121.56781" },
    ] } }] },
  });
  const out = JSON.stringify(masked);
  assert.ok(!out.includes("25.03518"));
  assert.ok(!out.includes("121.56781"));
  assert.ok(!redactForLog({ "customer-latitude": "25.03518" }).includes("25.03518"));
});

test("3. tokens in the URL path and #fragment are masked", () => {
  const { masked } = maskCapture({
    a: `https://www.foodpanda.com.tw/reset/${JWT}?x=1`,
    b: "https://www.foodpanda.com.tw/login/callback#access_token=opaque123&state=ok",
  });
  assert.ok(!masked.a.includes(JWT));
  assert.ok(!masked.b.includes("opaque123"));
  assert.match(masked.b, /state=ok/);
});

test("4. url-encoded form bodies are masked field by field", () => {
  const { masked } = maskCapture({
    postData: { mimeType: "application/x-www-form-urlencoded", text: "email=ming%40example.com&password=hunter2&remember=1" },
  });
  const text = masked.postData.text;
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("ming"));
  assert.match(text, /remember=1/);
});

test("--check catches each gap even without the masking rules", () => {
  // detectLeaks looks at values only, so it catches what a field-name list would miss.
  const kinds = (data) => detectLeaks(data).map((l) => l.kind);
  assert.ok(kinds({ whatever: "台北市信義區松仁路100號" }).includes("address"));
  assert.ok(kinds({ x: [{ name: "customer-latitude", value: "25.03518" }] }).includes("coordinate"));
  assert.ok(kinds({ u: `https://x.test/reset/${JWT}` }).includes("token"));
  assert.ok(kinds({ u: "https://x.test/cb#access_token=opaque123" }).includes("secret field"));
  assert.ok(kinds({ body: "email=ming%40example.com&password=hunter2" }).includes("secret field"));
  assert.ok(kinds({ body: "email=ming%40example.com&password=hunter2" }).includes("email"));
});

test("--check fails on a complete unmasked fake order response", () => {
  const order = { ...checkoutBody, ...fullAddress };
  assert.ok(checkFixture(order).length > 0);
  // Simulate a fixture someone masked by hand and missed the home label in.
  const handMasked = { delivery_address: { title: "王小明的家", label: "[REDACTED]" } };
  assert.equal(detectLeaks(handMasked).length, 0, "no generic pattern for a free-text label");
  assert.ok(checkFixture(handMasked, order).length > 0, "--against still finds it");
});

test("--check passes on the masker's own output, including against the raw capture", () => {
  const raw = { ...har, extra: { ...checkoutBody, ...fullAddress } };
  const { masked } = maskCapture(raw);
  assert.deepEqual(checkFixture(masked, raw), []);
});
