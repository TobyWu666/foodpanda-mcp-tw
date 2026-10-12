import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OrderGuard,
  OrderConfirmationError,
  fingerprintOrder,
  generateConfirmationCode,
  DEFAULT_CONFIRMATION_TTL_MS,
  type OrderSnapshot,
} from "../src/order-guard.js";

// Synthetic values only; no captured data.
function snapshot(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    customer_id: "cust01",
    restaurant_id: "test01",
    items: [
      {
        product_id: 1,
        variation_id: 10,
        quantity: 2,
        topping_ids: [100, 101],
        special_instructions: "",
        total_price: 200,
      },
      {
        product_id: 2,
        variation_id: 20,
        quantity: 1,
        topping_ids: [],
        special_instructions: "no ice",
        total_price: 50,
      },
    ],
    subtotal: 250,
    delivery_fee: 30,
    service_fee: 5,
    total: 285,
    payment_method: "cash",
    address: { id: 1, latitude: 25, longitude: 121.5, text: "Test Rd 1" },
    delivery_instructions: "",
    ...overrides,
  };
}

function setup(ttlMs = 60_000) {
  let clock = 1_000_000;
  let n = 0;
  const guard = new OrderGuard({
    ttlMs,
    now: () => clock,
    generateCode: () => `CODE${++n}`,
  });
  return {
    guard,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function rejects(fn: () => void, reason: string, changed?: string[]) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof OrderConfirmationError);
    assert.equal(err.reason, reason);
    if (changed) assert.deepEqual(err.changed, changed);
    return true;
  });
}

test("valid code with unchanged order is accepted once", () => {
  const { guard } = setup();
  const { code } = guard.issue(snapshot());
  guard.consume(code, snapshot());
  rejects(() => guard.consume(code, snapshot()), "used");
});

test("code is case and whitespace insensitive", () => {
  const { guard } = setup();
  guard.issue(snapshot());
  guard.consume("  code1 ", snapshot());
});

test("missing code is rejected", () => {
  const { guard } = setup();
  guard.issue(snapshot());
  rejects(() => guard.consume(undefined, snapshot()), "missing");
  rejects(() => guard.consume("", snapshot()), "missing");
  rejects(() => guard.consume("   ", snapshot()), "missing");
});

test("unknown code is rejected and does not spend the real one", () => {
  const { guard } = setup();
  const { code } = guard.issue(snapshot());
  rejects(() => guard.consume("WRONG", snapshot()), "unknown");
  guard.consume(code, snapshot());
});

test("consume without any prepare is rejected", () => {
  const { guard } = setup();
  rejects(() => guard.consume("CODE1", snapshot()), "unknown");
});

test("code expires at the TTL boundary", () => {
  const { guard, advance } = setup(60_000);
  const { code } = guard.issue(snapshot());
  advance(60_000);
  rejects(() => guard.consume(code, snapshot()), "expired");
  rejects(() => guard.consume(code, snapshot()), "used");
});

test("code is still valid just before the TTL", () => {
  const { guard, advance } = setup(60_000);
  const { code } = guard.issue(snapshot());
  advance(59_999);
  guard.consume(code, snapshot());
});

test("issue reports expiry and TTL", () => {
  const { guard } = setup(90_000);
  const issued = guard.issue(snapshot());
  assert.equal(issued.ttl_seconds, 90);
  assert.equal(issued.expires_at, new Date(1_000_000 + 90_000).toISOString());
});

test("default TTL is five minutes", () => {
  assert.equal(DEFAULT_CONFIRMATION_TTL_MS, 300_000);
  assert.equal(new OrderGuard().issue(snapshot()).ttl_seconds, 300);
});

test("non-positive TTL is refused", () => {
  assert.throws(() => new OrderGuard({ ttlMs: 0 }), RangeError);
  assert.throws(() => new OrderGuard({ ttlMs: -1 }), RangeError);
});

test("issuing a new code retires the previous one", () => {
  const { guard } = setup();
  const first = guard.issue(snapshot());
  const second = guard.issue(snapshot());
  rejects(() => guard.consume(first.code, snapshot()), "used");
  guard.consume(second.code, snapshot());
});

test("invalidate drops the pending code", () => {
  const { guard } = setup();
  const { code } = guard.issue(snapshot());
  assert.equal(guard.hasPending(), true);
  guard.invalidate();
  assert.equal(guard.hasPending(), false);
  rejects(() => guard.consume(code, snapshot()), "used");
});

const changes: Array<[string, Partial<OrderSnapshot>, string[]]> = [
  ["quantity", { items: [{ ...snapshot().items[0], quantity: 3 }, snapshot().items[1]] }, ["items"]],
  ["item removed", { items: [snapshot().items[0]] }, ["items"]],
  ["topping", { items: [{ ...snapshot().items[0], topping_ids: [100] }, snapshot().items[1]] }, ["items"]],
  ["item note", { items: [snapshot().items[0], { ...snapshot().items[1], special_instructions: "" }] }, ["items"]],
  ["restaurant", { restaurant_id: "test02" }, ["restaurant"]],
  ["total", { total: 286 }, ["price"]],
  ["delivery fee", { delivery_fee: 40, total: 295 }, ["price"]],
  ["payment method", { payment_method: "linepay" }, ["payment_method"]],
  ["account", { customer_id: "cust02" }, ["account"]],
  ["address id", { address: { ...snapshot().address, id: 2 } }, ["address"]],
  ["address text, same id", { address: { ...snapshot().address, text: "Test Rd 2" } }, ["address"]],
  ["address location, same id", { address: { ...snapshot().address, latitude: 25.01 } }, ["address"]],
  ["delivery note", { delivery_instructions: "ring bell" }, ["delivery_instructions"]],
];

for (const [label, overrides, expected] of changes) {
  test(`changed ${label} invalidates the code`, () => {
    const { guard } = setup();
    const { code } = guard.issue(snapshot());
    rejects(() => guard.consume(code, snapshot(overrides)), "changed", expected);
    // Spent after a mismatch, even if the order is changed back.
    rejects(() => guard.consume(code, snapshot()), "used");
  });
}

test("item order and topping order do not affect the fingerprint", () => {
  const base = snapshot();
  const reordered = snapshot({
    items: [
      base.items[1],
      { ...base.items[0], topping_ids: [101, 100] },
    ],
  });
  assert.equal(fingerprintOrder(base), fingerprintOrder(reordered));
  const { guard } = setup();
  const { code } = guard.issue(base);
  guard.consume(code, reordered);
});

test("mutating the snapshot after issue does not affect validation", () => {
  const { guard } = setup();
  const s = snapshot();
  const { code } = guard.issue(s);
  s.items[0].quantity = 99;
  s.items[0].topping_ids.push(999);
  guard.consume(code, snapshot());
});

test("generated codes are 8 unambiguous characters and vary", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = generateConfirmationCode();
    assert.match(c, /^[2-9A-HJKMNP-Z]{8}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 190);
});

