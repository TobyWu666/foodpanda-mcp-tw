/**
 * One-time confirmation codes for the two-step order flow.
 *
 * prepare_order calls issue() with a snapshot of exactly what would be
 * submitted. place_order calls consume() with the snapshot rebuilt from the
 * current state; the order goes through only if the code is known, unused,
 * not expired, and the snapshot is unchanged.
 *
 * This module knows nothing about foodpanda's API. Callers build the
 * snapshot from their own state.
 */

import { createHash, randomBytes } from "node:crypto";
import type { PaymentMethodChoice } from "./payment-method.js";

export interface OrderSnapshotItem {
  product_id: number;
  variation_id: number;
  quantity: number;
  topping_ids: number[];
  special_instructions: string;
  total_price: number;
}

/** The delivery address as shown to the user, so an edited address is caught even if its id stays the same. */
export interface OrderSnapshotAddress {
  id: number;
  latitude: number;
  longitude: number;
  text: string;
}

export interface OrderSnapshot {
  /** Account the order is placed under; a different login invalidates the code. */
  customer_id: string;
  restaurant_id: string;
  items: OrderSnapshotItem[];
  subtotal: number;
  delivery_fee: number;
  service_fee: number;
  total: number;
  payment_method: PaymentMethodChoice;
  /** The saved instrument charged (e.g. the bound LINE Pay account), so rebinding voids the code. */
  payment_instrument_id?: string;
  address: OrderSnapshotAddress;
  delivery_instructions: string;
}

export type ConfirmationFailureReason =
  | "missing"
  | "unknown"
  | "used"
  | "expired"
  | "changed";

export class OrderConfirmationError extends Error {
  readonly code = "ORDER_CONFIRMATION_INVALID";

  constructor(
    readonly reason: ConfirmationFailureReason,
    message: string,
    /** For reason "changed": which parts of the order differ. */
    readonly changed: string[] = []
  ) {
    super(message);
    this.name = "OrderConfirmationError";
  }
}

export interface IssuedConfirmation {
  code: string;
  expires_at: string; // ISO 8601
  ttl_seconds: number;
}

export interface OrderGuardOptions {
  /** How long a code stays valid. Default 5 minutes. */
  ttlMs?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Code generator, injectable for tests. */
  generateCode?: () => string;
}

export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

// No 0/O/1/I/L so the code is easy to read back to a user.
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;

export function generateConfirmationCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function canonicalSnapshot(s: OrderSnapshot): OrderSnapshot {
  return {
    customer_id: s.customer_id,
    restaurant_id: s.restaurant_id,
    items: s.items
      .map((i) => ({
        product_id: i.product_id,
        variation_id: i.variation_id,
        quantity: i.quantity,
        topping_ids: [...i.topping_ids].sort((a, b) => a - b),
        special_instructions: i.special_instructions,
        total_price: i.total_price,
      }))
      .sort((a, b) => {
        const ka = JSON.stringify(a);
        const kb = JSON.stringify(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      }),
    subtotal: s.subtotal,
    delivery_fee: s.delivery_fee,
    service_fee: s.service_fee,
    total: s.total,
    payment_method: s.payment_method,
    payment_instrument_id: s.payment_instrument_id ?? "",
    address: {
      id: s.address.id,
      latitude: s.address.latitude,
      longitude: s.address.longitude,
      text: s.address.text,
    },
    delivery_instructions: s.delivery_instructions,
  };
}

/** Stable hash of an order snapshot. Item order and topping order do not matter. */
export function fingerprintOrder(s: OrderSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalSnapshot(s)))
    .digest("hex");
}

function diffSnapshots(a: OrderSnapshot, b: OrderSnapshot): string[] {
  const ca = canonicalSnapshot(a);
  const cb = canonicalSnapshot(b);
  const changed: string[] = [];
  if (ca.customer_id !== cb.customer_id) changed.push("account");
  if (ca.restaurant_id !== cb.restaurant_id) changed.push("restaurant");
  if (JSON.stringify(ca.items) !== JSON.stringify(cb.items)) changed.push("items");
  if (
    ca.subtotal !== cb.subtotal ||
    ca.delivery_fee !== cb.delivery_fee ||
    ca.service_fee !== cb.service_fee ||
    ca.total !== cb.total
  ) {
    changed.push("price");
  }
  if (ca.payment_method !== cb.payment_method || ca.payment_instrument_id !== cb.payment_instrument_id) {
    changed.push("payment_method");
  }
  if (JSON.stringify(ca.address) !== JSON.stringify(cb.address)) changed.push("address");
  if (ca.delivery_instructions !== cb.delivery_instructions) {
    changed.push("delivery_instructions");
  }
  return changed;
}

