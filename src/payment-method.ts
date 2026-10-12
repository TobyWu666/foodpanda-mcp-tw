/**
 * Payment methods this server is allowed to use.
 *
 * These are the agent-facing names only. The mapping to foodpanda's own
 * payment method identifiers comes from captured traffic and is wired in
 * by the checkout code, not here.
 */

export const SUPPORTED_PAYMENT_METHODS = ["linepay", "cash"] as const;

export type PaymentMethodChoice = (typeof SUPPORTED_PAYMENT_METHODS)[number];

export function isSupportedPaymentMethod(
  value: unknown
): value is PaymentMethodChoice {
  return (
    typeof value === "string" &&
    (SUPPORTED_PAYMENT_METHODS as readonly string[]).includes(value)
  );
}

/**
 * Thrown when a requested payment method is not one we support, or is not
 * available on the account. Never fall back to another method silently.
 */
export class UnsupportedPaymentMethodError extends Error {
  readonly code = "UNSUPPORTED_PAYMENT_METHOD";

  constructor(
    readonly requested: string,
    /** Supported methods that are actually available for this order, if known. */
    readonly available: readonly PaymentMethodChoice[] = SUPPORTED_PAYMENT_METHODS,
    /** Why the requested method cannot be used, when known (e.g. "no bound LINE Pay account"). */
    readonly reason?: string
  ) {
    const list = available.length > 0 ? available.join(", ") : "none";
    super(
      `Payment method "${requested}" is not supported${reason ? ` (${reason})` : ""}. ` +
        `Supported and available: ${list}. ` +
        `No other payment method was used.`
    );
    this.name = "UnsupportedPaymentMethodError";
  }
}

/**
 * Normalise and validate a payment method choice from tool input.
 * `available` narrows the allowed set to what the account can actually use.
 */
export function parsePaymentMethodChoice(
  input: unknown,
  available: readonly PaymentMethodChoice[] = SUPPORTED_PAYMENT_METHODS
): PaymentMethodChoice {
  const normalised =
    typeof input === "string" ? input.trim().toLowerCase() : String(input);
  if (!isSupportedPaymentMethod(normalised) || !available.includes(normalised)) {
    throw new UnsupportedPaymentMethodError(String(input), available);
  }
  return normalised;
}
