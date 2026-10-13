/**
 * How a failed place_order is reported, so a program in front of this server (an
 * approval hub such as mcp-check) can tell "nothing was sent" from "maybe ordered"
 * without guessing from the wording.
 *
 * placeOrder turns every failure from the moment checkout is sent into a
 * CheckoutStatusUnknownError (and sets the check-the-app lock). Any other error
 * was raised before checkout went out, so nothing was ordered.
 */

import { CheckoutStatusUnknownError } from "./tw-api.js";

/** Last line of a place_order error when checkout may have gone out. */
export const CHECKOUT_MAYBE_SENT = "[checkout_sent: unknown] The order may have been placed. Check the foodpanda app before ordering again.";
/** Last line of a place_order error raised before checkout was sent. */
export const CHECKOUT_NOT_SENT = "[checkout_sent: no] Nothing was sent to foodpanda. Call prepare_order again if the user still wants it.";

export function checkoutMayHaveBeenSent(error: unknown): boolean {
  return error instanceof CheckoutStatusUnknownError || (error as { code?: unknown } | null)?.code === "CHECKOUT_STATUS_UNKNOWN";
}

export function placeOrderFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const tail = checkoutMayHaveBeenSent(error) ? CHECKOUT_MAYBE_SENT : CHECKOUT_NOT_SENT;
  return {
    content: [{ type: "text" as const, text: `place_order result: ${message}\n${tail}` }],
    isError: true,
  };
}
