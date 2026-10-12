// Strips credentials and personal data from text before it is logged to stderr or put in an
// error message. MCP clients (Claude Desktop, Claude Code) save stderr to log files on disk,
// and error messages are shown to the model, so neither should carry names, phones, addresses
// or tokens. scripts/mask-capture.mjs applies the same idea, more thoroughly, to fixtures.

const SENSITIVE_KEYS = new Set([
  // credentials
  "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "authtoken", "jwt",
  "password", "otp", "secret", "authorization", "cookie", "sessionid", "devicetoken",
  // people
  "firstname", "lastname", "fullname", "customername", "recipientname", "contactname",
  "nickname", "displayname", "username",
  "phone", "phonenumber", "mobile", "mobilenumber", "contactnumber", "msisdn",
  "email", "emailaddress",
  "customercode", "customerid", "userid",
  // address parts outside an address object (address objects themselves are dropped whole)
  "street", "streetname", "streetnumber", "building",
  "buildingname", "block", "floor", "flatnumber", "room", "housenumber", "entrance",
  "postcode", "postalcode", "zipcode", "company", "deliveryinstructions", "instructions",
  "lat", "latitude", "lng", "lon", "longitude",
]);
// `name`, `code` and `id` are personal only inside these objects (elsewhere they belong to a
// dish, a restaurant or the order).
const PERSON_OBJECTS = new Set(["customer", "user", "recipient", "contact", "profile"]);
const PERSON_KEYS = new Set(["name", "code", "id"]);

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
// `address`, `delivery_address`, `formatted_customer_address`, `address_line4`, … are dropped
// whole, whatever fields they contain (district, label, intercom, …).
const isAddressKey = (k: string) => k.includes("address");
// `customer-latitude`, `delivery_longitude`, …
const isCoordinateKey = (k: string) => k.endsWith("latitude") || k.endsWith("longitude");

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED:email]"],
  // Taiwan street addresses (松仁路100號, 忠孝東路四段1巷2弄3號) and city + district
  [/[\u4e00-\u9fff]{1,10}(?:路|街|大道)(?:[一二三四五六七八九十\d]+段)?(?:[\d一二三四五六七八九十]+巷)?(?:[\d一二三四五六七八九十]+弄)?\s*\d+(?:-\d+)?(?:之\d+)?\s*號[^\s"',]*/g, "[REDACTED:address]"],
  [/[\u4e00-\u9fff]{1,3}[市縣][\u4e00-\u9fff]{1,3}[區鄉鎮市]/g, "[REDACTED:address]"],
  // Taiwan mobiles and landlines, with or without +886
  [/(?<![\d.])(?:\+?886[\s-]?|0)(?:9\d{2}[\s-]?\d{3}[\s-]?\d{3}|[2-8]\d?[\s-]?\d{3,4}[\s-]?\d{4})(?![\d.])/g, "[REDACTED:phone]"],
];

function redactString(s: string): string {
  return STRING_PATTERNS.reduce((out, [re, replacement]) => out.replace(re, replacement), s);
}

function redactValue(value: unknown, parentKey: string): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, parentKey));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const key = norm(k);
      const sensitive =
        SENSITIVE_KEYS.has(key) ||
        isAddressKey(key) ||
        isCoordinateKey(key) ||
        (PERSON_KEYS.has(key) && PERSON_OBJECTS.has(parentKey));
      // Whole objects under a sensitive key (e.g. `delivery_address: {...}`) are dropped too.
      out[k] = sensitive && v !== null && v !== "" ? "[REDACTED]" : redactValue(v, key);
    }
    return out;
  }
  return value;
}

/** Redacts a JSON value (or JSON text) for logging. Non-JSON text gets pattern-based redaction. */
export function redactForLog(input: unknown): string {
  if (typeof input === "string") {
    try {
      return JSON.stringify(redactValue(JSON.parse(input), ""));
    } catch {
      return redactString(input);
    }
  }
  return JSON.stringify(redactValue(input, ""));
}
