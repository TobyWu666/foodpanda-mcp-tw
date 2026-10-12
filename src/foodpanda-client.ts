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
} from "./types.js";
import { OrderConfirmationError, OrderGuard, type OrderSnapshot } from "./order-guard.js";
import {
  type PaymentMethodChoice,
  UnsupportedPaymentMethodError,
  parsePaymentMethodChoice,
} from "./payment-method.js";

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
  type PaymentOption,
  type PurchaseIntent,
  CheckoutStatusUnknownError,
  buildCheckoutRequest,
  checkCalculatedPayment,
  parseCheckoutResponse,
  parsePurchaseIntent,
  purchaseIntentRequest,
  withPaymentMethod,
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

/** Raw HTTP, injectable so tests can run the whole flow without the network. */
export type HttpFunction = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ status: number; ok: boolean; text: string }>;

export interface FoodpandaClientOptions {
  /** Replaces the network (fetch or browser transport) and the request throttle. */
  http?: HttpFunction;
  guard?: OrderGuard;
}

/** What prepareOrder locked; place_order rebuilds the order from it. */
interface PreparedOrder {
  option: PaymentOption;
  intentId: string;
  addressId: number;
  deliveryInstructions: string;
}

export interface PreparedOrderSummary {
  confirmation_code: string;
  expires_at: string;
  restaurant: { id: string; name: string };
  items: Array<{
    name: string;
    quantity: number;
    options: string[];
    special_instructions: string;
    total_price: number;
  }>;
  subtotal: number;
  delivery_fee: number;
  service_fee: number;
  total: number;
  currency: string;
  payment_method: { payment_method: PaymentMethodChoice; label: string };
  delivery_address: { id: number; label: string | null; address: string };
  delivery_instructions: string;
}

/** Never matches a real order; used only to let the guard report a missing or stale code. */
const EMPTY_SNAPSHOT: OrderSnapshot = {
  customer_id: "",
  restaurant_id: "",
  items: [],
  subtotal: 0,
  delivery_fee: 0,
  service_fee: 0,
  total: 0,
  payment_method: "cash",
  address: { id: 0, latitude: 0, longitude: 0, text: "" },
  delivery_instructions: "",
};

