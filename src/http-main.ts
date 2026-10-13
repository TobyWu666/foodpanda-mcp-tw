#!/usr/bin/env node
/**
 * HTTP entry point: `foodpanda-mcp-http`. Same tools as the stdio server, plus a
 * dialog on this Mac before any order is sent (see send-confirmation.ts).
 *
 *   FOODPANDA_HTTP_TOKEN  required, at least 32 characters; clients send it as a Bearer token
 *   FOODPANDA_HTTP_PORT           default 3001
 *   FOODPANDA_HTTP_ALLOWED_HOSTS  the tunnel's host name(s), comma-separated, e.g. abc.trycloudflare.com
 *   FOODPANDA_TELEGRAM_BOT_TOKEN  with FOODPANDA_TELEGRAM_USER_ID: confirm orders on the phone in
 *   FOODPANDA_TELEGRAM_USER_ID    Telegram instead of in a Mac dialog (scripts/telegram-user-id.mjs finds the id)
 *
 * It always listens on 127.0.0.1 only; there is no setting to open it to the network.
 */

import { createClientFromEnv } from "./bootstrap.js";
import {
  LISTEN_HOST,
  MCP_PATH,
  REMOTE_PLACE_ORDER_NOTE,
  TELEGRAM_PLACE_ORDER_NOTE,
  createMcpHttpServer,
  parseAllowedHosts,
  tokenProblemForHttp,
} from "./http-server.js";
import { macSendConfirmation, type SendConfirmer } from "./send-confirmation.js";
import { parseTelegramUserId, telegramApi, telegramSendConfirmation } from "./telegram-confirmation.js";

const token = (process.env.FOODPANDA_HTTP_TOKEN || "").trim();
const problem = tokenProblemForHttp(token);
if (problem) {
  console.error(
    `Error: ${problem}.\n` +
      "  Make one with:  openssl rand -hex 32\n" +
      "  Keep it secret: anyone with it and the URL can use your foodpanda account."
  );
  process.exit(1);
}
const botToken = (process.env.FOODPANDA_TELEGRAM_BOT_TOKEN || "").trim();
const userIdText = (process.env.FOODPANDA_TELEGRAM_USER_ID || "").trim();
let confirmSend: SendConfirmer;
let placeOrderNote: string;
if (botToken || userIdText) {
  const userId = parseTelegramUserId(userIdText);
  if (!/^[0-9]+:[A-Za-z0-9_-]{30,}$/.test(botToken) || userId === null) {
    console.error(
      "Error: set both FOODPANDA_TELEGRAM_BOT_TOKEN (from @BotFather) and FOODPANDA_TELEGRAM_USER_ID (your numeric id),\n" +
        "  or neither to confirm orders in a Mac dialog instead."
    );
    process.exit(1);
  }
  confirmSend = telegramSendConfirmation({ call: telegramApi(botToken), userId });
  placeOrderNote = TELEGRAM_PLACE_ORDER_NOTE;
  console.error("foodpanda-mcp: orders are confirmed in Telegram");
} else {
  confirmSend = macSendConfirmation();
  placeOrderNote = REMOTE_PLACE_ORDER_NOTE;
  if (process.platform !== "darwin") {
    console.error("foodpanda-mcp: note: not macOS and no Telegram set, so place_order always refuses.");
  }
}

const port = Number(process.env.FOODPANDA_HTTP_PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Error: FOODPANDA_HTTP_PORT must be a port number.");
  process.exit(1);
}
let tunnelHosts: string[];
try {
  tunnelHosts = parseAllowedHosts(process.env.FOODPANDA_HTTP_ALLOWED_HOSTS);
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
if (process.env.FOODPANDA_HTTP_HOST) {
  console.error("foodpanda-mcp: note: FOODPANDA_HTTP_HOST is ignored; this server only listens on 127.0.0.1.");
}

const client = createClientFromEnv({ confirmSend });
const server = createMcpHttpServer({
  client,
  token,
  tunnelHosts,
  serverOptions: { placeOrderNote },
});

server.listen(port, LISTEN_HOST, () => {
  console.error(`foodpanda-mcp HTTP server on http://${LISTEN_HOST}:${port}${MCP_PATH}`);
  console.error(
    tunnelHosts.length > 0
      ? `foodpanda-mcp: accepting the tunnel host(s) ${tunnelHosts.join(", ")}`
      : "foodpanda-mcp: no FOODPANDA_HTTP_ALLOWED_HOSTS, so only requests from this computer get through (not a tunnel)."
  );
});
