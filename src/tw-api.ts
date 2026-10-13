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
  DeliveryAddress,
  MenuCategory,
  MenuItem,
  Restaurant,
  RestaurantDetails,
  ScheduleEntry,
  ToppingGroup,
} from "./types.js";
import { type PaymentMethodChoice, UnsupportedPaymentMethodError } from "./payment-method.js";

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
  /**
   * total minus (subtotal + delivery fee + service fee): what foodpanda charges that this
   * server does not itemise, e.g. a small-order fee. 0 when the parts add up.
   */
  otherCharges: number;
  /** small_order_fee.soft_minimum_order_value.amount and small_order_fee.cap, when sent. */
  smallOrder: { minimum: number; cap: number | null } | null;
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
  const subtotal = resp?.payment?.subtotal ?? 0;
  const serviceFee = resp?.payment?.service_fee ?? 0;
  const total = resp?.payment?.total ?? 0;
  const deliveryFee =
    resp?.expedition?.selected_delivery_option?.delivery_fee ?? resp?.expedition?.delivery_fee ?? 0;
  const soft = resp?.small_order_fee?.soft_minimum_order_value;
  const cap = resp?.small_order_fee?.cap;
  return {
    subtotal,
    serviceFee,
    total,
    deliveryFee,
    otherCharges: Math.round((total - subtotal - deliveryFee - serviceFee) * 100) / 100,
    smallOrder:
      typeof soft?.amount === "number"
        ? { minimum: soft.amount, cap: typeof cap === "number" ? cap : null }
        : null,
    lines,
  };
}

/**
 * The part of the total that subtotal, delivery fee and service fee do not explain, for
 * tool output, so the user sees where every dollar goes. foodpanda's own name for it is not
 * known: the tw capture only has orders above the minimum, where the parts add up.
 */