function describeAddresses(addresses: DeliveryAddress[]): string {
  return addresses
    .map((a) => `- address_id ${a.id}: ${a.label ? `${a.label}, ` : ""}${a.formatted_customer_address ?? ""}`)
    .join("\n");
}

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

  // Two-step order state
  private readonly guard: OrderGuard;
  private prepared: PreparedOrder | null = null;
  private readonly http: HttpFunction | undefined;

  constructor(
    sessionToken: string | null,
    latitude: number,
    longitude: number,
    options: FoodpandaClientOptions = {}
  ) {
    this.http = options.http;
    this.guard = options.guard ?? new OrderGuard();
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
    // A different login may be a different account: no prepared order survives it.
    this.guard.invalidate();
    this.prepared = null;
    this.cachedCustomerProfile = null;
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
    if (this.http) return this.http(url, init);
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
    // Any change to the cart voids a prepared order, even if this one fails part way.
    this.guard.invalidate();
    this.prepared = null;
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
    this.guard.invalidate();
    this.prepared = null;
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
  // 7. Payment methods and addresses
  // ----------------------------------------------------------------

  /** Cached customer profile; dropped when the token changes. */
  private cachedCustomerProfile: CustomerProfile | null = null;

  private async getCustomerProfile(): Promise<CustomerProfile> {
    if (this.cachedCustomerProfile) return this.cachedCustomerProfile;
    const result = await this.restRequest<{ data: CustomerProfile }>("/api/v5/customers");
    this.cachedCustomerProfile = result.data;
    return result.data;
  }

  private async getDeliveryAddresses(): Promise<DeliveryAddress[]> {
    const result = await this.restRequest<{
      data: { items: DeliveryAddress[] };
    }>("/api/v5/customers/addresses");
    return result.data.items ?? [];
  }

  /** The address the user picked. With several saved addresses, never guess: ask. */
  private chooseAddress(addresses: DeliveryAddress[], addressId?: number): DeliveryAddress {
    if (addresses.length === 0) {
      throw new Error("No saved delivery addresses. Add one in the foodpanda app first.");
    }
    if (addressId !== undefined) {
      const hit = addresses.find((a) => Number(a.id) === Number(addressId));
      if (!hit) throw new Error(`Saved address ${addressId} not found.\n${describeAddresses(addresses)}`);
      return hit;
    }
    if (addresses.length === 1) return addresses[0];
    throw new Error(
      `There are ${addresses.length} saved addresses. Ask the user which one to deliver to and pass its address_id.\n` +
        describeAddresses(addresses)
    );
  }

  private async getPurchaseIntent(): Promise<PurchaseIntent> {
    const cfg = getRegionConfig();
    const resp = await this.restRequest<unknown>(
      `/api/v5/purchase/intent?include=cashback&locale=${cfg.locale}`,
      {
        method: "POST",
        body: JSON.stringify(
          purchaseIntentRequest(this.cartVendor!.code, this.cartSubtotal, this.cartTotal, cfg.currency)
        ),
      }
    );
    return parsePurchaseIntent(resp);
  }

  /** LINE Pay (bound) and cash, if the account can use them for the current cart. */
  async listPaymentMethods(): Promise<{
    available: Array<{ payment_method: PaymentMethodChoice; label: string }>;
    unavailable: Array<{ payment_method: PaymentMethodChoice; reason: string }>;
    not_supported_by_this_server: string[];
  }> {
    this.requireCart();
    const intent = await this.getPurchaseIntent();
    return {
      available: intent.options.map((o) => ({ payment_method: o.choice, label: o.label })),
      unavailable: intent.unavailable.map((u) => ({ payment_method: u.choice, reason: u.reason })),
      not_supported_by_this_server: intent.notSupported,
    };
  }

  // ----------------------------------------------------------------
  // 8. Two-step order: prepare_order, then place_order
  // ----------------------------------------------------------------

  private requireCart(): void {
    if (this.cartProducts.length === 0 || !this.cartVendor) {
      throw new Error("Cart is empty. Add items first.");
    }
  }

  /** Exactly what place_order would submit, for the confirmation code. */
  private orderSnapshot(
    customer: CustomerProfile,
    address: DeliveryAddress,
    paymentMethod: PaymentMethodChoice,
    deliveryInstructions: string
  ): OrderSnapshot {
    return {
      customer_id: String(customer.id),
      restaurant_id: this.cartVendor!.code,
      items: this.cartProducts.map((p, i) => ({
        product_id: p.id,
        variation_id: p.variation_id,
        quantity: p.quantity,
        topping_ids: p.toppings.map((t) => t.id),
        special_instructions: p.special_instructions,
        total_price: this.cartItems[i]?.total_price ?? p.price * p.quantity,
      })),
      subtotal: this.cartSubtotal,
      delivery_fee: this.cartDeliveryFee,
      service_fee: this.cartServiceFee,
      total: this.cartTotal,
      payment_method: paymentMethod,
      address: {
        id: Number(address.id),
        latitude: address.latitude,
        longitude: address.longitude,
        text: address.formatted_customer_address ?? "",
      },
      delivery_instructions: deliveryInstructions,
    };
  }

  /**
   * Price the cart for one saved address with one payment method selected, lock it,
   * and issue a one-time confirmation code. Nothing is ordered.
   */
  async prepareOrder(input: {
    payment_method: string;
    address_id?: number;
    delivery_instructions?: string;
  }): Promise<PreparedOrderSummary> {
    // Any earlier code is void from here on, whatever happens below.
    this.guard.invalidate();
    this.prepared = null;

    const choice = parsePaymentMethodChoice(input.payment_method);
    this.requireCart();
    const instructions = input.delivery_instructions?.trim() ?? "";

    const details = await this.getRestaurantDetails(this.cartVendor!.code);
    if (!details.is_open || !details.is_delivery_available) {
      throw new Error(`${details.name} is closed or not taking delivery orders right now.`);
    }

    const customer = await this.getCustomerProfile();
    const address = this.chooseAddress(await this.getDeliveryAddresses(), input.address_id);

    // Price at the chosen address, then select the payment method the way the web app does.
    await this.calculateCart({ address });
    const intent = await this.getPurchaseIntent();
    const option = intent.options.find((o) => o.choice === choice);
    if (!option) {
      throw new UnsupportedPaymentMethodError(choice, intent.options.map((o) => o.choice));
    }
    const amount = this.cartTotal;
    await this.calculateCart({ address, payment: { option, amount } });
    if (this.cartTotal !== amount) {
      throw new Error(
        `The total changed from ${amount} to ${this.cartTotal} when the payment method was selected. Call prepare_order again.`
      );
    }
    const unavailable = this.cartItems.filter((i) => i.is_available === false);
    if (unavailable.length > 0) {
      throw new Error(
        `Not available right now: ${unavailable.map((i) => i.name).join(", ")}. Remove them from the cart first.`
      );
    }

    const snapshot = this.orderSnapshot(customer, address, choice, instructions);
    this.prepared = { option, intentId: intent.intentId, addressId: Number(address.id), deliveryInstructions: instructions };
    const issued = this.guard.issue(snapshot);

    return {
      confirmation_code: issued.code,
      expires_at: issued.expires_at,
      restaurant: { id: this.cartVendor!.code, name: this.cartVendorName },
      items: this.cartItems.map((i) => ({
        name: i.name,
        quantity: i.quantity,
        options: i.toppings.map((t) => (t.price ? `${t.name} (+${t.price})` : t.name)),
        special_instructions: i.special_instructions,
        total_price: i.total_price,
      })),
      subtotal: this.cartSubtotal,
      delivery_fee: this.cartDeliveryFee,
      service_fee: this.cartServiceFee,
      total: this.cartTotal,
      currency: getRegionConfig().currency,
      payment_method: { payment_method: choice, label: option.label },
      delivery_address: {
        id: Number(address.id),
        label: address.label ?? null,
        address: address.formatted_customer_address ?? "",
      },
      delivery_instructions: instructions,
    };
  }

  /**
   * Submit the order prepared by prepareOrder. Re-checks everything against
   * foodpanda first; the code is spent before checkout is sent, and checkout is
   * sent exactly once (no retry of any kind).
   */
  async placeOrder(confirmationCode: string): Promise<OrderResult> {
    const prepared = this.prepared;
    try {
      if (!prepared || !this.cartVendor || this.cartProducts.length === 0) {
        // Let the guard word it: missing, used, expired or unknown.
        this.guard.consume(confirmationCode, EMPTY_SNAPSHOT);
        throw new OrderConfirmationError("unknown", "Unknown confirmation code. Call prepare_order again.");
      }

      // Re-validate: same account, the same saved address as it is now, current prices.
      const customer = await this.getCustomerProfile();
      const address = (await this.getDeliveryAddresses()).find((a) => Number(a.id) === prepared.addressId);
      if (!address) {
        throw new OrderConfirmationError(
          "changed",
          "The delivery address was removed since prepare_order. Call prepare_order again.",
          ["address"]
        );
      }
      await this.calculateCart({ address, payment: { option: prepared.option, amount: this.cartTotal } });
      const current = this.orderSnapshot(customer, address, prepared.option.choice, prepared.deliveryInstructions);

      // Spend the code. From here on, any failure needs a new prepare_order.
      this.guard.consume(confirmationCode, current);
      this.prepared = null;

      const cfg = getRegionConfig();
      const cached = this.menuCache.get(this.cartVendor.code);
      const body = buildCheckoutRequest({
        products: this.cartProducts,
        menuItem: (id) => cached?.productsById.get(id),
        vendor: this.cartVendor,
        customer: { id: String(customer.id), email: customer.email },
        address,
        deliveryInstructions: prepared.deliveryInstructions,
        total: current.total,
        intentId: prepared.intentId,
        option: prepared.option,
        webHost: cfg.webHost,
        currency: cfg.currency,
      });

      let resp: unknown;
      try {
        // restRequestOnce, never restRequest: a checkout must not be retried.
        resp = await this.restRequestOnce<unknown>("/api/v5/cart/checkout", {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            "dps-session-id": this.dpsSessionId(),
            "x-caller-platform": "mfe",
            "x-global-entity-id": requireGlobalEntityId(),
          },
        });
      } catch (err) {
        throw new CheckoutStatusUnknownError(`sending the order failed (${redactForLog((err as Error).message)}).`);
      }

      console.error("[placeOrder] checkout response:", redactForLog(resp));
      const outcome = parseCheckoutResponse(resp);
      const total = current.total;
      this.clearCart();
      return {
        order_id: outcome.orderCode,
        status: outcome.status,
        estimated_delivery_time: outcome.estimatedDelivery,
        total,
      };
    } finally {
      // Whatever happened, this code and this preparation are finished.
      this.guard.invalidate();
      this.prepared = null;
    }
  }

  private dpsSessionId(): string {
    const payload = {
      session_id: Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(""),
      perseus_id: this.perseusClientId,
      timestamp: Math.floor(Date.now() / 1000),
    };
    return Buffer.from(JSON.stringify(payload)).toString("base64");
  }

  // ----------------------------------------------------------------
  // Cart calculation helper
  // ----------------------------------------------------------------

  /**
   * Validate and price the cart with foodpanda. Without an address it uses the configured
   * location; prepare/place pass the chosen saved address and the selected payment method.
   */
  private async calculateCart(
    at: { address?: DeliveryAddress; payment?: { option: PaymentOption; amount: number } } = {}
  ): Promise<Cart> {
    if (!this.cartVendor || this.cartProducts.length === 0) {
      throw new Error("Cart is empty. Add items first.");
    }

    let requestBody = buildCalculateRequest(
      this.cartProducts,
      this.cartVendor,
      at.address?.latitude ?? this.latitude,
      at.address?.longitude ?? this.longitude
    );
    if (at.payment) requestBody = withPaymentMethod(requestBody, at.payment.option, at.payment.amount);

    const result = await this.restRequest<unknown>(
      "/api/v5/cart/calculate?include=expedition",
      {
        method: "POST",
        body: JSON.stringify(requestBody),
        headers: { "X-Caller-Platform": "mfe" },
      }
    );
    if (at.payment) checkCalculatedPayment(result, at.payment.option);

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
    this.guard.invalidate();
    this.prepared = null;
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
