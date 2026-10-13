import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { FoodpandaClient } from "../src/foodpanda-client.js";
import { PLACE_ORDER_DESCRIPTION_NOTE, PREPARE_ORDER_DESCRIPTION_NOTE } from "../src/order-guard.js";

// No token and no network: the client never talks to foodpanda in this test.
test("ordering is only the two-step flow, and the tools say so", async () => {
  const fp = new FoodpandaClient(null, 25.033964, 121.564468, {
    http: async () => {
      throw new Error("no network in this test");
    },
  });
  const server = createServer(fp);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  try {
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["list_payment_methods", "prepare_order", "place_order"]) {
      assert.ok(byName.has(name), `${name} is offered`);
    }
    assert.ok(!byName.has("preview_order"), "the one-step preview is gone");

    const prepare = byName.get("prepare_order")!;
    assert.ok(prepare.description!.includes(PREPARE_ORDER_DESCRIPTION_NOTE));
    const place = byName.get("place_order")!;
    assert.ok(place.description!.includes(PLACE_ORDER_DESCRIPTION_NOTE));
    const placeSchema = place.inputSchema as any;
    assert.deepEqual(Object.keys(placeSchema.properties), ["confirmation_code"]);
    assert.deepEqual(placeSchema.required, ["confirmation_code"]);

    const qty = (byName.get("add_to_cart")!.inputSchema as any).properties.items.items.properties.quantity;
    assert.equal(qty.type, "integer");
    assert.equal(qty.minimum, 1);
    assert.equal(qty.maximum, 50);

    // With no prepared order, place_order refuses before anything is sent.
    const res: any = await client.callTool({ name: "place_order", arguments: { confirmation_code: "ABCDEFGH" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Unknown confirmation code/);
  } finally {
    await client.close();
    await server.close();
  }
});
