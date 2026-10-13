import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { FoodpandaClient } from "../src/foodpanda-client.js";

// No token: the client never talks to foodpanda in this test.
test("the one-step order tools are not offered, and the client refuses to check out", async () => {
  const fp = new FoodpandaClient(null, 25.033964, 121.564468);
  const server = createServer(fp);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("add_to_cart"));
    assert.ok(!names.includes("place_order"), "place_order must not be registered");
    assert.ok(!names.includes("preview_order"), "preview_order must not be registered");

    const quantitySchema = (await client.listTools()).tools.find((t) => t.name === "add_to_cart")!
      .inputSchema as any;
    const qty = quantitySchema.properties.items.items.properties.quantity;
    assert.equal(qty.type, "integer");
    assert.equal(qty.minimum, 1);
    assert.equal(qty.maximum, 50);

    await assert.rejects(fp.placeOrder("payment_on_delivery"), /disabled/);
    await assert.rejects(fp.previewOrder(), /disabled/);
  } finally {
    await client.close();
    await server.close();
  }
});
