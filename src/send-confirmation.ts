/**
 * Asks a person on this computer before an order is sent.
 *
 * Used by the HTTP server: a remote AI client (Grok Bot, for one) calls tools with no
 * approval step of its own and can read the confirmation code, so the code alone is no
 * safeguard there. On macOS a dialog shows what will be ordered; only pressing
 * "確認下單" sends it. Cancel, closing the dialog, a timeout, or any other platform
 * means no.
 */

import { execFile } from "node:child_process";
import type { SendConfirmationRequest } from "./foodpanda-client.js";

export const CONFIRM_BUTTON = "確認下單";
export const CANCEL_BUTTON = "取消";
export const DEFAULT_CONFIRM_TIMEOUT_SECONDS = 120;
/** At most this many dialogs per window, and only one open at a time, so a remote client cannot flood the screen. */
export const MAX_DIALOGS_PER_WINDOW = 5;
export const DIALOG_WINDOW_MS = 10 * 60 * 1000;
/** What the script prints for a confirm: ASCII, so the check does not depend on osascript's output encoding. */
const CONFIRMED = "CONFIRMED";

/** The dialog text: everything that decides what is charged and where it goes. */
export function confirmationText(order: SendConfirmationRequest): string {
  const lines = [
    `餐廳：${order.restaurant}`,
    ...order.items.map((i) => `・${i.name} × ${i.quantity}`),
    `總金額：${order.total} ${order.currency}`,
    `付款：${order.payment}`,
    `送到：${order.address}`,
  ];
  if (order.delivery_instructions) lines.push(`備註：${order.delivery_instructions}`);
  lines.push("", `按「${CONFIRM_BUTTON}」才會真的送出訂單並付款。`);
  return lines.join("\n");
}

/** Runs osascript with arguments (no shell); resolves with stdout, or null if it exited non-zero. */
export type OsascriptRunner = (args: string[], timeoutMs: number) => Promise<string | null>;

const runOsascript: OsascriptRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    execFile("/usr/bin/osascript", args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });

// The text is passed as an argument, never spliced into the script, so nothing in a
// restaurant or item name can change what the script does.
const DIALOG_SCRIPT = [
  "on run argv",
  `set r to display dialog (item 1 of argv) with title "foodpanda" buttons {"${CANCEL_BUTTON}", "${CONFIRM_BUTTON}"} ` +
    `default button "${CANCEL_BUTTON}" cancel button "${CANCEL_BUTTON}" with icon caution ` +
    "giving up after ((item 2 of argv) as integer)",
  'if gave up of r then return "timeout"',
  `if button returned of r is "${CONFIRM_BUTTON}" then return "${CONFIRMED}"`,
  'return "no"',
  "end run",
];

export interface MacConfirmOptions {
  timeoutSeconds?: number;
  platform?: NodeJS.Platform;
  run?: OsascriptRunner;
  now?: () => number;
}

export function macSendConfirmation(
  options: MacConfirmOptions = {}
): (order: SendConfirmationRequest) => Promise<boolean> {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_CONFIRM_TIMEOUT_SECONDS;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runOsascript;
  const now = options.now ?? Date.now;
  let open = false;
  let shown: number[] = [];
  return async (order) => {
    if (platform !== "darwin") {
      console.error("foodpanda-mcp: place_order refused: confirming an order needs the macOS dialog.");
      return false;
    }
    const t = now();
    shown = shown.filter((at) => t - at < DIALOG_WINDOW_MS);
    if (open || shown.length >= MAX_DIALOGS_PER_WINDOW) {
      console.error("foodpanda-mcp: place_order refused: a confirmation dialog is open or too many were shown recently.");
      return false;
    }
    shown.push(t);
    open = true;
    try {
      const args = DIALOG_SCRIPT.flatMap((line) => ["-e", line]);
      args.push(confirmationText(order), String(timeoutSeconds));
      const answer = await run(args, (timeoutSeconds + 10) * 1000);
      return answer === CONFIRMED;
    } finally {
      open = false;
    }
  };
}
