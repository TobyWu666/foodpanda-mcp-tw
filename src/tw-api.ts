/**
 * Request bodies and response parsing for the foodpanda Taiwan web API.
 *
 * Everything here mirrors traffic captured on www.foodpanda.com.tw (see findings.md):
 * operation names, variables, display contexts and response fields. Nothing in this
 * module talks to the network, so it can be tested against the masked capture.
 */

import type {
  CartCalculateRequest,
  CartItem,
  CartProductPayload,
  CartVendorPayload,
  MenuCategory,
  MenuItem,
  Restaurant,
  RestaurantDetails,
  ScheduleEntry,
  ToppingGroup,
} from "./types.js";

// ----------------------------------------------------------------
// GraphQL operations
// ----------------------------------------------------------------

export interface GraphqlOperation {
  /** Sent as x-apollo-operation-name, as the web app does. */
  name: string;
  /** display-context header the web app sends with this operation. */
  displayContext: string;
  body: Record<string, unknown>;
}

interface Where {
  latitude: number;
  longitude: number;
  locale: string;
  languageId: number | null;
}

const languageIdOf = (w: Where) => (w.languageId !== null ? { languageId: w.languageId } : {});

function persisted(hash: string) {
  return { persistedQuery: { version: 1, sha256Hash: hash } };
}

export function searchOperation(hash: string, query: string, where: Where): GraphqlOperation {
  return {
    name: "SearchResults",
    displayContext: "SEARCH",
    body: {
      operationName: "SearchResults",
      variables: {
        searchResultsParams: {
          query,
          latitude: where.latitude,
          longitude: where.longitude,
          locale: where.locale,
          ...languageIdOf(where),
          expeditionType: "DELIVERY",
          customerType: "B2C",
          verticalTypes: ["RESTAURANTS"],
        },
        skipQueryCorrection: true,
      },
      extensions: persisted(hash),
    },
  };
}

export function chainOutletsOperation(hash: string, chainCode: string, where: Where): GraphqlOperation {
  return {
    name: "GetVendorListPage",
    displayContext: "RLP",
    body: {
      operationName: "GetVendorListPage",
      variables: {
        input: {
          expeditionType: "DELIVERY",
          latitude: where.latitude,
          locale: where.locale,
          longitude: where.longitude,
          customerType: "B2C",
          ...languageIdOf(where),
          page: "CHAIN_LISTING_PAGE",
          availabilityFilters: { chainCodes: [chainCode] },
        },
      },
      extensions: persisted(hash),
    },
  };
}

export function restaurantDetailsOperation(hash: string, vendorCode: string): GraphqlOperation {
  return {
    name: "GetRestaurantDetailsPage",
    displayContext: "RESTAURANT_DETAIL_PAGE",
    body: {
      operationName: "GetRestaurantDetailsPage",
      variables: {
        input: { code: vendorCode, expeditionType: "DELIVERY" },
        restaurantMenuFilter: { expeditionType: "DELIVERY" },
        recommendationInput: { expeditionType: "DELIVERY", isMealForOne: false },
        discountedPriceInput: { expeditionType: "DELIVERY" },
      },
      extensions: persisted(hash),
    },
  };
}

/** The web app sends this one without an operationName in the body. */
export function productOperation(
  hash: string,
  vendorCode: string,
  productId: number | string,
  menuId: string
): GraphqlOperation {
  return {
    name: "RestaurantProductQuery",
    displayContext: "ITEM_MODIFIER",
    body: {
      extensions: persisted(hash),
      variables: {
        isPreconfiguredToppingsEnabled: false,
        recommendedChoiceGroupsInput: { isMealForOne: false, expeditionType: "DELIVERY" },
        input: {
          productID: String(productId),
          vendorCode,
          expeditionType: "DELIVERY",
          menuID: menuId,
        },
        discountedPriceInput: { expeditionType: "DELIVERY" },
        includeVendor: true,
      },
    },
  };
}

// ----------------------------------------------------------------
// Vendors (search results, chain outlets, details page)
// ----------------------------------------------------------------

interface VendorTileGroup {
  id: string;
  elements?: Array<{ text?: string }>;
}

interface GqlVendor {
  code: string;
  name: string;
  availability?: { status?: string; distanceInMeters?: number };
  vendorRating?: { value?: number; count?: number };
  dynamicPricing?: {
    deliveryFee?: { total?: number };
    minimumOrderValue?: { total?: number };
  };
  timeEstimations?: {
    delivery?: { duration?: { lowerLimitInMinutes: number; upperLimitInMinutes: number } } | null;
  };
  vendorTile?: { vendorInfo?: VendorTileGroup[][] };
  vendorChainData?: { code?: string; name?: string } | null;
  characteristics?: { cuisines?: Array<{ name: string }> | null };
}

