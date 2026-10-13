import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTelegramUserId,
  telegramOutcomeReporter,
  telegramSendConfirmation,
  type TelegramCall,
} from "../src/telegram-confirmation.js";
import { outcomeText } from "../src/send-confirmation.js";

const ME = 123456789;
const order = {
  restaurant: "測試餐廳",
  items: [{ name: "雞腿飯", quantity: 1 }],
  total: 120,
  currency: "TWD",
  payment: "貨到付款",
  address: "台北市測試路 1 號",
  delivery_instructions: "",
};

/**
 * A stand-in for the Bot API. `presses` decides what the person does once the message
 * exists: each entry is [from user id, which button or a raw callback_data].
 */
function fakeTelegram(presses: Array<[number, "yes" | "no" | string]>, opts: { failSend?: boolean } = {}) {
  const calls: Array<{ method: string; params: any }> = [];
  let clock = 0;
  let nextUpdate = 500;
  let keyboard: any;
  const queue = [...presses];
  const call: TelegramCall = async (method, params: any) => {
    calls.push({ method, params });
    switch (method) {
      case "sendMessage":
        if (opts.failSend) throw new Error("Telegram sendMessage: HTTP 401 Unauthorized");
        keyboard = params.reply_markup.inline_keyboard[0];
        return { message_id: 77 };
      case "getUpdates": {
        if (params.offset === -1) return [{ update_id: 499 }]; // an old press, skipped
        clock += (params.timeout ?? 0) * 1000;
        const p = queue.shift();
        if (!p) return [];
        const [from, which] = p;
        const data = which === "yes" ? keyboard[1].callback_data : which === "no" ? keyboard[0].callback_data : which;
        return [{ update_id: nextUpdate++, callback_query: { id: `q${nextUpdate}`, from: { id: from }, data, message: { message_id: 77 } } }];
      }
      default:
        return true;
    }
  };
  return { call, calls, now: () => clock };
}

test("telegram user ids are digits only", () => {
  assert.equal(parseTelegramUserId("123456789"), 123456789);
  for (const bad of [undefined, "", "0", "-100123", "12a", "@toby"]) assert.equal(parseTelegramUserId(bad), null, String(bad));
});

test("only the owner's press of 確認下單 on this message says yes", async () => {
  const t = fakeTelegram([[ME, "yes"]]);
  const confirm = telegramSendConfirmation({ call: t.call, userId: ME, now: t.now });
  assert.equal(await confirm(order), true);

  const sent = t.calls.find((c) => c.method === "sendMessage")!.params;
  assert.equal(sent.chat_id, ME);
  assert.match(sent.text, /測試餐廳/);
  assert.match(sent.text, /120 TWD/);
  assert.deepEqual(
    sent.reply_markup.inline_keyboard[0].map((b: any) => b.text),
    ["取消", "確認下單"]
  );
  // Polling started after the old update, and the message was updated afterwards.
  const polls = t.calls.filter((c) => c.method === "getUpdates" && c.params.offset !== -1);
  assert.equal(polls[0].params.offset, 500);
  const edit = t.calls.find((c) => c.method === "editMessageText")!.params;
  assert.match(edit.text, /已確認/);
  assert.equal(edit.reply_markup, undefined, "the buttons are removed");
});

test("cancel, someone else's press, an old button, a timeout or a failure all say no", async () => {
  {
    const t = fakeTelegram([[ME, "no"]]);
    assert.equal(await telegramSendConfirmation({ call: t.call, userId: ME, now: t.now })(order), false);
    assert.match(t.calls.find((c) => c.method === "editMessageText")!.params.text, /已取消/);
  }
  {
    // A stranger and a stale button are ignored; nothing else comes, so it times out.
    const t = fakeTelegram([[999, "yes"], [ME, "ok:000000000000000000000000"]]);
    const confirm = telegramSendConfirmation({ call: t.call, userId: ME, now: t.now, timeoutSeconds: 60, pollSeconds: 25 });
    assert.equal(await confirm(order), false);
    const answers = t.calls.filter((c) => c.method === "answerCallbackQuery");
    assert.equal(answers.length, 2);
    assert.ok(answers.every((a) => a.params.text === "這個按鈕已失效"));
    assert.match(t.calls.find((c) => c.method === "editMessageText")!.params.text, /逾時/);
  }
  {
    const t = fakeTelegram([[ME, "yes"]], { failSend: true });
    assert.equal(await telegramSendConfirmation({ call: t.call, userId: ME, now: t.now })(order), false);
  }
});

test("the outcome goes to the owner as a new message, and a Telegram failure is swallowed", async () => {
  const sent: any[] = [];
  const outcome = { kind: "error" as const, checkoutSent: true, message: "status unknown" };
  telegramOutcomeReporter(async (method, params) => (sent.push({ method, params }), {}), ME)(outcome);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [{ method: "sendMessage", params: { chat_id: ME, text: outcomeText(outcome) } }]);

  telegramOutcomeReporter(async () => {
    throw new Error("down");
  }, ME)(outcome);
  await new Promise((r) => setImmediate(r));
});
