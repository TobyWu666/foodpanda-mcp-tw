import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIRM_BUTTON, MAX_DIALOGS_PER_WINDOW, DIALOG_WINDOW_MS, confirmationText, macSendConfirmation } from "../src/send-confirmation.js";

const order = {
  restaurant: "測試餐廳",
  items: [{ name: '雞腿飯 "大"', quantity: 2 }],
  total: 366,
  currency: "TWD",
  payment: "LINE Pay",
  address: "台北市測試路 1 號",
  delivery_instructions: "放門口",
};

test("the dialog text shows what is ordered, the total, payment and address", () => {
  const text = confirmationText(order);
  for (const part of ["測試餐廳", '雞腿飯 "大" × 2', "366 TWD", "LINE Pay", "台北市測試路 1 號", "放門口", CONFIRM_BUTTON]) {
    assert.ok(text.includes(part), part);
  }
});

test("only the confirm button says yes; cancel, timeout and other platforms say no", async () => {
  const seen: string[][] = [];
  const answer = (out: string | null) =>
    macSendConfirmation({ platform: "darwin", run: async (args) => (seen.push(args), out) });

  // The script compares the button inside AppleScript and prints ASCII, so encoding cannot matter.
  assert.equal(await answer("CONFIRMED")(order), true);
  assert.equal(await answer(null)(order), false, "cancel exits non-zero");
  assert.equal(await answer("timeout")(order), false);
  assert.equal(await answer("no")(order), false);
  assert.equal(await answer("確認下單")(order), false, "only the script's own marker counts");

  // The order text is its own argument, never part of the script.
  const args = seen[0];
  assert.equal(args.at(-2), confirmationText(order));
  assert.equal(args.at(-1), "120");
  const script = args.filter((_, i) => args[i - 1] === "-e").join("\n");
  assert.ok(!script.includes("雞腿飯"));

  let ran = false;
  const linux = macSendConfirmation({ platform: "linux", run: async () => ((ran = true), "CONFIRMED") });
  assert.equal(await linux(order), false);
  assert.equal(ran, false);
});

test("one dialog at a time, and at most a few per window", async () => {
  let t = 0;
  let release: (() => void) | undefined;
  let runs = 0;
  const confirm = macSendConfirmation({
    platform: "darwin",
    now: () => t,
    run: async () => {
      runs++;
      if (runs === 1) await new Promise<void>((r) => (release = r));
      return "no";
    },
  });

  const first = confirm(order);
  await new Promise((r) => setImmediate(r));
  assert.equal(await confirm(order), false, "a second dialog while one is open is refused");
  assert.equal(runs, 1);
  release!();
  assert.equal(await first, false);

  for (let i = 1; i < MAX_DIALOGS_PER_WINDOW; i++) await confirm(order);
  assert.equal(runs, MAX_DIALOGS_PER_WINDOW);
  assert.equal(await confirm(order), false);
  assert.equal(runs, MAX_DIALOGS_PER_WINDOW, "over the limit, no dialog is shown");

  t += DIALOG_WINDOW_MS;
  await confirm(order);
  assert.equal(runs, MAX_DIALOGS_PER_WINDOW + 1, "the window slides");
});
