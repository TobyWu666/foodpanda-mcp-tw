import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FoodpandaClient } from "../src/foodpanda-client.js";
import { MCP_PATH, REMOTE_PLACE_ORDER_NOTE, createMcpHttpServer } from "../src/http-server.js";

const TOKEN = "t".repeat(40);

async function start() {
  const fp = new FoodpandaClient(null, 25.033964, 121.564468, {
    http: async () => {
      throw new Error("no network in this test");
    },
  });
  const server = createMcpHttpServer({
    client: fp,
    token: TOKEN,
    serverOptions: { placeOrderNote: REMOTE_PLACE_ORDER_NOTE },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}${MCP_PATH}`;
  return { server, url };
}

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

test("a short or missing token is refused at start", () => {
  const client = new FoodpandaClient(null, 0, 0, { http: async () => ({ status: 500, ok: false, text: "" }) });
  assert.throws(() => createMcpHttpServer({ client, token: "" }));
  assert.throws(() => createMcpHttpServer({ client, token: "short" }));
});

test("every request needs the bearer token", async () => {
  const { server, url } = await start();
  try {
    const post = (headers: Record<string, string>, target = url) =>
      fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(init),
      });
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ authorization: `Bearer ${"x".repeat(40)}` })).status, 401);
    assert.equal((await post({ authorization: TOKEN })).status, 401, "the Bearer prefix is required");
    assert.equal((await post({ authorization: `Bearer ${TOKEN}` }, url.replace(MCP_PATH, "/other"))).status, 404);
    assert.equal((await post({ authorization: `Bearer ${TOKEN}` })).status, 200);
  } finally {
    server.close();
  }
});

test("with the token, an MCP client sees the tools and place_order says it waits for the dialog", async () => {
  const { server, url } = await start();
  const mcp = new Client({ name: "test", version: "0" });
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      })
    );
    const tools = new Map((await mcp.listTools()).tools.map((t) => [t.name, t]));
    assert.ok(tools.has("prepare_order"));
    assert.ok(tools.get("place_order")!.description!.includes(REMOTE_PLACE_ORDER_NOTE));
  } finally {
    await mcp.close();
    server.close();
  }
});
