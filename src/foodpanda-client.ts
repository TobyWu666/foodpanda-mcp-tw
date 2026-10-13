import type {
  Restaurant,
  RestaurantDetails,
  MenuCategory,
  MenuItem,
  Cart,
  CartItem,
  OrderResult,
  AddToCartInput,
  CartProductPayload,
  CartVendorPayload,
  ToppingGroup,
  CustomerProfile,
  DeliveryAddress,
  PaymentMethodInfo,
  OrderPreview,
} from "./types.js";

import { getRegionConfig, requireHash } from "./config.js";
import { browserTransport } from "./browser-transport.js";
import { redactForLog } from "./redact.js";
import {
  type GraphqlOperation,
  type RestaurantPage,
  buildCalculateRequest,
  buildCartProduct,
  cartItemsOf,
  chainOutletsOperation,
  parseCalculate,
  parseChainOutlets,
  parseProductChoices,
  parseRestaurantPage,
  parseSearchResults,
  productOperation,
  restaurantDetailsOperation,
  searchOperation,
  selectChoices,
  checkQuantity,
} from "./tw-api.js";

/** Checkout must name the right entity; never fall back to another country's id. */
function requireGlobalEntityId(): string {
  const cfg = getRegionConfig();
  if (!cfg.globalEntityId) {
    throw new Error(
      `No x-global-entity-id configured for ${cfg.countryLabel}. Set FOODPANDA_GLOBAL_ENTITY_ID.`
    );
  }
  return cfg.globalEntityId;
}

/** A restaurant page (details + menu) kept so cart payloads can be built without refetching. */
interface CachedVendorMenu extends RestaurantPage {
  productsByCode: Map<string, MenuItem>;
  productsById: Map<number, MenuItem>;
  /** Choice groups per `${productId}:${variationId}`, loaded on demand. */
  choiceGroups: Map<string, ToppingGroup[]>;
  cachedAt: number;
}

/** Menus change during the day (breakfast/regular menus); refetch after this long. */
const MENU_CACHE_MS = 10 * 60 * 1000;

/**
 * The upstream one-step checkout is switched off: with the tw cart working it
 * could send a real order with no confirmation code. Stage 4 replaces it with
 * the two-step prepare_order / place_order.
 */
const LEGACY_CHECKOUT_DISABLED =
  "Ordering is disabled until the two-step prepare_order / place_order flow is in place.";

export class FoodpandaClient {
  private sessionToken: string | null;
  private latitude: number;
  private longitude: number;
  private customerCode: string;
  private perseusClientId: string;
  private perseusSessionId: string;

  // In-memory cart state (foodpanda cart is stateless / server recalculates)
  private cartProducts: CartProductPayload[] = [];
  private cartItemIds: string[] = []; // stable IDs aligned with cartProducts
  private cartVendor: CartVendorPayload | null = null;
  private cartVendorName: string = "";
  private cartItems: CartItem[] = [];
  private cartSubtotal: number = 0;
  private cartDeliveryFee: number = 0;
  private cartServiceFee: number = 0;
  private cartTotal: number = 0;
  private nextCartItemId: number = 1;

  // Menu cache keyed by vendor code
  private menuCache: Map<string, CachedVendorMenu> = new Map();

  constructor(sessionToken: string | null, latitude: number, longitude: number) {
    this.sessionToken = sessionToken;
    this.latitude = latitude;
    this.longitude = longitude;
    this.customerCode = sessionToken ? this.extractCustomerCode(sessionToken) : "";

    // Generate Perseus tracking IDs (required by GraphQL endpoint)
    const ts = Date.now();
    const rand1 = Math.random().toString().slice(2, 20);
    const rand2 = Math.random().toString(36).slice(2, 12);
    this.perseusClientId = `${ts}.${rand1}.${rand2}`;
    const rand3 = Math.random().toString().slice(2, 20);
    const rand4 = Math.random().toString(36).slice(2, 12);
    this.perseusSessionId = `${ts}.${rand3}.${rand4}`;
  }

