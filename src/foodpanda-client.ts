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
  CartToppingPayload,
  CartVendorPayload,
  CartCalculateRequest,
  ToppingGroup,
  ScheduleEntry,
  CustomerProfile,
  DeliveryAddress,
  PaymentMethodInfo,
  OrderPreview,
} from "./types.js";

import { getRegionConfig, requireHash } from "./config.js";
import { browserTransport } from "./browser-transport.js";
import { redactForLog } from "./redact.js";

/**
 * Region-specific endpoints and hashes now come from config.ts.
 * Presets: FOODPANDA_COUNTRY=hk (default) | ph, plus per-key env overrides.
 */
const GRAPHQL_SEARCH_HASH = () => requireHash("search");
const GRAPHQL_VENDOR_LIST_HASH = () => requireHash("vendor_list");

/** Shared shape for vendor menu data from the REST API */
interface VendorMenuData {
  menu_categories: Array<{
    name: string;
    products: Array<{
      id: number;
      code: string;
      name: string;
      description: string;
      file_path: string;
      is_sold_out: boolean;
      product_variations: Array<{
        id: number;
        code: string;
        price: number;
        topping_ids: number[];
      }>;
    }>;
  }>;
  toppings: Record<
    string,
    {
      id: number;
      name: string;
      quantity_minimum: number;
      quantity_maximum: number;
      options: Array<{
        id: number;
        product_id: number;
        name: string;
        price: number;
      }>;
    }
  >;
}

/** Shape expected by cacheVendorMenu */
interface VendorMenuInput {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  menus: VendorMenuData[];
}

/**
 * Cached menu data per vendor, so we can build cart payloads
 * without re-fetching the menu every time.
 */
interface CachedVendorMenu {
  vendorCode: string;
  vendorName: string;
  vendorLatitude: number;
  vendorLongitude: number;
  categories: MenuCategory[];
  /** Flat lookup: product code -> MenuItem */
  productsByCode: Map<string, MenuItem>;
  /** Flat lookup: product id -> MenuItem */
  productsById: Map<number, MenuItem>;
  /** Flat lookup: topping option id -> { id, name, price } */
  toppingOptionsById: Map<number, { id: number; name: string; price: number }>;
  /** Timestamp when this cache entry was created */
  cachedAt: number;
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

  private async graphqlRequest<T>(body: object, displayContext: string = "SEARCH"): Promise<T> {
    return this.withPerimeterXRetry(() =>
      this.graphqlRequestOnce<T>(body, displayContext)
    );
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
        "x-pd-language-id": String(cfg.languageId),
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

  private async graphqlRequestOnce<T>(body: object, displayContext: string = "SEARCH"): Promise<T> {
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
        "display-context": displayContext,
        platform: "web",
        locale: cfg.locale,
      },
      body: JSON.stringify(body),
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
    return JSON.parse(result.text) as T;
  }

  // ----------------------------------------------------------------
  // 1. Search Restaurants
  // ----------------------------------------------------------------