function cuisinesOf(v: GqlVendor): string[] {
  if (v.characteristics?.cuisines) return v.characteristics.cuisines.map((c) => c.name);
  const out: string[] = [];
  for (const row of v.vendorTile?.vendorInfo ?? []) {
    for (const group of row) {
      if (group.id !== "VENDOR_INFO_CUISINES") continue;
      for (const el of group.elements ?? []) if (el.text) out.push(el.text);
    }
  }
  return out;
}

export function toRestaurant(v: GqlVendor, totalChainVendors?: number | null): Restaurant {
  const d = v.timeEstimations?.delivery?.duration;
  const r: Restaurant = {
    id: v.code,
    name: v.name,
    cuisine: cuisinesOf(v),
    rating: v.vendorRating?.value ?? 0,
    review_count: v.vendorRating?.count ?? 0,
    delivery_fee: v.dynamicPricing?.deliveryFee?.total ?? 0,
    delivery_time: d ? `${d.lowerLimitInMinutes}-${d.upperLimitInMinutes} min` : "N/A",
    minimum_order: v.dynamicPricing?.minimumOrderValue?.total ?? 0,
    distance_km: Math.round((v.availability?.distanceInMeters ?? 0) / 100) / 10,
    is_open: v.availability?.status === "OPEN",
  };
  // tw puts the chain inside vendorData (upstream PH read it off the component).
  if (v.vendorChainData?.code) {
    r.chain_code = v.vendorChainData.code;
    if (v.vendorChainData.name) r.chain_name = v.vendorChainData.name;
  }
  if (totalChainVendors && totalChainVendors > 1) r.total_outlets = totalChainVendors;
  return r;
}

export function parseSearchResults(resp: any): Restaurant[] {
  const components: any[] = resp?.data?.searchPage?.components ?? [];
  return components
    .filter((c) => c?.vendorData)
    .map((c) => toRestaurant(c.vendorData, c.totalChainVendors));
}

export function parseChainOutlets(resp: any): Restaurant[] {
  const components: any[] = resp?.data?.vendorListingPage?.components ?? [];
  return components.filter((c) => c?.vendorData).map((c) => toRestaurant(c.vendorData));
}

const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function schedulesOf(weekly: any): ScheduleEntry[] {
  const out: ScheduleEntry[] = [];
  WEEKDAYS.forEach((day, i) => {
    for (const slot of weekly?.[day]?.delivery ?? []) {
      const range = slot?.timeOfDayRange;
      if (!range) continue;
      out.push({ weekday: i + 1, opening_type: "delivery", opening_time: range.from, closing_time: range.to });
    }
  });
  return out;
}

function menuItemOf(p: any): MenuItem {
  const variations = (p.variations ?? []).map((v: any) => ({
    id: Number(v.id),
    code: String(v.code ?? ""),
    price: Number(v.price ?? 0),
  }));
  const first = variations[0] ?? { id: 0, code: "", price: 0 };
  return {
    id: Number(p.id),
    code: String(p.code ?? ""),
    name: String(p.title ?? ""),
    description: p.description ?? "",
    price: first.price,
    image_url: p.image?.url ?? "",
    is_sold_out: p.isSoldOut === true,
    variation: first,
    variations,
    is_customizable: p.isCustomizable === true,
    topping_groups: [],
  };
}

export interface RestaurantPage {
  details: RestaurantDetails;
  categories: MenuCategory[];
  /** Needed by RestaurantProductQuery. */
  menuId: string;
  /** The vendor's own location, sent back in cart/calculate's `vendor`. */
  latitude: number;
  longitude: number;
}

export function parseRestaurantPage(resp: any): RestaurantPage {
  const v = resp?.data?.restaurantDetailsPage?.vendorData;
  if (!v?.code) throw new Error("Restaurant not found (no vendorData in the response).");
  const base = toRestaurant(v);
  const menu = v.menu ?? {};
  const details: RestaurantDetails = {
    ...base,
    address: v.location?.addressLine1 ?? "",
    description: v.description ?? "",
    hero_image: v.images?.listing ?? "",
    logo: v.images?.logo ?? "",
    opening_hours: schedulesOf(v.schedules?.weekly),
    is_delivery_available: v.isActive !== false && v.isDeliveryEnabled === true,
  };
  const categories: MenuCategory[] = (menu.categories ?? []).map((c: any) => ({
    name: String(c.title ?? ""),
    items: (c.products ?? []).map(menuItemOf),
  }));
  return {
    details,
    categories,
    menuId: String(menu.id ?? ""),
    latitude: Number(v.location?.latitude ?? 0),
    longitude: Number(v.location?.longitude ?? 0),
  };
}

// ----------------------------------------------------------------
// Product choices (options and add-ons)
// ----------------------------------------------------------------