interface PendingConfirmation {
  code: string;
  snapshot: OrderSnapshot;
  fingerprint: string;
  expiresAt: number;
}

/**
 * Holds at most one pending confirmation. Issuing a new code replaces the
 * old one, and any cart change should call invalidate().
 */
export class OrderGuard {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private pending: PendingConfirmation | null = null;
  /** Codes already consumed or replaced, so we can say "used" instead of "unknown". */
  private retired = new Set<string>();

  constructor(options: OrderGuardOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
    if (!(this.ttlMs > 0)) throw new RangeError("ttlMs must be positive");
    this.now = options.now ?? Date.now;
    this.generateCode = options.generateCode ?? generateConfirmationCode;
  }

  issue(snapshot: OrderSnapshot): IssuedConfirmation {
    this.retirePending();
    const code = this.generateCode();
    const expiresAt = this.now() + this.ttlMs;
    this.pending = {
      code,
      snapshot: canonicalSnapshot(snapshot),
      fingerprint: fingerprintOrder(snapshot),
      expiresAt,
    };
    return {
      code,
      expires_at: new Date(expiresAt).toISOString(),
      ttl_seconds: Math.round(this.ttlMs / 1000),
    };
  }

  /**
   * Validate the code against the current order and mark it used.
   * The code is spent as soon as it validates, before the order is sent,
   * so a failed or retried checkout always needs a fresh prepare_order.
   * Throws OrderConfirmationError if anything is wrong.
   */
  consume(code: string | undefined | null, current: OrderSnapshot): void {
    const given = typeof code === "string" ? code.trim().toUpperCase() : "";
    if (!given) {
      throw new OrderConfirmationError(
        "missing",
        "A confirmation code is required. Call prepare_order, show the summary to the user, and pass its code after they agree."
      );
    }

    const pending = this.pending;
    if (!pending || pending.code !== given) {
      if (this.retired.has(given)) {
        throw new OrderConfirmationError(
          "used",
          "This confirmation code has already been used or replaced. Call prepare_order again."
        );
      }
      throw new OrderConfirmationError(
        "unknown",
        "Unknown confirmation code. Call prepare_order again."
      );
    }

    if (this.now() >= pending.expiresAt) {
      this.retirePending();
      throw new OrderConfirmationError(
        "expired",
        "The confirmation code has expired. Call prepare_order again and re-confirm with the user."
      );
    }

    if (fingerprintOrder(current) !== pending.fingerprint) {
      const changed = diffSnapshots(pending.snapshot, current);
      this.retirePending();
      throw new OrderConfirmationError(
        "changed",
        `The order changed since prepare_order (${changed.join(", ")}). ` +
          "Call prepare_order again and re-confirm with the user.",
        changed
      );
    }

    this.retirePending();
  }

  /** Drop any pending code. Call on every cart change, restaurant switch, re-login or token refresh. */
  invalidate(): void {
    this.retirePending();
  }

  hasPending(): boolean {
    return this.pending !== null && this.now() < this.pending.expiresAt;
  }

  private retirePending(): void {
    if (this.pending) this.retired.add(this.pending.code);
    this.pending = null;
  }
}

/**
 * Wording for the prepare_order / place_order tool descriptions. The code
 * only proves prepare_order ran; it cannot prove a human agreed, because the
 * agent sees the code. The real safeguard is the MCP client asking the user
 * before every place_order call, so place_order must never be auto-allowed.
 */
export const PREPARE_ORDER_DESCRIPTION_NOTE =
  "Returns the full order (items, options, quantities, subtotal, delivery fee, total, " +
  "payment method, delivery address) and a one-time confirmation code. You MUST show " +
  "all of this to the user and get their explicit agreement before calling place_order. " +
  "Never call place_order on the user's behalf without that agreement.";

export const PLACE_ORDER_DESCRIPTION_NOTE =
  "Submits a real order that will be charged. Only call this after the user has seen " +
  "the prepare_order summary in this conversation and explicitly agreed. Requires the " +
  "confirmation code from prepare_order; the code is single-use, expires, and is " +
  "rejected if the cart, prices, payment method or address changed. The code is spent " +
  "before the order is sent, so on any error call prepare_order again rather than retrying.";

/** For the README: what the code does not protect against. */
export const README_SAFETY_NOTE =
  "Never add place_order to your client's auto-approve / always-allow list. The " +
  "confirmation code stops stale or changed orders, but the agent can read the code, " +
  "so only your client's per-call approval prompt guarantees a human said yes.";
