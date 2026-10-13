/**
 * The MCP server over Streamable HTTP, for AI clients that can only reach a URL
 * (Grok Bot's custom connectors, xAI's Remote MCP). It listens on this computer only;
 * a tunnel the user starts themselves is what makes it reachable from outside.
 *
 * Every request needs "Authorization: Bearer <FOODPANDA_HTTP_TOKEN>". All requests
 * share one FoodpandaClient (one login, one cart); each gets its own stateless MCP
 * server and transport.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FoodpandaClient } from "./foodpanda-client.js";
import { createServer, type CreateServerOptions } from "./server.js";

export const MCP_PATH = "/mcp";
export const MIN_TOKEN_LENGTH = 32;

export const REMOTE_PLACE_ORDER_NOTE =
  "On this server place_order also waits for the user to press 確認下單 in a dialog on the computer " +
  "running it; if nobody does, nothing is sent. Tell the user to watch for that dialog.";

export function tokenProblemForHttp(token: string | undefined): string | null {
  if (!token) return "FOODPANDA_HTTP_TOKEN is not set";
  if (token.length < MIN_TOKEN_LENGTH) return `FOODPANDA_HTTP_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`;
  return null;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), expected);
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export interface HttpServerOptions {
  client: FoodpandaClient;
  token: string;
  serverOptions?: CreateServerOptions;
}

export function createMcpHttpServer({ client, token, serverOptions }: HttpServerOptions): Server {
  const problem = tokenProblemForHttp(token);
  if (problem) throw new Error(problem);
  const expected = digest(token);

  return createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== MCP_PATH) return sendJson(res, 404, "Not found");
    if (!authorized(req, expected)) {
      res.setHeader("www-authenticate", "Bearer");
      return sendJson(res, 401, "Unauthorized");
    }
    if (req.method !== "POST") return sendJson(res, 405, "Method not allowed");

    const server = createServer(client, serverOptions);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("foodpanda-mcp: HTTP request failed:", (error as Error).message);
      if (!res.headersSent) sendJson(res, 500, "Internal server error");
    }
  });
}