/** Choice groups of one variation of a product. */
export function parseProductChoices(resp: any, variationId: number): ToppingGroup[] {
  const product = resp?.data?.restaurantProduct;
  if (!product) throw new Error("Product not found (no restaurantProduct in the response).");
  const variations: any[] = product.variations ?? [];
  const variation = variations.find((v) => Number(v.id) === variationId);
  if (!variation) {
    throw new Error(`Variation ${variationId} is not offered for this product any more. Reload the menu.`);
  }
  return (variation.choiceGroups ?? []).map((g: any) => {
    const unsupported = unsupportedGroupReason(g);
    return {
      id: Number(g.id),
      name: String(g.title ?? ""),
      quantity_minimum: Number(g.quantityMinimum ?? 0),
      quantity_maximum: Number(g.quantityMaximum ?? 0),
      options: (g.choices ?? []).map((c: any) => ({
        id: Number(c.id),
        product_id: Number(c.choiceProductID),
        name: String(c.title ?? ""),
        price: Number(c.price ?? 0),
        ...(c.isSoldOut ? { is_sold_out: true } : {}),
        ...(c.product ? { has_nested_choices: true } : {}),
      })),
      ...(unsupported ? { unsupported } : {}),
    };
  });
}

/**
 * The capture only shows single-select groups: choiceGroupType CHOICE_GROUP,
 * choiceSelectionUI RADIO, one pick per group and per choice. The cart line format
 * for any other kind (multi-select, several of one choice) is unverified, so such
 * a group is flagged rather than sent in a guessed shape.
 */
function unsupportedGroupReason(g: any): string | null {
  if (g.choiceGroupType !== "CHOICE_GROUP") return `group type ${g.choiceGroupType ?? "missing"}`;
  if (g.choiceSelectionUI !== "RADIO") return `selection type ${g.choiceSelectionUI ?? "missing"}`;
  if (Number(g.quantityMaximum) !== 1) return `up to ${g.quantityMaximum ?? "?"} picks`;
  if ((g.choices ?? []).some((c: any) => Number(c.quantityMaximum) !== 1)) return "several of one option";
  return null;
}

/** Largest quantity of one cart line. */
export const MAX_LINE_QUANTITY = 50;

export function checkQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    throw new Error(`Quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}, got ${quantity}.`);
  }
}

// ----------------------------------------------------------------
// Cart
// ----------------------------------------------------------------

/**
 * Check a choice selection against the product's groups. Throws an error the agent can act
 * on (which group, what is allowed) instead of letting foodpanda reject or reprice the item.
 */
export function selectChoices(
  itemName: string,
  groups: ToppingGroup[],
  selectedIds: Array<number | string>
): Array<{ id: number; name: string; price: number }> {
  const byId = new Map<number, { group: ToppingGroup; option: ToppingGroup["options"][number] }>();
  for (const group of groups) for (const option of group.options) byId.set(option.id, { group, option });

  const picked: Array<{ id: number; name: string; price: number }> = [];
  const perGroup = new Map<number, number>();
  for (const raw of selectedIds) {
    const id = Number(raw);
    const hit = byId.get(id);
    if (!hit) {
      throw new Error(
        `Option ${raw} is not an option of "${itemName}". Use get_item_details to see its options.`
      );
    }
    if (hit.option.is_sold_out) throw new Error(`"${hit.option.name}" is sold out.`);
    if (hit.option.has_nested_choices) {
      throw new Error(`"${hit.option.name}" has its own nested choices, which this server cannot order yet.`);
    }
    perGroup.set(hit.group.id, (perGroup.get(hit.group.id) ?? 0) + 1);
    picked.push({ id, name: hit.option.name, price: hit.option.price });
  }

  // A kind of group the capture never showed cannot be sent in a verified shape.
  for (const group of groups) {
    if (group.unsupported && (group.quantity_minimum > 0 || perGroup.has(group.id))) {
      throw new Error(
        `"${itemName}" has a choice group this server cannot order yet ("${group.name}", ${group.unsupported}).`
      );
    }
  }

  // Report every missing required group at once, so the agent can ask the user in one go.
  const missing: string[] = [];
  for (const group of groups) {
    const n = perGroup.get(group.id) ?? 0;
    if (n < group.quantity_minimum) {
      const choices = group.options
        .filter((o) => !o.is_sold_out)
        .map((o) => `${o.id} ${o.name}${o.price ? ` (+${o.price})` : ""}`)
        .join("; ");
      missing.push(
        `${group.quantity_minimum} choice(s) from "${group.name}" (group ${group.id}). Options: ${choices}`
      );
    }
    if (group.quantity_maximum > 0 && n > group.quantity_maximum) {
      throw new Error(
        `"${itemName}" allows at most ${group.quantity_maximum} choice(s) from "${group.name}", got ${n}.`
      );
    }
  }
  if (missing.length === 1) throw new Error(`"${itemName}" needs ${missing[0]}`);
  if (missing.length > 1) {
    throw new Error(`"${itemName}" needs:\n${missing.map((m) => `- ${m}`).join("\n")}`);
  }
  return picked;
}

