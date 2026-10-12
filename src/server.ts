import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { FoodpandaClient } from "./foodpanda-client.js";
import { refreshTokenViaBrowser, persistToken } from "./token-manager.js";
import { getRegionConfig } from "./config.js";

export function createServer(client: FoodpandaClient): McpServer {
  const region = getRegionConfig();
  const server = new McpServer(
    {
      name: "foodpanda-mcp",
      version: "0.1.0",
    },
    {
      capabilities: { logging: {} },
    }
  );

  // --- search_restaurants ---
  server.registerTool(
    "search_restaurants",
    {
      title: "Search Restaurants",
      description:
        `Search for restaurants on ${region.countryLabel} near the configured delivery address (prices in ${region.currency}). Returns a list of matching restaurants with id (vendor code), name, cuisine, rating, delivery fee, estimated delivery time, and minimum order amount. Chain restaurants (e.g. 麥當勞, 肯德基) include chain_code, chain_name, and total_outlets fields. When total_outlets > 1, use list_outlets with the chain_code to see all branches.`,
      inputSchema: z.object({
        query: z.string().describe("Search query (e.g. '麥當勞', '便當', '珍珠奶茶')"),
        cuisine: z.string().optional().describe("Filter by cuisine type"),
        limit: z.number().optional().describe("Max number of results (default 10)"),
      }),
    },
    async ({ query, cuisine, limit }) => {
      try {
        const restaurants = await client.searchRestaurants(query, cuisine, limit);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(restaurants, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error searching restaurants: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- list_outlets ---
  server.registerTool(
    "list_outlets",
    {
      title: "List Chain Outlets",
      description:
        "List all outlet branches for a restaurant chain. Use the chain_code from search_restaurants results (only available when total_outlets > 1). Returns all outlets with their individual vendor codes, names, delivery fees, and distances so the user can pick a specific branch.",
      inputSchema: z.object({
        chain_code: z.string().describe("The chain_code from search results"),
      }),
    },
    async ({ chain_code }) => {
      try {
        const outlets = await client.getChainOutlets(chain_code);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(outlets, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing outlets: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- get_restaurant_details ---
  server.registerTool(
    "get_restaurant_details",
    {
      title: "Get Restaurant Details",
      description:
        "Get detailed information about a specific restaurant including address, opening hours, minimum order, and delivery info.",
      inputSchema: z.object({
        restaurant_id: z.string().describe("The vendor code (id) from search results"),
      }),
    },
    async ({ restaurant_id }) => {
      try {
        const details = await client.getRestaurantDetails(restaurant_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(details, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting restaurant details: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- get_menu ---
  server.registerTool(
    "get_menu",
    {
      title: "Get Menu",
      description:
        "Get the menu for a restaurant, organized by category. Returns a compact list with each item's code, name, price, and sold-out status. Use the item code when adding to cart. Items with has_options=true have choice groups (e.g. side, drink, sweetness, ice, add-ons), some of them required: call get_item_details to see them before add_to_cart.",
      inputSchema: z.object({
        restaurant_id: z.string().describe("The vendor code (id) from search results"),
      }),
    },
    async ({ restaurant_id }) => {
      try {
        const menu = await client.getMenu(restaurant_id);
        // Strip topping_groups to keep response compact
        const compact = menu.map((cat) => ({
          name: cat.name,
          items: cat.items.map((item) => ({
            code: item.code,
            name: item.name,
            price: item.price,
            description: item.description || undefined,
            is_sold_out: item.is_sold_out || undefined,
            has_options: item.is_customizable || undefined,
            variations:
              item.variations && item.variations.length > 1
                ? item.variations.map((v) => ({ id: v.id, price: v.price }))
                : undefined,
          })),
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(compact, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting menu: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- get_item_details ---
  server.registerTool(
    "get_item_details",
    {
      title: "Get Item Details",
      description:
        "Get full details for a menu item, including its choice groups (topping_groups): each group has quantity_minimum/quantity_maximum and options with id, name and extra price. Groups with quantity_minimum >= 1 are required. Pass the chosen option ids as topping_ids to add_to_cart. Ask the user which options they want rather than picking for them.",
      inputSchema: z.object({
        restaurant_id: z.string().describe("The vendor code (id) from search results"),
        item_code: z.string().describe("The item code from get_menu"),
        variation_id: z
          .string()
          .optional()
          .describe("Only for items get_menu lists with several variations (sizes); default is the first"),
      }),
    },
    async ({ restaurant_id, item_code, variation_id }) => {
      try {
        const { category, item } = await client.getItemDetails(restaurant_id, item_code, variation_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ category, ...item }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting item details: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- add_to_cart ---
  server.registerTool(
    "add_to_cart",
    {
      title: "Add to Cart",
      description:
        "Add one or more items to the cart. If items are from a different restaurant than the current cart, the cart is cleared first. Items with required choice groups need their options in topping_ids (see get_item_details); a missing or invalid choice is rejected with the allowed options, and the cart is left unchanged. Sends the full cart to foodpanda for price validation (no order is placed) and returns updated totals.",
      inputSchema: z.object({
        restaurant_id: z.string().describe("The vendor code (id) from search results"),
        items: z
          .array(
            z.object({
              item_id: z.string().describe("Item code from get_menu"),
              quantity: z.number().min(1).describe("Quantity to add"),
              variation_id: z
                .string()
                .optional()
                .describe("Variation id, only for items with several variations (default: the first)"),
              topping_ids: z
                .array(z.string())
                .optional()
                .describe("Option ids chosen from get_item_details topping_groups (one per required group, plus any add-ons)"),
              special_instructions: z
                .string()
                .optional()
                .describe("Special instructions for this item"),
            })
          )
          .describe("Items to add to cart"),
      }),
    },
    async ({ restaurant_id, items }) => {
      try {
        const cart = await client.addToCart(restaurant_id, items);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(cart, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error adding to cart: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- get_cart ---
  server.registerTool(
    "get_cart",
    {
      title: "Get Cart",
      description:
        "View the current in-memory cart contents including items, quantities, prices, delivery fee, service fee, and totals. Returns 'Cart is empty.' if no items have been added.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const cart = await client.getCart();
        if (!cart) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Cart is empty.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(cart, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error getting cart: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- remove_from_cart ---
  server.registerTool(
    "remove_from_cart",
    {
      title: "Remove from Cart",
      description: "Remove an item from the cart by its cart item ID (e.g. 'cart-1'). Re-calculates totals with remaining items.",
      inputSchema: z.object({
        cart_item_id: z.string().describe("The cart item ID to remove (e.g. 'cart-1', from get_cart results)"),
      }),
    },
    async ({ cart_item_id }) => {
      try {
        const cart = await client.removeFromCart(cart_item_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(cart, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error removing from cart: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- preview_order ---
  server.registerTool(
    "preview_order",
    {
      title: "Preview Order",
      description:
        "Preview the current cart as an order. Returns a summary of items, totals, delivery address, and available payment methods. IMPORTANT: After calling this, you MUST show the full summary to the user and ask them to explicitly confirm before calling place_order. Never place an order without user confirmation.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const preview = await client.previewOrder();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(preview, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error previewing order: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- place_order ---
  server.registerTool(
    "place_order",
    {
      title: "Place Order",
      description:
        "Place the current cart as an order. You MUST call preview_order first and get explicit user confirmation before calling this. Only 'payment_on_delivery' (Cash on Delivery) is supported. Credit card and GCash require browser-based payment flows that cannot be completed via MCP.",
      inputSchema: z.object({
        payment_method: z
          .string()
          .describe(
            "Payment method name — use 'payment_on_delivery' (Cash on Delivery). Credit card is not supported via MCP."
          ),
        delivery_instructions: z
          .string()
          .optional()
          .describe("Special delivery instructions (e.g. 'Leave at door', 'Ring doorbell')"),
      }),
    },
    async ({ payment_method, delivery_instructions }) => {
      try {
        const result = await client.placeOrder(payment_method, delivery_instructions);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error placing order: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // --- refresh_token ---
  server.registerTool(
    "refresh_token",
    {
      title: "Refresh Session Token",
      description:
        `Opens a browser window to ${region.webHost} so the user can log in to their ${region.countryLabel} account. Intercepts the session token from network requests and updates the server. Call this when: (1) other tools return a 'session token expired' or 'No session token configured' error, or (2) the user wants to switch accounts. The browser window is visible — the user logs in manually (handling any CAPTCHAs or MFA). Once logged in, the token is captured automatically and saved for future sessions. Needs FOODPANDA_HEADLESS=0 in this server's env (the default is headless, which has no window to log in through); the tool returns an error saying so instead of waiting.`,
      inputSchema: z.object({
        timeout: z
          .number()
          .optional()
          .describe(
            "How long to wait for login in seconds (default 120). Increase if the user needs more time."
          ),
      }),
    },
    async ({ timeout }) => {
      try {
        const timeoutSeconds = timeout ?? 120;
        const token = await refreshTokenViaBrowser(timeoutSeconds);

        // Update the in-memory client
        client.updateSessionToken(token);

        // Persist to disk for future sessions
        persistToken(token);

        // Show a masked preview of the token
        const masked =
          token.length > 16
            ? `${token.slice(0, 8)}...${token.slice(-8)}`
            : "****";

        return {
          content: [
            {
              type: "text" as const,
              text: `Token refreshed successfully (${masked}). You can now continue using other tools.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error refreshing token: ${(error as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