  async searchRestaurants(
    query: string,
    cuisine?: string,
    limit?: number
  ): Promise<Restaurant[]> {
    const body = {
      extensions: {
        persistedQuery: {
          sha256Hash: GRAPHQL_SEARCH_HASH(),
          version: 1,
        },
      },
      variables: {
        searchResultsParams: {
          query,
          latitude: this.latitude,
          longitude: this.longitude,
          locale: getRegionConfig().locale,
          languageId: getRegionConfig().languageId,
          expeditionType: "DELIVERY",
          customerType: "B2C",
          verticalTypes: ["RESTAURANTS"],
        },
        skipQueryCorrection: true,
      },
    };

    interface GqlResponse {
      data: {
        searchPage: {
          components: Array<{
            vendorData?: {
              code: string;
              name: string;
              availability: {
                status: string;
                distanceInMeters: number;
              };
              vendorRating: {
                value: number;
                count: number;
              };
              dynamicPricing: {
                deliveryFee: { total: number };
                minimumOrderValue: { total: number };
              };
              timeEstimations: {
                delivery: {
                  duration: {
                    lowerLimitInMinutes: number;
                    upperLimitInMinutes: number;
                  };
                } | null;
              };
              vendorTile?: {
                vendorInfo?: Array<
                  Array<{
                    id: string;
                    elements: Array<{
                      text: string;
                    }>;
                  }>
                >;
              };
            };
            vendorChainData?: {
              code: string;
              name: string;
            };
            totalChainVendors?: number;
          }>;
        };
      };
    }

    const result = await this.graphqlRequest<GqlResponse>(body);

    const components = result.data?.searchPage?.components || [];
    const restaurants: Restaurant[] = [];

    for (const comp of components) {
      const v = comp.vendorData;
      if (!v) continue;

      // Extract cuisines from vendorTile
      const cuisines: string[] = [];
      if (v.vendorTile?.vendorInfo) {
        for (const row of v.vendorTile.vendorInfo) {
          for (const group of row) {
            if (group.id === "VENDOR_INFO_CUISINES" && group.elements) {
              for (const el of group.elements) {
                if (el.text) cuisines.push(el.text);
              }
            }
          }
        }
      }

      const delivery = v.timeEstimations?.delivery?.duration;
      const deliveryTime = delivery
        ? `${delivery.lowerLimitInMinutes}-${delivery.upperLimitInMinutes} min`
        : "N/A";

      const restaurant: Restaurant = {
        id: v.code,
        name: v.name,
        cuisine: cuisines,
        rating: v.vendorRating?.value ?? 0,
        review_count: v.vendorRating?.count ?? 0,
        delivery_fee: v.dynamicPricing?.deliveryFee?.total ?? 0,
        delivery_time: deliveryTime,
        minimum_order: v.dynamicPricing?.minimumOrderValue?.total ?? 0,
        distance_km: Math.round((v.availability?.distanceInMeters ?? 0) / 100) / 10,
        is_open: v.availability?.status === "OPEN",
      };

      // Attach chain data if this vendor belongs to a chain
      if (comp.vendorChainData?.code) {
        restaurant.chain_code = comp.vendorChainData.code;
        restaurant.chain_name = comp.vendorChainData.name;
      }
      if (comp.totalChainVendors && comp.totalChainVendors > 1) {
        restaurant.total_outlets = comp.totalChainVendors;
      }

      restaurants.push(restaurant);
    }

    // Client-side cuisine filter
    let filtered = restaurants;
    if (cuisine) {
      const cuisineLower = cuisine.toLowerCase();
      filtered = restaurants.filter((r) =>
        r.cuisine.some((c) => c.toLowerCase().includes(cuisineLower))
      );
    }

    const maxResults = limit ?? 10;
    return filtered.slice(0, maxResults);
  }

  // ----------------------------------------------------------------
  // 1b. List Chain Outlets
  // ----------------------------------------------------------------