/** One cart line, as the tw web app sends it: the unit price already includes the choices. */
export function buildCartProduct(
  item: MenuItem,
  variation: { id: number; code: string; price: number },
  choices: Array<{ id: number; name: string; price: number }>,
  quantity: number,
  specialInstructions: string
): CartProductPayload {
  checkQuantity(quantity);
  const unitPrice = variation.price + choices.reduce((sum, c) => sum + c.price, 0);
  return {
    vat_percentage: 0,
    code: item.code,
    special_instructions: specialInstructions,
    variation_code: variation.code,
    menu_category_code: null,
    menu_category_id: null,
    menu_id: null,
    group_id: null,
    sold_out_option: "REFUND",
    variation_name: item.name,
    products: [],
    toppings: choices.map((c) => ({
      id: c.id,
      name: c.name,
      price: c.price,
      vat_percentage: null,
      // The web app sends 0 here even for priced choices; mirrored as captured.
      original_price: 0,
      quantity: 1,
    })),
    tags: [],
    original_price: unitPrice,
    packaging_charge: 0,
    price: unitPrice,
    group_order_user_id: 0,
    quantity,
    variation_id: variation.id,
    id: item.id,
  };
}

export function buildCalculateRequest(
  products: CartProductPayload[],
  vendor: CartVendorPayload,
  latitude: number,
  longitude: number
): CartCalculateRequest {
  return {
    auto_apply_voucher: false,
    supported_features: {
      support_voucher_soft_fail: true,
      support_banned_products_soft_fail: true,
      small_order_fee_enabled: true,
      "pd-qc-weight-stepper": false,
      "pd-tx-cash-to-online-payment-surcharge": false,
      product_sampling: false,
      sustainability_fees_enabled: true,
    },
    payment: {
      loyalty: { balance: null, points: 0, selected_promotion_id: "" },
      methods: [],
      allowance_amount: 0,
    },
    group_order: null,
    voucher_context: null,
    joker_offer_id: "",
    source: "",
    voucher: "",
    order_time: "now",
    expedition: {
      expedition_options: null,
      address_delivery_instructions: null,
      rider_tip: null,
      delivery_option: "standard",
      instructions: "",
      delivery_instructions_tags: null,
      type: "delivery",
      latitude,
      longitude,
      corporate_location_id: 0,
    },
    vendor,
    participants: [],
    items: null,
    products,
  };
}

export interface CalculatedCart {
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  total: number;
  /** Per cart line, in the order the lines were sent. */
  lines: Array<{ unitPrice: number; quantity: number; isAvailable: boolean }>;
}

/** Totals and per-line prices from a cart/calculate response. */
export function parseCalculate(resp: any, sent: CartProductPayload[]): CalculatedCart {
  const products: any[] = resp?.products ?? [];
  // A product can appear on several lines with different choices, so match in order.
  const used = new Set<number>();
  const lines = sent.map((p) => {
    const idx = products.findIndex(
      (sp, i) => !used.has(i) && sp.id === p.id && sp.variation_id === p.variation_id
    );
    if (idx < 0) return { unitPrice: p.price, quantity: p.quantity, isAvailable: false };
    used.add(idx);
    const sp = products[idx];
    return {
      unitPrice: Number(sp.price ?? p.price),
      quantity: Number(sp.quantity ?? p.quantity),
      isAvailable: sp.is_available !== false,
    };
  });
  return {
    subtotal: resp?.payment?.subtotal ?? 0,
    serviceFee: resp?.payment?.service_fee ?? 0,
    total: resp?.payment?.total ?? 0,
    deliveryFee:
      resp?.expedition?.selected_delivery_option?.delivery_fee ?? resp?.expedition?.delivery_fee ?? 0,
    lines,
  };
}

/** Cart lines for tool output, from what was sent and what foodpanda priced. */
export function cartItemsOf(
  sent: CartProductPayload[],
  ids: string[],
  calc: CalculatedCart
): CartItem[] {
  return sent.map((p, i) => {
    const line = calc.lines[i];
    return {
      cart_item_id: ids[i],
      product_id: p.id,
      variation_id: p.variation_id,
      code: p.code,
      name: p.variation_name,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      total_price: line.unitPrice * line.quantity,
      toppings: p.toppings.map((t) => ({ id: t.id, name: t.name, price: t.price })),
      special_instructions: p.special_instructions,
      is_available: line.isAvailable,
    };
  });
}
