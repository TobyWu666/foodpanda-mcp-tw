#!/usr/bin/env node
/**
 * Prints the Telegram user id of whoever recently messaged your bot, for
 * FOODPANDA_TELEGRAM_USER_ID. Send your bot any message first, then run:
 *
 *   FOODPANDA_TELEGRAM_BOT_TOKEN=... node scripts/telegram-user-id.mjs
 *
 * The token is read from the environment only and never printed.
 */

const token = (process.env.FOODPANDA_TELEGRAM_BOT_TOKEN || "").trim();
if (!token) {
  console.error("Set FOODPANDA_TELEGRAM_BOT_TOKEN first.");
  process.exit(1);
}

let data;
try {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeout: 0, allowed_updates: ["message"] }),
  });
  data = await resp.json();
} catch (err) {
  console.error(`Could not reach Telegram (${err.name}).`);
  process.exit(1);
}
if (!data?.ok) {
  console.error(`Telegram said: ${data?.description ?? "error"} (is the token right?)`);
  process.exit(1);
}

const seen = new Map();
for (const u of data.result) {
  const from = u.message?.from;
  if (from && u.message.chat?.type === "private") seen.set(from.id, from.first_name ?? "");
}
if (seen.size === 0) {
  console.log("No messages yet. Open your bot in Telegram, send it any message, then run this again.");
} else {
  for (const [id, name] of seen) console.log(`${id}  ${name}`);
  console.log("Use your own id as FOODPANDA_TELEGRAM_USER_ID.");
}