  async getChainOutlets(chainCode: string): Promise<Restaurant[]> {
    const body = {
      extensions: {
        persistedQuery: {
          sha256Hash: GRAPHQL_VENDOR_LIST_HASH(),
          version: 1,
        },
      },
      variables: {
        input: {
          expeditionType: "DELIVERY",
          latitude: this.latitude,
          longitude: this.longitude,
          locale: getRegionConfig().locale,
          customerType: "B2C",
          languageId: getRegionConfig().languageId,
          page: "CHAIN_LISTING_PAGE",
          availabilityFilters: {
            chainCodes: [chainCode],
          },
        },
      },
    };

    interface ChainGqlResponse {
      data: {
        vendorListingPage: {
          components: Array<{
            vendorData?: {
              code: string;
              name: string;
              availability: {
                status: string;
                distanceInMeters: number;
              };
              vendorRating: {
                value: number;
                count: number;
              };
              dynamicPricing: {
                deliveryFee: { total: number };
                minimumOrderValue: { total: number };
              };
              timeEstimations: {
                delivery: {
                  duration: {
                    lowerLimitInMinutes: number;
                    upperLimitInMinutes: number;
                  };
                } | null;
              };
              vendorTile?: {
                vendorInfo?: Array<
                  Array<{
                    id: string;
                    elements: Array<{
                      text: string;
                    }>;
                  }>
                >;
              };
            };
          }>;
        };
      };
    }

    const result = await this.graphqlRequest<ChainGqlResponse>(body, "rlp");


    const components = result.data?.vendorListingPage?.components || [];
    const restaurants: Restaurant[] = [];

    for (const comp of components) {
      const v = comp.vendorData;
      if (!v) continue;

      // Extract cuisines from vendorTile
      const cuisines: string[] = [];
      if (v.vendorTile?.vendorInfo) {
        for (const row of v.vendorTile.vendorInfo) {
          for (const group of row) {
            if (group.id === "VENDOR_INFO_CUISINES" && group.elements) {
              for (const el of group.elements) {
                if (el.text) cuisines.push(el.text);
              }
            }
          }
        }
      }

      const delivery = v.timeEstimations?.delivery?.duration;
      const deliveryTime = delivery
        ? `${delivery.lowerLimitInMinutes}-${delivery.upperLimitInMinutes} min`
        : "N/A";

      restaurants.push({
        id: v.code,
        name: v.name,
        cuisine: cuisines,
        rating: v.vendorRating?.value ?? 0,
        review_count: v.vendorRating?.count ?? 0,
        delivery_fee: v.dynamicPricing?.deliveryFee?.total ?? 0,
        delivery_time: deliveryTime,
        minimum_order: v.dynamicPricing?.minimumOrderValue?.total ?? 0,
        distance_km: Math.round((v.availability?.distanceInMeters ?? 0) / 100) / 10,
        is_open: v.availability?.status === "OPEN",
        chain_code: chainCode,
      });
    }

    return restaurants;
  }

  // ----------------------------------------------------------------
  // 2. Get Restaurant Details
  // ----------------------------------------------------------------

  async getRestaurantDetails(
    vendorCode: string
  ): Promise<RestaurantDetails> {
    const path =
      `/api/v5/vendors/${encodeURIComponent(vendorCode)}` +
      `?include=menus,bundles,multiple_discounts` +
      `&language_id=${getRegionConfig().languageId}&opening_type=delivery&basket_currency=${getRegionConfig().currency}` +
      `&latitude=${this.latitude}&longitude=${this.longitude}`;

    interface VendorResponse {
      data: {
        code: string;
        name: string;
        address: string;
        rating: number;
        review_number: number;
        cuisines: Array<{ name: string; main: boolean }>;
        minimum_order_amount: number;
        minimum_delivery_fee: number;
        delivery_duration_range?: {
          lower_limit_in_minutes: number;
          upper_limit_in_minutes: number;
        };
        dynamic_pricing?: {
          delivery_fee?: { original: number };
          service_fee?: { total: number };
        };
        metadata?: { is_delivery_available: boolean };
        schedules: ScheduleEntry[];
        description: string;
        hero_image: string;
        logo: string;
        latitude: number;
        longitude: number;
        distance: number;
        menus?: VendorMenuData[];
      };
    }

    const result = await this.restRequest<VendorResponse>(path);
    const v = result.data;

    const cuisines = (v.cuisines || []).map((c) => c.name);
    const dr = v.delivery_duration_range;
    const deliveryTime = dr
      ? `${dr.lower_limit_in_minutes}-${dr.upper_limit_in_minutes} min`
      : "N/A";

    // Also cache the menu data while we have it
    if (v.menus && v.menus.length > 0) {
      this.cacheVendorMenu(v as VendorMenuInput);
    }

    return {
      id: v.code,
      name: v.name,
      cuisine: cuisines,
      rating: v.rating ?? 0,
      review_count: v.review_number ?? 0,
      delivery_fee: v.minimum_delivery_fee ?? 0,
      delivery_time: deliveryTime,
      minimum_order: v.minimum_order_amount ?? 0,
      distance_km: Math.round((v.distance ?? 0) * 10) / 10,
      is_open: v.metadata?.is_delivery_available ?? false,
      address: v.address ?? "",
      description: v.description ?? "",
      hero_image: v.hero_image ?? "",
      logo: v.logo ?? "",
      opening_hours: (v.schedules || []).map((s) => ({
        weekday: s.weekday,
        opening_type: s.opening_type,
        opening_time: s.opening_time,
        closing_time: s.closing_time,
      })),
      is_delivery_available: v.metadata?.is_delivery_available ?? false,
    };
  }

