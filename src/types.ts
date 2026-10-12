// --- Public types exposed to MCP tool responses ---

export interface Restaurant {
  id: string; // vendor code, e.g. "p7nl"
  name: string;
  cuisine: string[];
  rating: number;
  review_count: number;
  delivery_fee: number;
  delivery_time: string; // e.g. "15-25 min"
  minimum_order: number;
  distance_km: number;
  is_open: boolean;
  chain_code?: string;    // e.g. "cg0ep" — present for chain restaurants
  chain_name?: string;    // e.g. "Jollibee"
  total_outlets?: number; // e.g. 17 — use list_outlets to see all branches
}

export interface RestaurantDetails extends Restaurant {
  address: string;
  description: string;
  hero_image: string;
  logo: string;
  opening_hours: ScheduleEntry[];
  is_delivery_available: boolean;
}

export interface ScheduleEntry {
  weekday: number; // 1=Monday ... 7=Sunday
  opening_type: string;
  opening_time: string;
  closing_time: string;
}

export interface MenuItem {
  id: number;
  code: string;
  name: string;
  description: string;
  price: number;
  image_url: string;
  is_sold_out: boolean;
  variation: {
    id: number;
    code: string;
    price: number;
  };
  /** Every variation (size) of the product; `variation` is the first one. */
  variations?: Array<{ id: number; code: string; price: number }>;
  /** The product has choice groups (options, add-ons); get_item_details lists them. */
  is_customizable?: boolean;
  /** Filled in by get_item_details; empty in get_menu. */
  topping_groups: ToppingGroup[];
}

export interface ToppingGroup {
  id: number;
  name: string;
  quantity_minimum: number;
  quantity_maximum: number;
  options: ToppingOption[];
  /** Set when the group is a kind the tw capture never showed; such a group cannot be ordered. */
  unsupported?: string;
}

export interface ToppingOption {
  id: number;
  product_id: number;
  name: string;
  price: number;
  is_sold_out?: boolean;
  /** The option opens its own nested choices, which this server cannot build yet. */
  has_nested_choices?: boolean;
}

export interface MenuCategory {
  name: string;
  items: MenuItem[];
}

export interface CartItem {
  cart_item_id: string;
  product_id: number;
  variation_id: number;
  code: string;
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  toppings: CartItemTopping[];
  special_instructions: string;
  /** false when foodpanda reports the item unavailable at validation. */
  is_available?: boolean;
}

export interface CartItemTopping {
  id: number;
  name: string;
  price: number;
}

export interface Cart {
  restaurant_id: string;
  restaurant_name: string;
  items: CartItem[];
  subtotal: number;
  delivery_fee: number;
  service_fee: number;
  total: number;
}

export interface OrderResult {
  order_id: string;
  status: string;
  estimated_delivery_time: string;
  total: number;
}

// --- Checkout-related types ---

export interface CustomerProfile {
  id: string; // numeric ID, e.g. "59300155"
  code: string; // customer code, e.g. "phkb47lw"
  first_name: string;
  last_name: string;
  email: string;
  mobile_number: string;
  mobile_country_code: string;
}

/** Raw delivery address from /api/v5/customers/addresses */
export interface DeliveryAddress {
  id: number;
  city_id: number;
  city: string;
  city_name: string | null;
  area_id: number | null;
  areas: unknown;
  address_line1: string;
  address_line2: string;
  address_line3: string | null;
  address_line4: string | null;
  address_line5: string | null;
  address_other: string | null;
  room: string | null;
  flat_number: string | null;
  structure: string | null;
  building: string;
  intercom: string | null;
  entrance: string | null;
  floor: string | null;
  district: string | null;
  postcode: string | null;
  meta: string;
  company: string | null;
  longitude: number;
  latitude: number;
  is_delivery_available: boolean;
  formatted_customer_address: string;
  delivery_instructions: string;
  title: string | null;
  type: number;
  label: string | null;
  formatted_address: string | null;
  is_same_as_requested_location: boolean | null;
  campus: string | null;
  corporate_reference_id: string | null;
  form_id: string;
  country_code: string;
  country_iso: string;
  created_at: string;
  updated_at: string;
  phone_number: string | null;
  phone_country_code: string | null;
  block: string | null;
  property_type: string | null;
  place_name: string | null;
  landmark: string | null;
  meeting_point: string | null;
  door_code: string | null;
  free_text_address: string | null;
  gate: string | null;
  entrance_picture: string | null;
  hyperlocal_fields: string;
  entrance_latitude: number | null;
  entrance_longitude: number | null;
}

export interface PaymentMethodInfo {
  name: string; // e.g. "payment_on_delivery", "generic_creditcard"
  display_name: string; // e.g. "Cash on Delivery", "Mastercard ending 0004"
  instrument_id: string | null; // publicId for saved instruments
  /** For saved credit cards: card details needed for checkout payload */
  card_details?: {
    scheme: string;
    last_4_digits: string;
    bin: string;
    owner: string;
    valid_to_month: number;
    valid_to_year: number;
  };
}

export interface OrderPreview {
  cart: Cart;
  delivery_address: {
    id: number;
    label: string | null;
    formatted_address: string;
    delivery_instructions: string;
  };
  payment_methods: PaymentMethodInfo[];
}

export interface AddToCartInput {
  item_id: string; // product code (e.g. "ct-36-pd-1673")
  quantity: number;
  variation_id?: string;
  topping_ids?: string[];
  special_instructions?: string;
}

// --- Internal types for cart calculation API payloads ---

export interface CartProductPayload {
  id: number;
  variation_id: number;
  code: string;
  variation_code: string;
  variation_name: string;
  quantity: number;
  price: number;
  original_price: number;
  packaging_charge: number;
  vat_percentage: number;
  special_instructions: string;
  sold_out_option: string;
  toppings: CartToppingPayload[];
  products: never[];
  tags: never[];
  menu_category_code: null;
  menu_category_id: null;
  menu_id: null;
  group_id: null;
  group_order_user_id: number;
}

/**
 * One selected choice, as the tw web app sends it to cart/calculate: a flat list of
 * choices (no group nesting), each with its own price.
 */
export interface CartToppingPayload {
  id: number;
  name: string;
  price: number;
  vat_percentage: null;
  original_price: number;
  quantity: number;
}

export interface CartVendorPayload {
  code: string;
  latitude: number;
  longitude: number;
  marketplace: boolean;
  vertical: string;
}

/** cart/calculate body, field for field as the tw web app sends it (no address or payment yet). */
export interface CartCalculateRequest {
  products: CartProductPayload[];
  vendor: CartVendorPayload;
  expedition: {
    expedition_options: null;
    address_delivery_instructions: null;
    rider_tip: null;
    delivery_option: string;
    instructions: string;
    delivery_instructions_tags: null;
    type: string;
    latitude: number;
    longitude: number;
    corporate_location_id: number;
  };
  voucher: string;
  voucher_context: null;
  auto_apply_voucher: boolean;
  supported_features: Record<string, boolean>;
  joker_offer_id: string;
  payment: {
    loyalty: { balance: null; points: number; selected_promotion_id: string };
    methods: never[];
    allowance_amount: number;
  };
  group_order: null;
  source: string;
  order_time: string;
  participants: never[];
  items: null;
}