  /**
   * Decode the JWT payload to extract user_id (customer code).
   * JWT format: header.payload.signature — payload is base64url-encoded JSON.
   */
  private extractCustomerCode(token: string): string {
    try {
      const parts = token.split(".");
      if (parts.length < 2) return "";
      // base64url -> base64
      let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      // pad to multiple of 4
      while (payload.length % 4 !== 0) payload += "=";
      const decoded = JSON.parse(Buffer.from(payload, "base64").toString());
      return decoded.user_id || "";
    } catch {
      return "";
    }
  }

  /**
   * Hot-swap the session token (e.g. after a browser-based refresh).
   * Re-extracts the customer code from the new JWT.
   */
  public updateSessionToken(token: string): void {
    this.sessionToken = token;
    this.customerCode = this.extractCustomerCode(token);
  }

  // ----------------------------------------------------------------
  // HTTP helpers
  // ----------------------------------------------------------------

  private commonHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "x-fp-api-key": "volo",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      "perseus-client-id": this.perseusClientId,
      "perseus-session-id": this.perseusSessionId,
    };

    // Browsing (search, menus, vendor details) is public: the storefront itself calls these
    // endpoints before anyone logs in. Only cart and checkout need the bearer token, so a
    // missing token is no longer a hard failure — the API answers per endpoint.
    if (this.sessionToken) {
      headers.Authorization = `Bearer ${this.sessionToken}`;
    }
    return headers;
  }

  /**
   * Single choke point for HTTP. Either a plain fetch, or a request issued from
   * the persistent browser context (which carries PerimeterX + login cookies).
   */
  /**
   * PerimeterX also rate-limits the API host: a burst of calls gets challenged even from a
   * warm session. Space requests out (FOODPANDA_MIN_INTERVAL_MS) so a normal ordering
   * sequence — a search or two, menus, cart — stays under the radar.
   */
  private lastRequestAt = 0;

  private async throttle(): Promise<void> {
    const min = parseInt(process.env.FOODPANDA_MIN_INTERVAL_MS || "2000", 10);
    if (!Number.isFinite(min) || min <= 0) return;
    const wait = this.lastRequestAt + min - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async httpRequest(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<{ status: number; ok: boolean; text: string }> {
    await this.throttle();
    const cfg = getRegionConfig();
    if (!cfg.browserTransport) {
      const res = await fetch(url, {
        method: init.method || "GET",
        headers: init.headers,
        body: init.body,
      });
      const text = await res.text().catch(() => "");
      return { status: res.status, ok: res.ok, text };
    }
    const transport = browserTransport();
    await transport.warmUp();
    // GETs (the REST endpoints: vendor details, menus, addresses) must come from the page —
    // that is the only origin PerimeterX accepts them from. POSTs (GraphQL search) work from
    // the context's request API. Override with FOODPANDA_FETCH_MODE=page|context.
    const mode = (process.env.FOODPANDA_FETCH_MODE || "auto").toLowerCase();
    const method = (init.method || "GET").toUpperCase();
    const usePage = mode === "page" || (mode === "auto" && method === "GET");
    return usePage ? transport.fetchViaPage(url, init) : transport.fetch(url, init);
  }

  /** Turn the PerimeterX wall into an actionable error instead of a bogus 401. */
  private assertNotPerimeterX(url: string, status: number, text: string): void {
    if (
      status === 403 &&
      /px-captcha|Access to this page has been denied|"appId"/.test(text)
    ) {
      throw new Error(
        `PerimeterX blocked ${url} (HTTP 403, px-captcha): foodpanda refuses this ` +
          `network/IP for API traffic. Set FOODPANDA_BROWSER_TRANSPORT=1 (default) and run ` +
          `from a network foodpanda serves, or reuse a browser profile that already passed the challenge.`
      );
    }
  }

  /**
   * PerimeterX can re-challenge mid-session after a burst of calls. When that happens the
   * profile is poisoned, so the only way back is a clean identity: wipe, re-warm, retry once.
   */
  private async withPerimeterXRetry<T>(operation: () => Promise<T>): Promise<T> {
    const baseMs = parseInt(process.env.FOODPANDA_PX_BACKOFF_MS || "45000", 10);
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        if (!/PerimeterX blocked/.test((err as Error).message)) throw err;
        if (attempt === maxAttempts) break;

        // The escalation is time-based: a burst of calls gets challenged even from a warm
        // session, and hammering it re-trips the rule. Wait longer each time, and come back
        // with a clean browser identity.
        const pauseMs = baseMs * attempt;
        console.error(
          `foodpanda-mcp: PerimeterX re-challenged — waiting ${Math.round(pauseMs / 1000)}s ` +
            `(attempt ${attempt}/${maxAttempts - 1}), then resetting the profile and retrying`
        );
        await new Promise((r) => setTimeout(r, pauseMs));
        const transport = browserTransport();
        await transport.resetProfile();
        await transport.warmUp(3);
      }
    }
    throw lastError;
  }

  private async restRequest<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    return this.withPerimeterXRetry(() => this.restRequestOnce<T>(path, options));
  }

  private async graphqlRequest<T>(op: GraphqlOperation): Promise<T> {
    return this.withPerimeterXRetry(() => this.graphqlRequestOnce<T>(op));
  }

  private async restRequestOnce<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const cfg = getRegionConfig();
    const url = `${cfg.apiBase}${path}`;
    const method = typeof options.method === "string" ? options.method : "GET";
    const result = await this.httpRequest(url, {
      method,
      body: typeof options.body === "string" ? options.body : undefined,
      headers: {
        ...this.commonHeaders(),
        ...(cfg.languageId !== null ? { "x-pd-language-id": String(cfg.languageId) } : {}),
        // Never set Content-Type on a GET: it turns the request into a CORS preflight, and
        // the storefront's API rejects our OPTIONS ("Failed to fetch" inside the page).
        ...(method === "GET" ? {} : { "Content-Type": "application/json" }),
        ...((options.headers as Record<string, string>) || {}),
      },
    });

    this.assertNotPerimeterX(url, result.status, result.text);

    if (result.status === 401 || result.status === 403) {
      throw new Error(
        "Session token expired or invalid. Please call the refresh_token tool to log in again."
      );
    }
    if (!result.ok) {
      throw new Error(
        `Foodpanda API error (${result.status}): ${redactForLog(result.text).slice(0, 500)}`
      );
    }
    return JSON.parse(result.text) as T;
  }

  private async graphqlRequestOnce<T>(op: GraphqlOperation): Promise<T> {
    const cfg = getRegionConfig();
    const url = `${cfg.apiBase}/graphql`;
    const result = await this.httpRequest(url, {
      method: "POST",
      headers: {
        ...this.commonHeaders(),
        "Content-Type": "application/json",
        "customer-code": this.customerCode,
        "customer-latitude": String(this.latitude),
        "customer-longitude": String(this.longitude),
        "display-context": op.displayContext,
        "x-apollo-operation-name": op.name,
        "apollographql-client-name": "web",
        platform: "web",
        "x-platform": "web",
        locale: cfg.locale,
        ...(cfg.languageId !== null ? { "x-pd-language-id": String(cfg.languageId) } : {}),
        ...(cfg.globalEntityId ? { "x-global-entity-id": cfg.globalEntityId } : {}),
      },
      body: JSON.stringify(op.body),
    });

    this.assertNotPerimeterX(url, result.status, result.text);

    if (result.status === 401 || result.status === 403) {
      throw new Error(
        "Session token expired or invalid. Please call the refresh_token tool to log in again."
      );
    }
    if (!result.ok) {
      throw new Error(
        `Foodpanda GraphQL error (${result.status}): ${redactForLog(result.text).slice(0, 500)}`
      );
    }
    const parsed = JSON.parse(result.text) as { data?: unknown; errors?: Array<{ message?: string }> };
    if (parsed.errors?.length && !parsed.data) {
      const messages = parsed.errors.map((e) => e.message || "unknown error").join("; ");
      if (/PersistedQueryNotFound/i.test(messages)) {
        throw new Error(
          `foodpanda no longer knows the ${op.name} query hash (its web app was probably updated). ` +
            "Harvest the new hash with scripts/discover-hashes.mjs and set the matching FOODPANDA_GQL_* env var."
        );
      }
      throw new Error(`Foodpanda GraphQL error in ${op.name}: ${redactForLog(messages).slice(0, 500)}`);
    }
    return parsed as T;
  }

  private where() {
    const cfg = getRegionConfig();
    return {
      latitude: this.latitude,
      longitude: this.longitude,
      locale: cfg.locale,
      languageId: cfg.languageId,
    };
  }

  // ----------------------------------------------------------------
  // 1. Search Restaurants
  // ----------------------------------------------------------------

  async searchRestaurants(
    query: string,
    cuisine?: string,
    limit?: number
  ): Promise<Restaurant[]> {
    const result = await this.graphqlRequest<unknown>(
      searchOperation(requireHash("search"), query, this.where())
    );
    let restaurants = parseSearchResults(result);

    // Client-side cuisine filter
    if (cuisine) {
      const cuisineLower = cuisine.toLowerCase();
      restaurants = restaurants.filter((r) =>
        r.cuisine.some((c) => c.toLowerCase().includes(cuisineLower))
      );
    }

    return restaurants.slice(0, limit ?? 10);
  }

  // ----------------------------------------------------------------
  // 1b. List Chain Outlets
  // ----------------------------------------------------------------

  async getChainOutlets(chainCode: string): Promise<Restaurant[]> {
    const result = await this.graphqlRequest<unknown>(
      chainOutletsOperation(requireHash("vendor_list"), chainCode, this.where())
    );
    return parseChainOutlets(result);
  }

  // ----------------------------------------------------------------
  // 2. Get Restaurant Details / 3. Get Menu
  // ----------------------------------------------------------------

  /** One GetRestaurantDetailsPage call gives both the details and the menu; cached per vendor. */
  private async loadRestaurant(vendorCode: string, fresh = false): Promise<CachedVendorMenu> {
    const cached = this.menuCache.get(vendorCode);
    if (cached && !fresh && Date.now() - cached.cachedAt < MENU_CACHE_MS) return cached;

    const result = await this.graphqlRequest<unknown>(
      restaurantDetailsOperation(requireHash("restaurant_details"), vendorCode)
    );
    const page = parseRestaurantPage(result);
    const productsByCode = new Map<string, MenuItem>();
    const productsById = new Map<number, MenuItem>();
    for (const cat of page.categories) {
      for (const item of cat.items) {
        productsByCode.set(item.code, item);
        productsById.set(item.id, item);
      }
    }
    const entry: CachedVendorMenu = {
      ...page,
      productsByCode,
      productsById,
      choiceGroups: new Map(),
      cachedAt: Date.now(),
    };
    this.menuCache.set(vendorCode, entry);
    if (page.details.id !== vendorCode) this.menuCache.set(page.details.id, entry);
    return entry;
  }

  async getRestaurantDetails(vendorCode: string): Promise<RestaurantDetails> {
    // Opening state matters (preview checks it), so always ask foodpanda.
    return (await this.loadRestaurant(vendorCode, true)).details;
  }

  async getMenu(vendorCode: string): Promise<MenuCategory[]> {
    return (await this.loadRestaurant(vendorCode)).categories;
  }

  private findItem(menu: CachedVendorMenu, itemId: string): MenuItem | undefined {
    return menu.productsByCode.get(itemId) ?? menu.productsById.get(Number(itemId));
  }

  private pickVariation(item: MenuItem, variationId?: string) {
    if (!variationId) return item.variation;
    const found = (item.variations ?? [item.variation]).find(
      (v) => String(v.id) === String(variationId) || v.code === variationId
    );
    if (!found) {
      throw new Error(
        `Variation "${variationId}" is not a variation of "${item.name}". ` +
          `Variations: ${(item.variations ?? [item.variation]).map((v) => `${v.id} (${v.price})`).join(", ")}`
      );
    }
    return found;
  }

  /** Choice groups (options, add-ons) of one product variation, via RestaurantProductQuery. */
  private async loadChoiceGroups(
    menu: CachedVendorMenu,
    item: MenuItem,
    variationId: number
  ): Promise<ToppingGroup[]> {
    const key = `${item.id}:${variationId}`;
    const cached = menu.choiceGroups.get(key);
    if (cached) return cached;
    if (!item.is_customizable) {
      menu.choiceGroups.set(key, []);
      return [];
    }
    if (!menu.menuId) throw new Error(`No menu id for ${menu.details.name}; reload the menu.`);
    const result = await this.graphqlRequest<unknown>(
      productOperation(requireHash("product"), menu.details.id, item.id, menu.menuId)
    );
    const groups = parseProductChoices(result, variationId);
    menu.choiceGroups.set(key, groups);
    return groups;
  }

  async getItemDetails(
    vendorCode: string,
    itemId: string,
    variationId?: string
  ): Promise<{ category: string; item: MenuItem }> {
    const menu = await this.loadRestaurant(vendorCode);
    const item = this.findItem(menu, itemId);
    if (!item) {
      throw new Error(`Item "${itemId}" not found in menu for restaurant "${vendorCode}".`);
    }
    const variation = this.pickVariation(item, variationId);
    const groups = await this.loadChoiceGroups(menu, item, variation.id);
    const category = menu.categories.find((c) => c.items.includes(item))?.name ?? "";
    return { category, item: { ...item, variation, price: variation.price, topping_groups: groups } };
  }

  // ----------------------------------------------------------------
  // 4. Add to Cart
  // ----------------------------------------------------------------

  async addToCart(
    vendorCode: string,
    items: AddToCartInput[]
  ): Promise<Cart> {
    const menu = await this.loadRestaurant(vendorCode);

    // Build every line first, so a bad item leaves the cart untouched.
    const lines: CartProductPayload[] = [];
    for (const input of items) {
      const product = this.findItem(menu, input.item_id);
      if (!product) {
        throw new Error(
          `Item "${input.item_id}" not found in menu for ${menu.details.name}. Use get_menu to see available items.`
        );
      }
      if (product.is_sold_out) throw new Error(`"${product.name}" is sold out.`);
      const variation = this.pickVariation(product, input.variation_id);
      const groups = await this.loadChoiceGroups(menu, product, variation.id);
      const choices = selectChoices(product.name, groups, input.topping_ids ?? []);
      lines.push(
        buildCartProduct(product, variation, choices, input.quantity, input.special_instructions || "")
      );
    }

    // Merging into an existing line must not take it past the per-line limit.
    const sameLine = (a: CartProductPayload, b: CartProductPayload) =>
      a.id === b.id &&
      a.variation_id === b.variation_id &&
      a.special_instructions === b.special_instructions &&
      JSON.stringify(a.toppings) === JSON.stringify(b.toppings);
    const switching = !!this.cartVendor && this.cartVendor.code !== menu.details.id;
    const merged: CartProductPayload[] = (switching ? [] : this.cartProducts).map((p) => ({ ...p }));
    for (const payload of lines) {
      const existing = merged.find((p) => sameLine(p, payload));
      if (existing) {
        existing.quantity += payload.quantity;
        checkQuantity(existing.quantity);
      } else {
        merged.push({ ...payload });
      }
    }

    // If switching vendors, clear the cart
    if (switching) {
      this.clearCart();
    }

    this.cartVendor = {
      code: menu.details.id,
      latitude: menu.latitude,
      longitude: menu.longitude,
      marketplace: false,
      vertical: "restaurants",
    };
    this.cartVendorName = menu.details.name;

    for (const payload of lines) {
      // Same product, variation, choices and instructions: bump the quantity.
      const existingIdx = this.cartProducts.findIndex((p) => sameLine(p, payload));
      if (existingIdx >= 0) {
        this.cartProducts[existingIdx].quantity += payload.quantity;
      } else {
        this.cartProducts.push(payload);
        this.cartItemIds.push(`cart-${this.nextCartItemId++}`);
      }
    }

    // Validate and price the whole cart with foodpanda
    return this.calculateCart();
  }

  // ----------------------------------------------------------------
  // 5. Get Cart
  // ----------------------------------------------------------------

  async getCart(): Promise<Cart | null> {
    if (this.cartProducts.length === 0 || !this.cartVendor) {
      return null;
    }

    return {
      restaurant_id: this.cartVendor.code,
      restaurant_name: this.cartVendorName,
      items: this.cartItems,
      subtotal: this.cartSubtotal,
      delivery_fee: this.cartDeliveryFee,
      service_fee: this.cartServiceFee,
      total: this.cartTotal,
    };
  }

  // ----------------------------------------------------------------
  // 6. Remove from Cart
  // ----------------------------------------------------------------

  async removeFromCart(cartItemId: string): Promise<Cart> {
    const idx = this.cartItemIds.indexOf(cartItemId);
    if (idx < 0) {
      throw new Error(
        `Cart item "${cartItemId}" not found. Use get_cart to see current items.`
      );
    }

    // Remove the corresponding entries (all three arrays are aligned)
    this.cartProducts.splice(idx, 1);
    this.cartItemIds.splice(idx, 1);
    this.cartItems.splice(idx, 1);

    if (this.cartProducts.length === 0) {
      this.clearCart();
      return {
        restaurant_id: "",
        restaurant_name: "",
        items: [],
        subtotal: 0,
        delivery_fee: 0,
        service_fee: 0,
        total: 0,
      };
    }

    // Recalculate with remaining items
    return this.calculateCart();
  }

  // ----------------------------------------------------------------
  // 7. Preview Order
  // ----------------------------------------------------------------

  /** Cached checkout state from previewOrder, used by placeOrder */
  private checkoutState: {
    customer: CustomerProfile;
    address: DeliveryAddress;
    purchaseIntentId: string;
    paymentMethods: PaymentMethodInfo[];
  } | null = null;

  /** Cached customer profile (rarely changes) */
  private cachedCustomerProfile: CustomerProfile | null = null;

  private async getCustomerProfile(): Promise<CustomerProfile> {
    if (this.cachedCustomerProfile) return this.cachedCustomerProfile;

    const result = await this.restRequest<{
      data: {
        id: string;
        code: string;
        first_name: string;
        last_name: string;
        email: string;
        mobile_number: string;
        mobile_country_code: string;
      };
    }>("/api/v5/customers");

    this.cachedCustomerProfile = result.data;
    return result.data;
  }

  private async getDeliveryAddresses(): Promise<DeliveryAddress[]> {
    const result = await this.restRequest<{
      data: { items: DeliveryAddress[] };
    }>("/api/v5/customers/addresses");

    return result.data.items;
  }

  /**
   * Pick the best delivery address: closest to configured lat/lng.
   */
  private pickDeliveryAddress(addresses: DeliveryAddress[]): DeliveryAddress {
    if (addresses.length === 0) {
      throw new Error(
        "No saved delivery addresses found. Please add an address in the foodpanda app first."
      );
    }
    if (addresses.length === 1) return addresses[0];

    let best = addresses[0];
    let bestDist = Infinity;
    for (const addr of addresses) {
      const dlat = addr.latitude - this.latitude;
      const dlng = addr.longitude - this.longitude;
      const dist = dlat * dlat + dlng * dlng;
      if (dist < bestDist) {
        bestDist = dist;
        best = addr;
      }
    }
    return best;
  }

  private async getPurchaseIntent(
    vendorCode: string,
    subtotal: number,
    total: number
  ): Promise<{
    intentId: string;
    paymentMethods: PaymentMethodInfo[];
  }> {
    interface IntentResponse {
      data: {
        purchaseIntent: { id: string };
        paymentMethodDetails: {
          paymentMethods: Array<{
            name: string;
            hidden: boolean;
            isOnlinePaymentMethod: boolean;
            preferred: boolean;
            paymentInstruments: Array<{
              publicId: string;
              preferred: boolean;
              publicFields?: {
                displayValue?: string;
                bin?: string;
                owner?: string;
                validToMonth?: number;
                validToYear?: number;
                scheme?: string;
              };
            }> | null;
          }>;
        };
      };
    }

    const result = await this.restRequest<IntentResponse>(
      `/api/v5/purchase/intent?include=cashback&locale=${getRegionConfig().locale}`,
      {
        method: "POST",
        body: JSON.stringify({
          subtotal,
          currency: getRegionConfig().currency,
          vendorCode,
          amount: total,
          emoneyAmountToUse: 0,
          expeditionType: "delivery",
          paymentLimits: [
            { limitCode: "foodafterdiscount", limitAmount: subtotal },
            { limitCode: "orderamountwithoutpaymentfee", limitAmount: total },
          ],
        }),
      }
    );

    const intentId = result.data.purchaseIntent.id;
    const methods: PaymentMethodInfo[] = [];

    for (const pm of result.data.paymentMethodDetails.paymentMethods) {
      if (pm.hidden) continue;

      if (pm.name === "payment_on_delivery") {
        const instrument = pm.paymentInstruments?.[0];
        methods.push({
          name: "payment_on_delivery",
          display_name: "Cash on Delivery",
          instrument_id: instrument?.publicId ?? null,
        });
      } else if (pm.name === "generic_creditcard") {
        // List each saved card as a separate option
        if (pm.paymentInstruments && pm.paymentInstruments.length > 0) {
          for (const inst of pm.paymentInstruments) {
            const pf = inst.publicFields;
            const label = pf?.scheme && pf?.displayValue
              ? `${pf.scheme} ending ${pf.displayValue}`
              : "Saved card";
            methods.push({
              name: "generic_creditcard",
              display_name: label,
              instrument_id: inst.publicId,
              card_details: pf
                ? {
                    scheme: pf.scheme ?? "",
                    last_4_digits: pf.displayValue ?? "",
                    bin: pf.bin ?? "",
                    owner: pf.owner ?? "",
                    valid_to_month: pf.validToMonth ?? 0,
                    valid_to_year: pf.validToYear ?? 0,
                  }
                : undefined,
            });
          }
        }
      } else if (pm.name === "antfinancial_gcash") {
        methods.push({
          name: "antfinancial_gcash",
          display_name: "GCash (requires app redirect — may not work via MCP)",
          instrument_id: null,
        });
      }
    }

    return { intentId, paymentMethods: methods };
  }

  async previewOrder(): Promise<OrderPreview> {
    throw new Error(LEGACY_CHECKOUT_DISABLED);
  }

  // ----------------------------------------------------------------
  // 8. Place Order
  // ----------------------------------------------------------------

  async placeOrder(_paymentMethodName: string, _deliveryInstructions?: string): Promise<OrderResult> {
    throw new Error(LEGACY_CHECKOUT_DISABLED);
  }

  // ----------------------------------------------------------------
  // Cart calculation helper
  // ----------------------------------------------------------------

  private async calculateCart(): Promise<Cart> {
    if (!this.cartVendor || this.cartProducts.length === 0) {
      throw new Error("Cart is empty. Add items first.");
    }

    const requestBody = buildCalculateRequest(
      this.cartProducts,
      this.cartVendor,
      this.latitude,
      this.longitude
    );

    const result = await this.restRequest<unknown>(
      "/api/v5/cart/calculate?include=expedition",
      {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "X-Caller-Platform": "mfe" },
      }
    );

    const calc = parseCalculate(result, this.cartProducts);
    this.cartSubtotal = calc.subtotal;
    this.cartServiceFee = calc.serviceFee;
    this.cartTotal = calc.total;
    this.cartDeliveryFee = calc.deliveryFee;
    this.cartItems = cartItemsOf(this.cartProducts, this.cartItemIds, calc);

    return {
      restaurant_id: this.cartVendor.code,
      restaurant_name: this.cartVendorName,
      items: this.cartItems,
      subtotal: this.cartSubtotal,
      delivery_fee: this.cartDeliveryFee,
      service_fee: this.cartServiceFee,
      total: this.cartTotal,
    };
  }

  private clearCart(): void {
    this.cartProducts = [];
    this.cartItemIds = [];
    this.cartVendor = null;
    this.cartVendorName = "";
    this.cartItems = [];
    this.cartSubtotal = 0;
    this.cartDeliveryFee = 0;
    this.cartServiceFee = 0;
    this.cartTotal = 0;
    this.nextCartItemId = 1;
  }
}