  // ----------------------------------------------------------------
  // 3. Get Menu
  // ----------------------------------------------------------------

  async getMenu(vendorCode: string): Promise<MenuCategory[]> {
    // Check cache first (15 min TTL)
    const CACHE_TTL_MS = 15 * 60 * 1000;
    const cached = this.menuCache.get(vendorCode);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.categories;
    }

    // Fetch via the vendor details endpoint (includes menus)
    const path =
      `/api/v5/vendors/${encodeURIComponent(vendorCode)}` +
      `?include=menus,bundles,multiple_discounts` +
      `&language_id=${getRegionConfig().languageId}&opening_type=delivery&basket_currency=${getRegionConfig().currency}` +
      `&latitude=${this.latitude}&longitude=${this.longitude}`;

    interface VendorMenuResponse {
      data: VendorMenuInput;
    }

    const result = await this.restRequest<VendorMenuResponse>(path);
    this.cacheVendorMenu(result.data);

    const cached2 = this.menuCache.get(vendorCode);
    return cached2 ? cached2.categories : [];
  }

  /**
   * Parse and cache menu data from a vendor API response.
   */
  private cacheVendorMenu(vendorData: VendorMenuInput): void {
    if (!vendorData.menus || vendorData.menus.length === 0) return;

    const menu = vendorData.menus[0];
    const toppingsDict = menu.toppings || {};
    const productsByCode = new Map<string, MenuItem>();
    const productsById = new Map<number, MenuItem>();
    const toppingOptionsById = new Map<
      number,
      { id: number; name: string; price: number }
    >();

    // Build flat topping option lookup
    for (const group of Object.values(toppingsDict)) {
      for (const opt of group.options || []) {
        toppingOptionsById.set(opt.id, {
          id: opt.id,
          name: opt.name,
          price: opt.price,
        });
      }
    }

    const categories: MenuCategory[] = (menu.menu_categories || []).map(
      (cat) => {
        const items: MenuItem[] = (cat.products || []).map((prod) => {
          const variation = prod.product_variations?.[0];

          // Resolve topping groups for this product variation
          const toppingGroups: ToppingGroup[] = [];
          if (variation?.topping_ids) {
            for (const tId of variation.topping_ids) {
              const group = toppingsDict[String(tId)];
              if (group) {
                toppingGroups.push({
                  id: group.id,
                  name: group.name,
                  quantity_minimum: group.quantity_minimum,
                  quantity_maximum: group.quantity_maximum,
                  options: (group.options || []).map((opt) => ({
                    id: opt.id,
                    product_id: opt.product_id,
                    name: opt.name,
                    price: opt.price,
                  })),
                });
              }
            }
          }

          // Replace %s placeholder in image URL with 300
          const imageUrl = prod.file_path
            ? prod.file_path.replace("%s", "300")
            : "";

          const item: MenuItem = {
            id: prod.id,
            code: prod.code,
            name: prod.name,
            description: prod.description || "",
            price: variation?.price ?? 0,
            image_url: imageUrl,
            is_sold_out: prod.is_sold_out ?? false,
            variation: variation
              ? {
                  id: variation.id,
                  code: variation.code,
                  price: variation.price,
                }
              : { id: 0, code: "", price: 0 },
            topping_groups: toppingGroups,
          };

          productsByCode.set(prod.code, item);
          productsById.set(prod.id, item);
          return item;
        });

        return { name: cat.name, items };
      }
    );

    this.menuCache.set(vendorData.code, {
      vendorCode: vendorData.code,
      vendorName: vendorData.name,
      vendorLatitude: vendorData.latitude,
      vendorLongitude: vendorData.longitude,
      categories,
      productsByCode,
      productsById,
      toppingOptionsById,
      cachedAt: Date.now(),
    });
  }

  // ----------------------------------------------------------------
  // 4. Add to Cart
  // ----------------------------------------------------------------

  async addToCart(
    vendorCode: string,
    items: AddToCartInput[]
  ): Promise<Cart> {
    // Ensure we have the menu cached for this vendor
    let cached = this.menuCache.get(vendorCode);
    if (!cached) {
      await this.getMenu(vendorCode);
      cached = this.menuCache.get(vendorCode);
      if (!cached) {
        throw new Error(
          `Could not load menu for vendor ${vendorCode}. The restaurant may not exist or may be unavailable.`
        );
      }
    }

    // If switching vendors, clear the cart
    if (this.cartVendor && this.cartVendor.code !== vendorCode) {
      this.clearCart();
    }

    // Set vendor info
    this.cartVendor = {
      code: vendorCode,
      latitude: cached.vendorLatitude,
      longitude: cached.vendorLongitude,
      marketplace: false,
      vertical: "restaurants",
    };
    this.cartVendorName = cached.vendorName;

    // Build product payloads for new items
    for (const input of items) {
      const product =
        cached.productsByCode.get(input.item_id) ||
        cached.productsById.get(Number(input.item_id));

      if (!product) {
        throw new Error(
          `Item "${input.item_id}" not found in menu for ${cached.vendorName}. Use get_menu to see available items.`
        );
      }

      // Build toppings payload
      const toppingsPayload: CartToppingPayload[] = [];

      if (input.topping_ids && input.topping_ids.length > 0) {
        // Group selected option IDs by their topping group
        const selectedOptionIds = new Set(
          input.topping_ids.map((id) => Number(id))
        );

        for (const group of product.topping_groups) {
          const selectedOptions = group.options.filter((opt) =>
            selectedOptionIds.has(opt.id)
          );
          if (selectedOptions.length > 0) {
            toppingsPayload.push({
              id: group.id,
              name: group.name,
              quantity: 1,
              options: selectedOptions.map((opt) => ({
                id: opt.id,
                name: opt.name,
                quantity: 1,
              })),
            });
          }
        }
      }

      const payload: CartProductPayload = {
        id: product.id,
        variation_id: product.variation.id,
        code: product.code,
        variation_code: product.variation.code,
        variation_name: product.name,
        quantity: input.quantity,
        price: product.variation.price,
        original_price: product.variation.price,
        packaging_charge: 0,
        vat_percentage: 0,
        special_instructions: input.special_instructions || "",
        sold_out_option: "REFUND",
        toppings: toppingsPayload,
        products: null,
        tags: null,
        menu_category_code: null,
        menu_category_id: null,
        menu_id: null,
        group_id: null,
        group_order_user_id: 0,
      };

      // Check if this product+variation already exists in cart
      const existingIdx = this.cartProducts.findIndex(
        (p) =>
          p.id === payload.id &&
          p.variation_id === payload.variation_id &&
          p.special_instructions === payload.special_instructions &&
          JSON.stringify(p.toppings) === JSON.stringify(payload.toppings)
      );

      if (existingIdx >= 0) {
        this.cartProducts[existingIdx].quantity += input.quantity;
      } else {
        this.cartProducts.push(payload);
        this.cartItemIds.push(`cart-${this.nextCartItemId++}`);
      }
    }

    // Call cart/calculate to validate and get pricing
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
    if (this.cartProducts.length === 0 || !this.cartVendor) {
      throw new Error("Cart is empty. Add items before previewing an order.");
    }

    // Check if the restaurant is currently open for delivery
    const vendorDetails = await this.getRestaurantDetails(this.cartVendor.code);
    if (!vendorDetails.is_open || !vendorDetails.is_delivery_available) {
      throw new Error(
        `${vendorDetails.name} is currently closed or not accepting delivery orders. Please try again during their operating hours.`
      );
    }

    const [customer, addresses, intent] = await Promise.all([
      this.getCustomerProfile(),
      this.getDeliveryAddresses(),
      this.getPurchaseIntent(
        this.cartVendor.code,
        this.cartSubtotal,
        this.cartTotal
      ),
    ]);

    const address = this.pickDeliveryAddress(addresses);

    // Cache for placeOrder
    this.checkoutState = {
      customer,
      address,
      purchaseIntentId: intent.intentId,
      paymentMethods: intent.paymentMethods,
    };

    return {
      cart: {
        restaurant_id: this.cartVendor.code,
        restaurant_name: this.cartVendorName,
        items: this.cartItems,
        subtotal: this.cartSubtotal,
        delivery_fee: this.cartDeliveryFee,
        service_fee: this.cartServiceFee,
        total: this.cartTotal,
      },
      delivery_address: {
        id: address.id,
        label: address.label,
        formatted_address: address.formatted_customer_address,
        delivery_instructions: address.delivery_instructions,
      },
      payment_methods: intent.paymentMethods,
    };
  }

  // ----------------------------------------------------------------
  // 8. Place Order
  // ----------------------------------------------------------------

  async placeOrder(
    paymentMethodName: string,
    deliveryInstructions?: string
  ): Promise<OrderResult> {
    if (!this.checkoutState) {
      throw new Error(
        "No order preview found. Call preview_order first to prepare checkout."
      );
    }
    if (this.cartProducts.length === 0 || !this.cartVendor) {
      throw new Error("Cart is empty.");
    }

    // Re-calculate cart to ensure product data is fresh and matches server state
    await this.calculateCart();

    const { customer, address, purchaseIntentId, paymentMethods } =
      this.checkoutState;

    // Find the selected payment method
    const selectedMethod = paymentMethods.find(
      (m) => m.name === paymentMethodName
    );
    if (!selectedMethod) {
      const available = paymentMethods.map((m) => m.name).join(", ");
      throw new Error(
        `Payment method "${paymentMethodName}" not available. Available: ${available}`
      );
    }

    // Build payment methods array for checkout
    const paymentMethodsPayload: Array<{
      amount: number;
      metadata: Record<string, unknown>;
      method: string;
    }> = [];

    if (selectedMethod.name === "generic_creditcard") {
      throw new Error(
        "Credit card payments are not supported via MCP. Foodpanda requires a browser-based payment flow (Adyen SDK) to authorize credit card charges, which cannot be completed through API calls alone. Please use 'payment_on_delivery' (Cash on Delivery) instead."
      );
    } else if (selectedMethod.name === "payment_on_delivery") {
      paymentMethodsPayload.push({
        amount: this.cartTotal,
        metadata: {
          token: selectedMethod.instrument_id,
        },
        method: "payment_on_delivery",
      });
    } else {
      throw new Error(
        `Payment method "${selectedMethod.name}" is not supported for automated checkout. Use "payment_on_delivery" or "generic_creditcard".`
      );
    }

    // Build checkout product payloads (more verbose than cart/calculate)
    const cached = this.menuCache.get(this.cartVendor.code);
    const checkoutProducts = this.cartProducts.map((p) => {
      const menuItem = cached?.productsById.get(p.id);
      return {
        description: menuItem?.description ?? "",
        priceBeforeDiscount: null,
        name: menuItem?.name ?? p.variation_name,
        vat_percentage: p.vat_percentage,
        discount: null,
        special_instructions: p.special_instructions,
        variation_name: "",
        sold_out_option: p.sold_out_option,
        toppings: p.toppings,
        price: p.price,
        packaging_price: p.packaging_charge,
        original_price: p.original_price,
        quantity: p.quantity,
        quantity_auto_added: 0,
        id: p.id,
        variation_id: p.variation_id,
        is_available: true,
        is_alcoholic_item: false,
        total_price: p.price * p.quantity,
        total_price_before_discount: p.price * p.quantity,
        products: [],
        product_variation_id: p.variation_id,
        product_id: p.id,
        sold_out_options: [
          { default: true, option: "REFUND", text: "NEXTGEN_SoldOutOptions_Refund" },
          { default: false, option: "CALL_CUSTOMER", text: "NEXTGEN_SoldOutOptions_CALL_CUSTOMER" },
        ],
        product_variations: [
          {
            id: p.variation_id,
            code: p.variation_code,
            remote_code: p.variation_code,
            container_price: 0,
            price: p.price,
            topping_ids: p.toppings.map((t) => t.id),
            topping_properties: [],
            unit_pricing: null,
            total_price: 0,
            dietary_attributes: {},
          },
        ],
        code: p.code,
        variation_code: p.variation_code,
        is_bundle: false,
        tags: [],
        imageUrl: menuItem?.image_url ?? "",
        initial_price: p.price,
        initial_original_price: p.original_price,
        product_type: "",
      };
    });

    // Build dps-session-id header
    const dpsPayload = {
      session_id: Array.from({ length: 32 }, () =>
        Math.floor(Math.random() * 16).toString(16)
      ).join(""),
      perseus_id: this.perseusClientId,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const dpsSessionId = Buffer.from(JSON.stringify(dpsPayload)).toString("base64");

    // Build the full checkout body
    const checkoutBody = {
      platform: "b2c",
      expected_total_amount: this.cartTotal,
      customer: {
        id: customer.id,
        email: customer.email,
        address_id: String(address.id),
        age_verification_token: "",
      },
      expedition: {
        delivery_address: {
          ...address,
          id: String(address.id),
          type: String(address.type),
          location_type: "polygon",
          object_type: "saved address",
        },
        type: "delivery",
        latitude: address.latitude,
        longitude: address.longitude,
        instructions: deliveryInstructions ?? "",
        delivery_instructions_tags: [] as string[],
        delivery_option: "standard",
      },
      order_time: "now",
      source: "volo",
      vendor: this.cartVendor,
      products: checkoutProducts,
      payment: {
        client_redirect_url: `${getRegionConfig().webHost}/payments/handle-payment/`,
        purchase_intent_id: purchaseIntentId,
        currency: getRegionConfig().currency,
        methods: paymentMethodsPayload,
      },
      voucher: "",
      voucher_context: { construct_id: "" },
      bypass_duplicate_order_check: false,
      supported_features: {
        support_banned_products_soft_fail: true,
        small_order_fee_enabled: true,
        "pd-tx-cash-to-online-payment-surcharge": false,
      },
      joker_offer_id: "",
      joker: { single_discount: true },
    };

    interface CheckoutResponse {
      id?: string;
      order?: {
        code?: string;
        order_code?: string;
        status?: string;
        estimated_delivery_time?: string;
      };
      code?: string;
      order_code?: string;
      status?: string;
      data?: {
        order_code?: string;
        code?: string;
        status?: string;
      };
      payment?: {
        result?: string;
        purchase_id?: string;
        action?: string | null;
        reason?: string;
      };
      expedition?: {
        expected_delivery_duration?: number;
      };
      redirect_url?: string;
      errors?: Array<{ message?: string; code?: string }>;
      error?: string;
      message?: string;
    }

    const result = await this.restRequest<CheckoutResponse>(
      "/api/v5/cart/checkout",
      {
        method: "POST",
        body: JSON.stringify(checkoutBody),
        headers: {
          "dps-session-id": dpsSessionId,
          "x-caller-platform": "mfe",
          "x-global-entity-id": "FP_PH",
        },
      }
    );

    // Log the response for debugging, without names, phones, addresses or tokens
    console.error("[placeOrder] checkout response:", redactForLog(result));

    // Check for error indicators in the response body
    if (result.errors && result.errors.length > 0) {
      const messages = result.errors
        .map((e) => e.message || e.code || "unknown error")
        .join("; ");
      throw new Error(`Checkout failed: ${messages}`);
    }
    if (result.error) {
      throw new Error(`Checkout failed: ${result.error}`);
    }
    if (result.message && !result.order && !result.code && !result.order_code && !result.data) {
      throw new Error(`Checkout failed: ${result.message}`);
    }

    // Handle redirect_url (e.g. 3DS authentication for credit cards)
    if (result.redirect_url) {
      throw new Error(
        `Payment requires browser authentication. Please complete payment at: ${result.redirect_url}`
      );
    }

    // Extract order code — the API returns it as `id` at the top level
    const orderCode =
      result.id ??
      result.order?.code ??
      result.order?.order_code ??
      result.code ??
      result.order_code ??
      result.data?.order_code ??
      result.data?.code ??
      null;

    if (!orderCode) {
      console.error("[placeOrder] no order code found in response:", redactForLog(result));
      throw new Error(
        "Order may not have been placed — no order code in response. Check your foodpanda app/website to confirm. A redacted copy of the response was logged to server stderr."
      );
    }

    // Extract status from payment result or top-level status
    const status =
      result.payment?.result ??
      result.order?.status ??
      result.status ??
      result.data?.status ??
      "placed";

    // Capture total before clearing cart
    const finalTotal = checkoutBody.expected_total_amount;

    // Derive estimated delivery time from available response fields
    const deliveryMinutes = result.expedition?.expected_delivery_duration ?? 0;
    const estimatedDelivery =
      result.order?.estimated_delivery_time ??
      (deliveryMinutes > 0 ? `${deliveryMinutes} min` : "");

    // Only clear cart after confirmed successful order
    this.clearCart();
    this.checkoutState = null;

    return {
      order_id: orderCode,
      status,
      estimated_delivery_time: estimatedDelivery,
      total: finalTotal,
    };
  }

  // ----------------------------------------------------------------
  // Cart calculation helper
  // ----------------------------------------------------------------

  private async calculateCart(): Promise<Cart> {
    if (!this.cartVendor || this.cartProducts.length === 0) {
      throw new Error("Cart is empty. Add items first.");
    }

    const requestBody: CartCalculateRequest = {
      products: this.cartProducts,
      vendor: this.cartVendor,
      expedition: {
        type: "delivery",
        delivery_option: "standard",
        latitude: this.latitude,
        longitude: this.longitude,
      },
      voucher: "",
      voucher_context: null,
      auto_apply_voucher: false,
      joker: { single_discount: true },
      joker_offer_id: "",
      payment: { version: 1 },
      group_order: null,
      source: "",
      order_time: "",
      participants: [],
      items: null,
    };

    interface CalculateResponse {
      products: Array<{
        id: number;
        variation_id: number;
        price: number;
        original_price: number;
        quantity: number;
        is_available: boolean;
        variation_name: string;
      }>;
      expedition: {
        delivery_fee: number;
        original_delivery_fee: number;
        selected_delivery_option?: {
          delivery_fee: number;
        };
      };
      payment: {
        subtotal: number;
        service_fee: number;
        total: number;
      };
    }

    const result = await this.restRequest<CalculateResponse>(
      "/api/v5/cart/calculate?include=expedition",
      {
        method: "POST",
        body: JSON.stringify(requestBody),
      }
    );

    // Update local cart state from server response
    this.cartSubtotal = result.payment?.subtotal ?? 0;
    this.cartServiceFee = result.payment?.service_fee ?? 0;
    this.cartTotal = result.payment?.total ?? 0;
    this.cartDeliveryFee =
      result.expedition?.selected_delivery_option?.delivery_fee ??
      result.expedition?.delivery_fee ??
      0;

    // Rebuild cartItems from the response + our stored payloads
    const cached = this.menuCache.get(this.cartVendor!.code);
    this.cartItems = this.cartProducts.map((payload, idx) => {
      // Match server response by (id, variation_id) instead of index
      const serverProduct = result.products?.find(
        (sp) => sp.id === payload.id && sp.variation_id === payload.variation_id
      );
      const quantity = serverProduct?.quantity ?? payload.quantity;
      const unitPrice = serverProduct?.price ?? payload.price;

      // Resolve topping names from flat lookup map
      const toppingDetails: Array<{
        id: number;
        name: string;
        price: number;
      }> = [];
      if (cached) {
        for (const tGroup of payload.toppings) {
          for (const tOpt of tGroup.options) {
            const opt = cached.toppingOptionsById.get(tOpt.id);
            if (opt) {
              toppingDetails.push(opt);
            }
          }
        }
      }

      return {
        cart_item_id: this.cartItemIds[idx],
        product_id: payload.id,
        variation_id: payload.variation_id,
        code: payload.code,
        name: payload.variation_name,
        quantity,
        unit_price: unitPrice,
        total_price: unitPrice * quantity,
        toppings: toppingDetails,
        special_instructions: payload.special_instructions,
      };
    });

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
