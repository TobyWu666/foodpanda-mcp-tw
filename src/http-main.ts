#!/usr/bin/env node
/**
 * HTTP entry point: `foodpanda-mcp-http`. Same tools as the stdio server, plus a
 * dialog on this Mac before any order is sent (see send-confirmation.ts).
 *
 *   FOODPANDA_HTTP_TOKEN  required, at least 32 characters; clients send it as a Bearer token
 *   FOODPANDA_HTTP_PORT   default 3001
 *   FOODPANDA_HTTP_HOST   default 127.0.0.1 (this computer only)
 */

import { createClientFromEnv } from "./bootstrap.js";
import { MCP_PATH, REMOTE_PLACE_ORDER_NOTE, createMcpHttpServer, tokenProblemForHttp } from "./http-server.js";
import { macSendConfirmation } from "./send-confirmation.js";

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
if (process.platform !== "darwin") {
  console.error("foodpanda-mcp: note: not macOS, so there is no confirmation dialog and place_order always refuses.");
}

const port = Number(process.env.FOODPANDA_HTTP_PORT || 3001);
const host = process.env.FOODPANDA_HTTP_HOST || "127.0.0.1";

const client = createClientFromEnv({ confirmSend: macSendConfirmation() });
const server = createMcpHttpServer({ client, token, serverOptions: { placeOrderNote: REMOTE_PLACE_ORDER_NOTE } });

server.listen(port, host, () => {
  console.error(`foodpanda-mcp HTTP server on http://${host}:${port}${MCP_PATH}`);
});