export function otherChargesOf(
  calc: Pick<CalculatedCart, "subtotal" | "otherCharges" | "smallOrder">
): { other_charges?: number; other_charges_note?: string } {
  if (!calc.otherCharges) return {};
  const below = calc.smallOrder && calc.subtotal < calc.smallOrder.minimum;
  return {
    other_charges: calc.otherCharges,
    other_charges_note: below
      ? `Not itemised by foodpanda's reply. The subtotal is below the restaurant's minimum order of ` +
        `${calc.smallOrder!.minimum}${calc.smallOrder!.cap !== null ? ` (small-order fee cap ${calc.smallOrder!.cap})` : ""}, ` +
        `so this is most likely the small-order fee. The total already includes it.`
      : "Not itemised by foodpanda's reply; the total already includes it. Check the app for the breakdown.",
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

// ----------------------------------------------------------------
// Payment (bound LINE Pay and cash only)
// ----------------------------------------------------------------

/**
 * foodpanda's own ids for the two methods this server may use, from the tw capture:
 * the purchase/intent method name and the displayable_name the web app puts in
 * cart/calculate payment.methods[0] when the method is selected.
 */
export const FOODPANDA_PAYMENT_METHODS: Record<
  PaymentMethodChoice,
  { method: string; displayableName: string; label: string }
> = {
  linepay: {
    method: "line_pay",
    displayableName: "NEXTGEN_PAYMENT_SELECTION_LINE_PAY",
    label: "LINE Pay (bound account)",
  },
  cash: {
    method: "payment_on_delivery",
    displayableName: "NEXTGEN_PAYMENT_SELECTION_PAYMENT_ON_DELIVERY",
    label: "Cash on delivery",
  },
};

/** A payment method the account can use for this order, with the instrument to charge. */
export interface PaymentOption {
  choice: PaymentMethodChoice;
  method: string;
  displayableName: string;
  /** publicId of the saved instrument (the bound LINE Pay account, or the cash instrument). */
  publicId: string;
  label: string;
}

export interface PurchaseIntent {
  intentId: string;
  options: PaymentOption[];
  /** Methods foodpanda offers that this server will not use (shown to the user, never used). */
  notSupported: string[];
  /** Supported methods that are not usable right now, and why. */
  unavailable: Array<{ choice: PaymentMethodChoice; reason: string }>;
}

/** The purchase/intent body, exactly as the tw web app sends it. */
export function purchaseIntentRequest(
  vendorCode: string,
  subtotal: number,
  total: number,
  currency: string
): Record<string, unknown> {
  return {
    subtotal,
    currency,
    vendorCode,
    amount: total,
    emoneyAmountToUse: 0,
    expeditionType: "delivery",
    paymentLimits: [
      { limitCode: "foodafterdiscount", limitAmount: subtotal },
      { limitCode: "orderamountwithoutpaymentfee", limitAmount: total },
    ],
  };
}

/**
 * Which of LINE Pay and cash the account can use. LINE Pay counts only with a saved
 * (bound) instrument: without one, paying would need the LINE app, which this
 * server cannot do.
 */
export function parsePurchaseIntent(resp: any): PurchaseIntent {
  const data = resp?.data;
  const intentId = data?.purchaseIntent?.id;
  if (typeof intentId !== "string" || !intentId) {
    throw new Error("purchase/intent returned no purchase intent id.");
  }
  const methods: any[] = data?.paymentMethodDetails?.paymentMethods ?? [];
  const options: PaymentOption[] = [];
  const unavailable: PurchaseIntent["unavailable"] = [];
  const notSupported: string[] = [];

  for (const choice of Object.keys(FOODPANDA_PAYMENT_METHODS) as PaymentMethodChoice[]) {
    const ids = FOODPANDA_PAYMENT_METHODS[choice];
    const pm = methods.find((m) => m?.name === ids.method);
    if (!pm || pm.hidden) {
      unavailable.push({ choice, reason: "not offered for this order" });
      continue;
    }
    if (pm.status !== "HEALTHY") {
      unavailable.push({ choice, reason: `status ${pm.status ?? "unknown"}` });
      continue;
    }
    const instruments: any[] = (pm.paymentInstruments ?? []).filter(
      (i: any) => i?.status === "HEALTHY" && typeof i?.publicId === "string" && i.publicId
    );
    if (instruments.length === 0) {
      unavailable.push({
        choice,
        reason: choice === "linepay" ? "no bound LINE Pay account" : "no usable instrument",
      });
      continue;
    }
    const instrument = instruments.find((i) => i.preferred) ?? instruments[0];
    const shown = instrument.publicFields?.displayValue;
    options.push({
      choice,
      method: ids.method,
      displayableName: ids.displayableName,
      publicId: instrument.publicId,
      label: choice === "linepay" && shown ? `${ids.label} ${shown}` : ids.label,
    });
  }

  const ours = new Set(Object.values(FOODPANDA_PAYMENT_METHODS).map((m) => m.method));
  for (const pm of methods) {
    if (pm && !pm.hidden && typeof pm.name === "string" && !ours.has(pm.name)) notSupported.push(pm.name);
  }
  return { intentId, options, notSupported, unavailable };
}

/** The cart/calculate body with a payment method selected, as the web app sends it. */
export function withPaymentMethod(
  request: CartCalculateRequest,
  option: PaymentOption,
  amount: number
): CartCalculateRequest {
  return {
    ...request,
    payment: {
      ...request.payment,
      methods: [
        {
          method: option.method,
          amount,
          publicId: option.publicId,
          displayable_name: option.displayableName,
        },
      ],
    },
  };
}

/**
 * foodpanda echoes the selected method in the calculate response. Anything else
 * means it did not take our choice, and we must not carry on with another method.
 */
export function checkCalculatedPayment(resp: any, option: PaymentOption): void {
  const methods: any[] = resp?.payment?.methods ?? [];
  if (methods.length !== 1 || methods[0]?.method !== option.method) {
    const got = methods.map((m) => m?.method ?? "?").join(", ") || "none";
    throw new UnsupportedPaymentMethodError(
      `${option.choice} (foodpanda answered with: ${got})`,
      []
    );
  }
}

// ----------------------------------------------------------------
// Checkout
// ----------------------------------------------------------------

export interface CheckoutInput {
  products: CartProductPayload[];
  /** Menu data for each cart line, for the descriptive fields checkout carries. */
  menuItem: (productId: number) => MenuItem | undefined;
  vendor: CartVendorPayload;
  customer: { id: string; email: string };
  /** The saved address, as returned by /customers/addresses. */
  address: DeliveryAddress;
  deliveryInstructions: string;
  total: number;
  intentId: string;
  option: PaymentOption;
  webHost: string;
  currency: string;
}

/**
 * The cart/checkout body. UNVERIFIED FOR TW: checkout was never captured on
 * foodpanda.com.tw (no order was placed while recording), so this is the upstream
 * HK/PH structure filled with tw values. The payment entry follows the upstream
 * format { amount, metadata: { token: publicId }, method }.
 */
export function buildCheckoutRequest(input: CheckoutInput): Record<string, unknown> {
  const { address } = input;
  const products = input.products.map((p) => {
    const menuItem = input.menuItem(p.id);
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

  return {
    platform: "b2c",
    expected_total_amount: input.total,
    customer: {
      id: input.customer.id,
      email: input.customer.email,
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
      instructions: input.deliveryInstructions,
      delivery_instructions_tags: [] as string[],
      delivery_option: "standard",
    },
    order_time: "now",
    source: "volo",
    vendor: input.vendor,
    products,
    payment: {
      client_redirect_url: `${input.webHost}/payments/handle-payment/`,
      purchase_intent_id: input.intentId,
      currency: input.currency,
      methods: [
        {
          amount: input.total,
          metadata: { token: input.option.publicId },
          method: input.option.method,
        },
      ],
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
}

/** Said on every checkout outcome we cannot confirm: the order may or may not exist. */
export const CHECK_THE_APP =
  "Do not retry and do not call place_order again: check the foodpanda app or website for the order first.";

/**
 * checkout was sent but did not come back as a clear, finished order. The order
 * may exist, may be waiting for a payment step, or may not exist.
 */
export class CheckoutStatusUnknownError extends Error {
  readonly code = "CHECKOUT_STATUS_UNKNOWN";
  constructor(detail: string) {
    super(`The order status is unknown: ${detail} ${CHECK_THE_APP}`);
    this.name = "CheckoutStatusUnknownError";
  }
}

export interface CheckoutOutcome {
  orderCode: string;
  /** The success status foodpanda reported (never assumed). */
  status: string;
  estimatedDelivery: string;
  /** The total foodpanda reported for the order, if the response carries one. */
  reportedTotal: number | null;
  /** The payment methods foodpanda reported for the order, if the response carries them. */
  reportedMethods: string[] | null;
}

/** paymentStatus -> payment_status, so camelCase and snake_case keys are read alike. */
function normaliseKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

/** A status / result / state field, however it is prefixed (payment_status, orderStatus, ...). */
const STATUS_KEY = /(^|_)(status|result|state)$/;
/** The only status values that count as a finished order. Matched whole, so "unpaid" is not "paid". */
const SUCCESS_VALUE = /^(success|succeeded|successful|paid|completed|complete|confirmed|accepted)$/i;
/** Keys whose presence (non-empty) means the customer still has something to do. */
const PENDING_KEY =
  /redirect|action|deeplink|deep_link|app_link|applink|(^|_)url$|(^|_)uri$|(^|_)link$|challenge|3ds|(^|_)qr|next_step|webview|form_html|(^|_)location$|(^|_)target$/;

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

interface CheckoutSignals {
  /** Status-like fields with a success value, e.g. "payment.result=success". */
  success: string[];
  /** Everything that says the order or payment may not be finished. */
  pending: string[];
}

/** Objects whose status speaks for the order itself; a status on vouchers, items or incentives does not. */
const ORDER_SCOPE_KEYS = new Set(["order", "payment", "data"]);

/** Any URL: https, an app deep link (line://, intent:, another custom scheme), or a bare LINE Pay address. */
const LINK_VALUE = /^(?:[a-z][a-z0-9+.-]*:\/\/|intent:)|pay\.line\.me/i;

/**
 * Walk the whole body, every depth and array, collecting pending signs everywhere,
 * and success statuses only at the top level or inside order / payment / data.
 */
function checkoutSignals(
  body: unknown,
  path = "",
  out: CheckoutSignals = { success: [], pending: [] },
  orderScope = true
): CheckoutSignals {
  if (Array.isArray(body)) {
    body.forEach((v, i) => checkoutSignals(v, `${path}[${i}]`, out, false));
    return out;
  }
  if (!body || typeof body !== "object") {
    if (typeof body === "string" && LINK_VALUE.test(body.trim())) out.pending.push(`${path} is a link`);
    return out;
  }
  for (const [rawKey, value] of Object.entries(body as Record<string, unknown>)) {
    const key = normaliseKey(rawKey);
    const here = path ? `${path}.${rawKey}` : rawKey;
    if (STATUS_KEY.test(key)) {
      if (typeof value === "string" && SUCCESS_VALUE.test(value.trim())) {
        // A success elsewhere (a voucher, an item) says nothing about the order; it is neither.
        if (orderScope) out.success.push(`${here}=${value}`);
      } else if (value !== null && value !== undefined) {
        out.pending.push(`${here}=${JSON.stringify(value)}`);
      }
    }
    if (PENDING_KEY.test(key) && !isEmpty(value)) out.pending.push(here);
    if ((key.startsWith("requires_") || key === "is_pending" || key === "pending") && value === true) {
      out.pending.push(`${here}=true`);
    }
    if (/^(awaiting|needs|pending)_/.test(key) && !isEmpty(value) && value !== 0) out.pending.push(here);
    if ((key === "amount_due" || key === "outstanding" || key.endsWith("_outstanding")) && !isEmpty(value) && value !== 0 && value !== "0") {
      out.pending.push(`${here}=${JSON.stringify(value)}`);
    }
    if ((key === "paid" || key === "is_paid") && value === false) out.pending.push(`${here}=false`);
    checkoutSignals(value, here, out, orderScope && ORDER_SCOPE_KEYS.has(key));
  }
  return out;
}

/**
 * Read a checkout response, accepting only a clearly finished order.
 *
 * UNVERIFIED FOR TW: no tw checkout response has ever been captured, so this
 * cannot match a known success shape. It accepts an answer only when it has an
 * order code, at least one status / result / state field (top level or inside
 * order / payment / data, any key style) saying success / paid / completed / confirmed / accepted, and no
 * sign of an unfinished step anywhere: no other status value (pending, CREATED,
 * NEW, INIT, a status object, ...), no link (http(s) or an app deep link such as
 * line:// or intent://), redirect, action, deeplink, webview
 * or form, no requires_* / is_pending flag, no paid: false. Everything else is
 * "status unknown", which empties the cart and locks ordering until the user
 * has checked the app. The first real order may well land there; record its
 * response and narrow this to the real tw success shape.
 */
export function parseCheckoutResponse(resp: any): CheckoutOutcome {
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) {
    throw new CheckoutStatusUnknownError("checkout returned no readable answer.");
  }
  const errors: any[] = Array.isArray(resp.errors) ? resp.errors : [];
  if (errors.length > 0) {
    const messages = errors.map((e) => e?.message || e?.code || "unknown error").join("; ");
    throw new CheckoutStatusUnknownError(`foodpanda answered with an error (${messages}).`);
  }
  if (resp.error) throw new CheckoutStatusUnknownError(`foodpanda answered with an error (${resp.error}).`);

  const orderCode =
    resp.id ?? resp.order?.code ?? resp.order?.order_code ?? resp.code ?? resp.order_code ??
    resp.data?.order_code ?? resp.data?.code ?? null;
  const codeNote = typeof orderCode === "string" && orderCode ? ` foodpanda returned order code ${orderCode}.` : "";

  const signals = checkoutSignals(resp);
  if (signals.pending.length > 0) {
    throw new CheckoutStatusUnknownError(
      `foodpanda's answer shows an unfinished step or status (${signals.pending.slice(0, 5).join(", ")}), so the ` +
        `payment may not be complete. The order may be waiting for payment.${codeNote}`
    );
  }
  if (typeof orderCode !== "string" || !orderCode) {
    throw new CheckoutStatusUnknownError("checkout did not return an order code.");
  }
  if (signals.success.length === 0) {
    throw new CheckoutStatusUnknownError(
      `foodpanda's answer does not say the order succeeded (this server has never seen a confirmed foodpanda ` +
        `Taiwan checkout answer, so it only accepts an explicit success status).${codeNote}`
    );
  }

  const minutes = Number(resp.expedition?.expected_delivery_duration ?? 0);
  const totalValue = resp.total ?? resp.payment?.total ?? resp.payment?.payable_total ?? resp.order?.total ?? resp.data?.total;
  const methodList: any[] | null = Array.isArray(resp.payment?.methods) ? resp.payment.methods : null;
  const singleMethod = resp.payment?.method ?? resp.order?.payment_method ?? resp.data?.payment_method;
  return {
    orderCode,
    status: signals.success[0].split("=").slice(1).join("="),
    estimatedDelivery: resp.order?.estimated_delivery_time ?? (minutes > 0 ? `${minutes} min` : ""),
    reportedTotal:
      typeof totalValue === "number"
        ? totalValue
        : typeof totalValue === "string" && totalValue.trim() !== "" && !Number.isNaN(Number(totalValue))
          ? Number(totalValue)
          : null,
    reportedMethods: methodList
      ? methodList.map((m) => String(m?.method ?? m?.name ?? "?"))
      : typeof singleMethod === "string"
        ? [singleMethod]
        : null,
  };
}

/** Differences between what foodpanda says it ordered and what the user confirmed. */
export function checkoutMismatches(
  outcome: CheckoutOutcome,
  expected: { total: number; method: string }
): string[] {
  const out: string[] = [];
  if (outcome.reportedTotal !== null && outcome.reportedTotal !== expected.total) {
    out.push(`total ${outcome.reportedTotal} instead of the confirmed ${expected.total}`);
  }
  if (outcome.reportedMethods !== null && (outcome.reportedMethods.length !== 1 || outcome.reportedMethods[0] !== expected.method)) {
    out.push(`payment method ${outcome.reportedMethods.join(", ") || "none"} instead of the confirmed ${expected.method}`);
  }
  return out;
}
