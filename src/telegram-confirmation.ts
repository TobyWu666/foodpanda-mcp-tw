/**
 * Asks the user on their phone, through their own Telegram bot, before an order is sent.
 *
 * The HTTP server sends the bot's owner a message with the order and two buttons, then
 * long-polls Telegram for the answer (outgoing requests only; nothing new is exposed).
 * Only a press of "確認下單" on that message, by the configured Telegram user, sends the
 * order. Each message carries a fresh random id, so an old or forwarded button does
 * nothing. Cancel, a timeout, a network error or anyone else's press means no.
 *
 * The AI client never sees any of this: the buttons travel between Telegram and this
 * computer only.
 */

import { randomBytes } from "node:crypto";
import type { SendConfirmationRequest, SendOutcome } from "./foodpanda-client.js";
import {
  CANCEL_BUTTON,
  CONFIRM_BUTTON,
  DEFAULT_CONFIRM_TIMEOUT_SECONDS,
  confirmationText,
  outcomeText,
  rateLimited,
  type SendConfirmer,
} from "./send-confirmation.js";

/** Calls a Telegram Bot API method; resolves with its `result`, rejects on any failure. */
export type TelegramCall = (method: string, params: Record<string, unknown>, timeoutMs: number) => Promise<any>;

/** Bot API over HTTPS. Errors never include the URL, which contains the bot token. */
export function telegramApi(botToken: string): TelegramCall {
  return async (method, params, timeoutMs) => {
    let resp: Response;
    try {
      resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`Telegram ${method}: request failed (${(err as Error).name})`);
    }
    const data = (await resp.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null;
    if (!data?.ok) throw new Error(`Telegram ${method}: HTTP ${resp.status} ${data?.description ?? ""}`.trim());
    return data.result;
  };
}

/** A Telegram user id: digits only. In a private chat with the bot it is also the chat id. */
export function parseTelegramUserId(value: string | undefined): number | null {
  const v = (value ?? "").trim();
  if (!/^[1-9][0-9]{0,15}$/.test(v)) return null;
  return Number(v);
}

export interface TelegramConfirmOptions {
  call: TelegramCall;
  userId: number;
  timeoutSeconds?: number;
  now?: () => number;
  /** Longest single getUpdates wait; Telegram allows up to 50. */
  pollSeconds?: number;
}

export function telegramSendConfirmation(options: TelegramConfirmOptions): SendConfirmer {
  const { call, userId } = options;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_CONFIRM_TIMEOUT_SECONDS;
  const pollSeconds = options.pollSeconds ?? 25;
  const now = options.now ?? Date.now;

  const ask = async (order: SendConfirmationRequest): Promise<boolean> => {
    const nonce = randomBytes(12).toString("hex");
    const yes = `ok:${nonce}`;
    const no = `no:${nonce}`;
    let messageId: number | undefined;
    const finish = async (text: string) => {
      if (messageId === undefined) return;
      await call("editMessageText", { chat_id: userId, message_id: messageId, text }, 10_000).catch(() => {});
    };

    try {
      // Skip anything pressed before this message existed.
      const pending: any[] = await call("getUpdates", { offset: -1, timeout: 0, allowed_updates: ["callback_query"] }, 10_000);
      let offset = pending.length > 0 ? pending[pending.length - 1].update_id + 1 : 0;

      const sent = await call(
        "sendMessage",
        {
          chat_id: userId,
          text: confirmationText(order),
          reply_markup: {
            inline_keyboard: [[
              { text: CANCEL_BUTTON, callback_data: no },
              { text: CONFIRM_BUTTON, callback_data: yes },
            ]],
          },
        },
        10_000
      );
      messageId = sent.message_id;

      const deadline = now() + timeoutSeconds * 1000;
      while (now() < deadline) {
        const wait = Math.max(1, Math.min(pollSeconds, Math.ceil((deadline - now()) / 1000)));
        const updates: any[] = await call(
          "getUpdates",
          { offset, timeout: wait, allowed_updates: ["callback_query"] },
          (wait + 10) * 1000
        );
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          const q = u.callback_query;
          if (!q) continue;
          const mine = q.from?.id === userId && q.message?.message_id === messageId;
          if (!mine || (q.data !== yes && q.data !== no)) {
            await call("answerCallbackQuery", { callback_query_id: q.id, text: "這個按鈕已失效" }, 10_000).catch(() => {});
            continue;
          }
          const confirmed = q.data === yes;
          await call(
            "answerCallbackQuery",
            { callback_query_id: q.id, text: confirmed ? "送出中" : "已取消" },
            10_000
          ).catch(() => {});
          await finish(confirmationText(order) + (confirmed ? "\n\n✅ 你已確認，正在送出。" : "\n\n❌ 已取消，沒有下單。"));
          if (confirmed) {
            // Acknowledge the update so the next poll does not see it again.
            await call("getUpdates", { offset, timeout: 0, allowed_updates: ["callback_query"] }, 10_000).catch(() => {});
          }
          return confirmed;
        }
      }
      await finish(confirmationText(order) + "\n\n⌛ 逾時，沒有下單。");
      return false;
    } catch (err) {
      console.error("foodpanda-mcp: Telegram confirmation failed:", (err as Error).message);
      await finish(confirmationText(order) + "\n\n⚠️ 連線出問題，沒有下單。");
      return false;
    }
  };

  return rateLimited(ask, now);
}

/** Sends the person the outcome after they confirmed (see outcomeText). Fire and forget. */
export function telegramOutcomeReporter(call: TelegramCall, userId: number): (outcome: SendOutcome) => void {
  return (outcome) => {
    call("sendMessage", { chat_id: userId, text: outcomeText(outcome) }, 10_000).catch((err) => {
      console.error("foodpanda-mcp: could not send the outcome to Telegram:", (err as Error).message);
    });
  };
}
