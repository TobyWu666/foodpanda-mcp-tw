/**
 * The MCP server over Streamable HTTP, for AI clients that can only reach a URL
 * (Grok Bot's custom connectors, xAI's Remote MCP). It listens on this computer only;
 * a tunnel the user starts themselves is what makes it reachable from outside.
 *
 * Every request needs "Authorization: Bearer <FOODPANDA_HTTP_TOKEN>", a Host header
 * naming this computer or a configured tunnel host, and no Origin other than those
 * (the SDK's DNS-rebinding protection; a request with no Origin, as from a server-side
 * client like Grok Bot, is fine). All requests share one FoodpandaClient (one login,
 * one cart); each gets its own stateless MCP server and transport.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FoodpandaClient } from "./foodpanda-client.js";
import { createServer, type CreateServerOptions } from "./server.js";

export const MCP_PATH = "/mcp";
export const MIN_TOKEN_LENGTH = 32;

export const TELEGRAM_PLACE_ORDER_NOTE =
  "On this server place_order also waits for the user to press 確認下單 on a message sent to their " +
  "phone in Telegram; if they do not, nothing is sent. Tell the user to check Telegram.";

export const REMOTE_PLACE_ORDER_NOTE =
  "On this server place_order also waits for the user to press 確認下單 in a dialog on the computer " +
  "running it; if nobody does, nothing is sent. Tell the user to watch for that dialog.";

/** Only this computer: a tunnel connects to it locally, and nothing else should. */
export const LISTEN_HOST = "127.0.0.1";

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Parses FOODPANDA_HTTP_ALLOWED_HOSTS: comma-separated tunnel host names, no scheme or port. */
export function parseAllowedHosts(value: string | undefined): string[] {
  const hosts = (value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of hosts) {
    if (!HOSTNAME.test(h)) {
      throw new Error(`FOODPANDA_HTTP_ALLOWED_HOSTS: "${h}" is not a host name (write it like abc.trycloudflare.com)`);
    }
  }
  return hosts;
}

/** Host headers and Origins accepted: this computer on the port, plus each tunnel host over https. */
export function allowedHostsAndOrigins(port: number, tunnelHosts: string[]) {
  const local = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return {
    hosts: [...local, ...tunnelHosts, ...tunnelHosts.map((h) => `${h}:443`)],
    origins: [...local.map((h) => `http://${h}`), ...tunnelHosts.map((h) => `https://${h}`)],
  };
}

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
  /** Tunnel host names allowed in Host and Origin (see parseAllowedHosts). */
  tunnelHosts?: string[];
  serverOptions?: CreateServerOptions;
}

export function createMcpHttpServer({ client, token, tunnelHosts = [], serverOptions }: HttpServerOptions): Server {
  const problem = tokenProblemForHttp(token);
  if (problem) throw new Error(problem);
  const expected = digest(token);

  const httpServer = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path !== MCP_PATH) return sendJson(res, 404, "Not found");
    if (!authorized(req, expected)) {
      res.setHeader("www-authenticate", "Bearer");
      return sendJson(res, 401, "Unauthorized");
    }
    if (req.method !== "POST") return sendJson(res, 405, "Method not allowed");

    // The port it actually listens on, so a listen on port 0 (tests) works too.
    const allowed = allowedHostsAndOrigins((httpServer.address() as AddressInfo).port, tunnelHosts);
    const server = createServer(client, serverOptions);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts: allowed.hosts,
      allowedOrigins: allowed.origins,
    });
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
  return httpServer;
}
