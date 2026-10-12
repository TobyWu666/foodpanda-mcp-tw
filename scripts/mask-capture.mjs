#!/usr/bin/env node
// Redacts personal data and credentials from a network capture so it can be committed as a
// test fixture. Accepts a HAR export or any JSON file (a saved request/response body).
//
//   node scripts/mask-capture.mjs captures/checkout.har test/fixtures/checkout.masked.json
//   node scripts/mask-capture.mjs --check test/fixtures/*.masked.json
//
// What is masked:
//   - credentials: Authorization/Cookie/Set-Cookie and other token/session/PerimeterX headers,
//     every cookie value, JSON fields named like token/password/otp/secret/session, JWTs and
//     "Bearer …" strings anywhere
//   - personal data: names (first/last/full name, or `name` inside a customer/user/recipient
//     object), phone numbers, emails, address lines, delivery instructions, customer ids
//   - addresses: every string inside a field or object whose name contains `address`, whatever the
//     inner field is called (formatted_customer_address, district, label, intercom, …)
//   - coordinates: latitude/longitude (also `customer-latitude` headers etc.) are replaced
//     with a fixed public landmark (Taipei 101)
//   - address objects found by their own fields (address_line1, intercom, …), e.g. the saved
//     address list, which comes back as `data.items[]`
//   - GPS-precision coordinates inside Taiwan written in text ("25.12345,121.54321", URL paths)
//   - URLs (query, path and #fragment) and url-encoded form bodies, field by field
//   - HAR bodies that are not JSON or a form (HTML pages, scripts) are dropped entirely
// Keys are matched exactly (after lowercasing and dropping `_`/`-`), so restaurant and dish
// names, prices and ids stay intact. Free text is also scanned for emails, Taiwan phone
// numbers and JWTs.
//
// --check exits 1 if a file still looks personal. It does not rely on the masking rules alone:
// besides re-running the masker, it scans every value for JWTs, emails, Taiwan phone numbers,
// Taiwan street addresses, secret form fields, credential headers and GPS-precision
// coordinates inside Taiwan. With --against <raw capture> it also fails if any value masked
// out of the raw capture still appears in the fixture. Run it before committing a fixture:
//
//   node scripts/mask-capture.mjs --check --against captures/checkout.har test/fixtures/checkout.masked.json
//
// The input is never modified. No dependencies.

import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const PLACEHOLDER_LAT = 25.033964;
const PLACEHOLDER_LNG = 121.564468;

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

const SECRET_KEYS = new Set(
  [
    "token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "authtoken", "devicetoken",
    "pushtoken", "jwt", "password", "passwd", "otp", "otpcode", "pin", "secret", "clientsecret",
    "authorization", "cookie", "cookies", "setcookie", "sessionid", "session", "signature",
    "fingerprint", "deviceid", "deviceidentifier", "dpssessionid", "perseusclientid",
    "perseussessionid", "apikey", "xapikey", "cardnumber", "cvv", "cvc", "iban", "accountnumber",
  ]
);
// Header names are matched by substring, since vendors add their own prefixes.
const SECRET_HEADER_PARTS = ["auth", "token", "cookie", "session", "px", "perseus", "device", "fingerprint", "apikey", "api-key", "signature", "csrf", "xsrf"];

const NAME_KEYS = new Set([
  "firstname", "lastname", "fullname", "middlename", "givenname", "familyname", "nickname",
  "customername", "recipientname", "contactname", "receivername", "displayname", "username",
]);
// `name` (and a few generic fields) are personal only inside these objects.
const PERSON_CONTEXT = new Set([
  "customer", "user", "recipient", "receiver", "contact", "profile", "account", "me", "owner",
]);
const PERSON_CONTEXT_KEYS = new Set(["name", "id", "code", "uuid", "gender", "birthday", "dateofbirth"]);

const PHONE_KEYS = new Set([
  "phone", "phonenumber", "mobile", "mobilenumber", "mobilephone", "contactnumber", "telephone",
  "tel", "msisdn", "customerphone", "recipientphone",
]);
const EMAIL_KEYS = new Set(["email", "emailaddress", "customeremail"]);
const ADDRESS_KEYS = new Set([
  "address", "addressline", "addressline1", "addressline2", "addressline3", "addressline4",
  "addressline5", "addressother", "formattedaddress", "fulladdress", "street", "streetname",
  "streetnumber", "building", "buildingname", "block", "floor", "flatnumber",
  "unitnumber", "room", "roomnumber", "housenumber", "entrance", "postcode", "postalcode",
  "zip", "zipcode", "landmark", "company", "deliveryinstructions", "instructions",
  "riderinstructions", "deliverynote", "note",
]);
const ID_KEYS = new Set([
  "customercode", "customerid", "userid", "customeruuid", "useruuid", "perseusid",
  "clientid", "globalcustomerid", "loyaltyid",
]);
const LAT_KEYS = new Set(["lat", "latitude"]);
const LNG_KEYS = new Set(["lng", "lon", "long", "longitude"]);
// `customer-latitude` headers, `delivery_longitude`, …
const isLatKey = (k) => LAT_KEYS.has(k) || k.endsWith("latitude");
const isLngKey = (k) => LNG_KEYS.has(k) || k.endsWith("longitude");
// Objects under these keys are addresses: every string in them is masked, whatever its field
// name (foodpanda uses `formatted_customer_address`, `district`, `city`, `title`, `label`,
// `intercom`, `structure`, …). Numbers and booleans are kept; coordinates get the placeholder.
const isAddressKey = (k) => k.includes("address");
// Saved-address lists come back as `data.items[]`, so an address is also recognised by its own
// fields: any of these marks the whole object as an address. (Vendor objects use `address`
// and `address_line2` for their public address, so those two are not markers.)
const ADDRESS_MARKERS = new Set([
  "addressline1", "addressline3", "addressline4", "addressline5", "addressother",
  "formattedaddress", "formattedcustomeraddress", "fulladdress", "intercom", "flatnumber",
  "entrance", "deliveryinstructions",
]);
export const isAddressShaped = (obj) =>
  obj !== null && typeof obj === "object" && !Array.isArray(obj) &&
  Object.keys(obj).some((k) => ADDRESS_MARKERS.has(norm(k)));
// A number with GPS precision inside a string: "25.12345,121.54321", /geo/25.12345/121.54321
const COORD_IN_TEXT_RE = /(?<![\d.])-?\d{2,3}\.\d{4,}(?![\d.])/g;
// Only these HAR bodies are kept; HTML pages, scripts and the like can embed the logged-in
// user's data and are never needed as fixtures.
const KEEP_BODY_RE = /json|x-www-form-urlencoded/i;

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Taiwan mobiles (09xx-xxx-xxx, +886 9xx…) and landlines (0x-xxxx-xxxx, +886 x…).
const TW_PHONE_RE = /(?<![\d.])(?:\+?886[\s-]?|0)(?:9\d{2}[\s-]?\d{3}[\s-]?\d{3}|[2-8]\d?[\s-]?\d{3,4}[\s-]?\d{4})(?![\d.])/g;

// `email=a%40b.co&password=x` — a whole string of url-encoded fields
const FORM_RE = /^[\w.%\[\]-]+=[^&\s]*(?:&[\w.%\[\]-]+=[^&\s]*)*$/;

const isPlaceholder = (v) => typeof v === "string" && /^\[REDACTED(:[a-z]+)?\]$/.test(v);

export function createMasker() {
  const changes = [];
  // `original` is kept so --check --against can look for it in a fixture; it is never printed.
  const record = (path, category, original) => changes.push({ path, category, original });

  function redactValue(value, category, path) {
    if (value === null || value === undefined || value === "") return value;
    if (isPlaceholder(value)) return value;
    if (typeof value === "object") {
      // A whole object under a sensitive key (e.g. `address: {...}`): mask its leaves.
      return Array.isArray(value)
        ? value.map((v, i) => redactValue(v, category, `${path}[${i}]`))
        : Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, redactValue(v, category, `${path}.${k}`)])
          );
    }
    record(path, category, value);
    return `[REDACTED:${category}]`;
  }

  function maskAddress(value, path) {
    if (Array.isArray(value)) return value.map((v, i) => maskAddress(v, `${path}[${i}]`));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const nk = norm(k);
        const p = `${path}.${k}`;
        if (isLatKey(nk)) out[k] = coordinate(v, PLACEHOLDER_LAT, p);
        else if (isLngKey(nk)) out[k] = coordinate(v, PLACEHOLDER_LNG, p);
        else out[k] = maskAddress(v, p);
      }
      return out;
    }
    return typeof value === "string" ? redactValue(value, "address", path) : value;
  }

  function coordinate(value, placeholder, path) {
    if (typeof value === "number") {
      if (value === placeholder) return value;
      record(path, "coordinate", value);
      return placeholder;
    }
    if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
      if (Number(value) === placeholder) return value;
      record(path, "coordinate", value);
      return String(placeholder);
    }
    return maskNode(value, [], path);
  }

  function maskString(s, path) {
    if (isPlaceholder(s)) return s;
    // Embedded JSON (HAR bodies, stringified payloads) is masked structurally.
    const trimmed = s.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        const parsed = JSON.parse(trimmed);
        const masked = maskNode(parsed, [], `${path}<json>`);
        return JSON.stringify(masked);
      } catch {
        /* not JSON; fall through */
      }
    }
    if (/^https?:\/\//i.test(trimmed)) {
      const masked = maskUrl(trimmed, path);
      // The path and fragment can carry tokens too (`/reset/eyJ…`), so patterns still apply.
      if (masked !== null) return maskPatterns(masked, path);
    }
    if (FORM_RE.test(trimmed)) return maskForm(trimmed, path);
    return maskPatterns(s, path);
  }

  function maskPatterns(s, path) {
    let out = s;
    const replace = (re, category) => {
      out = out.replace(re, (m) => {
        record(path, category, m);
        return `[REDACTED:${category}]`;
      });
    };
    replace(BEARER_RE, "secret");
    replace(JWT_RE, "secret");
    replace(EMAIL_RE, "email");
    replace(TW_PHONE_RE, "phone");
    out = out.replace(COORD_IN_TEXT_RE, (m) => {
      const n = Number(m);
      if (!isTaiwanCoordinate(n)) return m;
      record(path, "coordinate", m);
      return String(n <= 25.4 ? PLACEHOLDER_LAT : PLACEHOLDER_LNG);
    });
    return out;
  }

  // Masks `a=1&b=2` (form bodies, URL fragments) field by field. Returns the input unchanged
  // when nothing was masked, so re-encoding never counts as an edit.
  function maskParams(text, path) {
    const params = new URLSearchParams(text);
    let changed = false;
    for (const [k, v] of [...params.entries()]) {
      const masked = maskKeyValue(k, v, [], `${path}&${k}`);
      if (masked !== v) {
        params.set(k, String(masked));
        changed = true;
      }
    }
    return changed ? params.toString() : text;
  }

  function maskForm(text, path) {
    return maskParams(text, `${path}<form>`);
  }

  function maskUrl(url, path) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      const masked = maskKeyValue(k, v, [], `${path}?${k}`);
      if (masked !== v) {
        u.searchParams.set(k, String(masked));
        changed = true;
      }
    }
    // `#access_token=…` style fragments
    const fragment = u.hash.slice(1);
    if (fragment.includes("=")) {
      const masked = maskParams(fragment, `${path}#`);
      if (masked !== fragment) {
        u.hash = masked;
        changed = true;
      }
    }
    // Keep the original string when nothing changed so encoding differences don't count as edits.
    return changed ? u.toString() : url;
  }

  // Masks `value` stored under `key`; `ancestors` are the enclosing keys.
  function maskKeyValue(key, value, ancestors, path) {
    const k = norm(key);
    const parent = norm(ancestors[ancestors.length - 1] ?? "");
    if (SECRET_KEYS.has(k)) return redactValue(value, "secret", path);
    if (NAME_KEYS.has(k)) return redactValue(value, "name", path);
    if (PHONE_KEYS.has(k)) return redactValue(value, "phone", path);
    if (EMAIL_KEYS.has(k)) return redactValue(value, "email", path);
    if (ID_KEYS.has(k)) return redactValue(value, "id", path);
    if (isLatKey(k)) return coordinate(value, PLACEHOLDER_LAT, path);
    if (isLngKey(k)) return coordinate(value, PLACEHOLDER_LNG, path);
    if (isAddressKey(k)) return maskAddress(value, path);
    if (PERSON_CONTEXT.has(parent) && PERSON_CONTEXT_KEYS.has(k)) return redactValue(value, "name", path);
    if (ADDRESS_KEYS.has(k) && (typeof value !== "object" || value === null)) {
      return redactValue(value, "address", path);
    }
    return maskNode(value, [...ancestors, key], path);
  }

  // HAR-style `[{name, value}]` lists (headers, cookies, query strings, form params).
  function maskNameValueList(list, listKey, path) {
    const kind = norm(listKey);
    return list.map((entry, i) => {
      const p = `${path}[${i}:${entry.name}]`;
      const lower = String(entry.name).toLowerCase();
      let value = entry.value;
      if (kind === "cookies") {
        value = redactValue(value, "secret", p);
      } else if (kind === "headers" && SECRET_HEADER_PARTS.some((part) => lower.includes(part))) {
        value = redactValue(value, "secret", p);
      } else {
        value = maskKeyValue(entry.name, value, [listKey], p);
      }
      const rest = Object.fromEntries(
        Object.entries(entry)
          .filter(([k]) => k !== "name" && k !== "value")
          .map(([k, v]) => [k, maskNode(v, [listKey, k], `${p}.${k}`)])
      );
      return { name: entry.name, value, ...rest };
    });
  }

  function maskNode(node, ancestors, path, forcedCategory) {
    if (forcedCategory) return redactValue(node, forcedCategory, path);
    if (typeof node === "string") return maskString(node, path);
    if (Array.isArray(node)) {
      const key = ancestors[ancestors.length - 1];
      const isNameValueList =
        node.length > 0 && node.every((e) => e && typeof e === "object" && "name" in e && "value" in e);
      if (isNameValueList && ["headers", "cookies", "querystring", "params"].includes(norm(key ?? ""))) {
        return maskNameValueList(node, key, path);
      }
      return node.map((v, i) => maskNode(v, ancestors, `${path}[${i}]`));
    }
    if (node && typeof node === "object") {
      // HAR bodies: base64 content is decoded, masked and stored as text.
      if (typeof node.text === "string" && node.encoding === "base64") {
        const decoded = Buffer.from(node.text, "base64").toString("utf8");
        const { encoding, ...rest } = node;
        return maskNode({ ...rest, text: decoded }, ancestors, path);
      }
      // HAR request/response bodies that are not JSON or a form are dropped.
      if (typeof node.text === "string" && typeof node.mimeType === "string" &&
          !KEEP_BODY_RE.test(node.mimeType) && node.text !== "" && !isPlaceholder(node.text)) {
        record(`${path}.text`, "body", undefined);
        node = { ...node, text: "[REDACTED:body]" };
      }
      if (isAddressShaped(node)) return maskAddress(node, path);
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        out[k] = maskKeyValue(k, v, ancestors, path ? `${path}.${k}` : k);
      }
      return out;
    }
    return node;
  }

  return {
    mask: (data) => maskNode(data, [], ""),
    changes,
  };
}

export function maskCapture(data) {
  const masker = createMasker();
  const masked = masker.mask(data);
  return { masked, changes: masker.changes };
}

// ---------------------------------------------------------------------------------------------
// Leak detection for --check. Deliberately independent of the masking rules above: it looks at
// values, not field names, so a field the masker does not know about is still caught.

// Taiwan street addresses: 松仁路100號, 忠孝東路四段1巷2弄3號, 台北市信義區
const TW_ADDRESS_RES = [
  /[\u4e00-\u9fff]{1,10}(?:路|街|大道)(?:[一二三四五六七八九十\d]+段)?(?:[\d一二三四五六七八九十]+巷)?(?:[\d一二三四五六七八九十]+弄)?\s*\d+(?:-\d+)?(?:之\d+)?\s*號/,
  /[\u4e00-\u9fff]{1,3}[市縣][\u4e00-\u9fff]{1,3}[區鄉鎮市]/,
  /\bNo\.?\s*\d+(?:-\d+)?\b[^\n"]{0,60}?\b(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard)\b/i,
];
// A secret left as a form/fragment field: password=hunter2, access_token=abc
const SECRET_PAIR_RE = /(?:^|[?&#;\s])(?:password|passwd|pwd|otp|access_token|refresh_token|id_token|token|session_id)=(?!%5BREDACTED|\[REDACTED)[^&\s#]+/i;
// A coordinate inside Taiwan's bounding box with GPS precision (>= 4 decimals).
function isTaiwanCoordinate(n) {
  if (!Number.isFinite(n)) return false;
  const decimals = (String(n).split(".")[1] ?? "").length;
  if (decimals < 4) return false;
  if (n === PLACEHOLDER_LAT || n === PLACEHOLDER_LNG) return false;
  return (n >= 21.8 && n <= 25.4) || (n >= 119.3 && n <= 122.1);
}
const SECRET_HEADER_NAMES = /^(?:authorization|cookie|set-cookie|proxy-authorization)$/i;

export function detectLeaks(data) {
  const leaks = [];
  const add = (path, kind) => leaks.push({ path, kind });

  function scanString(s, path) {
    if (s === "" || /^\[REDACTED(:[a-z]+)?\]$/.test(s)) return;
    const trimmed = s.trim();
    if (/^[[{]/.test(trimmed)) {
      try {
        return walk(JSON.parse(trimmed), `${path}<json>`);
      } catch {
        /* not JSON */
      }
    }
    let decoded = s;
    try {
      decoded = decodeURIComponent(s.replace(/\+/g, " "));
    } catch {
      /* keep raw */
    }
    for (const text of decoded === s ? [s] : [s, decoded]) {
      const unmasked = text.replace(/\[REDACTED(:[a-z]+)?\]/g, "");
      if (JWT_RE.test(unmasked) || BEARER_RE.test(unmasked)) add(path, "token");
      if (SECRET_PAIR_RE.test(unmasked)) add(path, "secret field");
      if (EMAIL_RE.test(unmasked)) add(path, "email");
      if (TW_PHONE_RE.test(unmasked)) add(path, "phone");
      if (TW_ADDRESS_RES.some((re) => re.test(unmasked))) add(path, "address");
      // The global regexes keep state between .test() calls.
      for (const re of [JWT_RE, BEARER_RE, EMAIL_RE, TW_PHONE_RE]) re.lastIndex = 0;
    }
    for (const m of s.match(COORD_IN_TEXT_RE) ?? []) {
      if (isTaiwanCoordinate(Number(m))) {
        add(path, "coordinate");
        break;
      }
    }
  }

  function walk(node, path) {
    if (typeof node === "string") return scanString(node, path);
    if (typeof node === "number") {
      // HAR timings (ms) are floats too; they are not locations.
      const isTiming = /(^|\.)timings\.|\.time$/.test(path);
      if (!isTiming && isTaiwanCoordinate(node)) add(path, "coordinate");
      return;
    }
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (node && typeof node === "object") {
      if (typeof node.name === "string" && SECRET_HEADER_NAMES.test(node.name) &&
          typeof node.value === "string" && !/^\[REDACTED/.test(node.value) && node.value !== "") {
        add(`${path}:${node.name}`, "credential header");
      }
      if (typeof node.text === "string" && node.encoding === "base64") {
        return walk({ ...node, encoding: undefined, text: Buffer.from(node.text, "base64").toString("utf8") }, path);
      }
      if (typeof node.text === "string" && typeof node.mimeType === "string" &&
          !KEEP_BODY_RE.test(node.mimeType) && node.text !== "" && !/^\[REDACTED/.test(node.text)) {
        add(`${path}.text`, `${node.mimeType} body`);
      }
      // An address object with any readable text left in it, whatever it is nested under.
      if (isAddressShaped(node) &&
          Object.values(node).some((v) => typeof v === "string" && v !== "" && !/^\[REDACTED/.test(v))) {
        add(path, "address object");
      }
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  }

  walk(data, "");
  return leaks;
}

// Personal values the masker removed from the raw capture, to look for in a fixture.
function sensitiveValuesOf(raw) {
  const values = new Set();
  for (const c of maskCapture(raw).changes) {
    const v = c.original;
    if (typeof v === "string" && v.trim().length >= 2 && !/^\[REDACTED/.test(v)) values.add(v.trim());
    if (typeof v === "number" && String(v).length >= 4) values.add(String(v));
  }
  return values;
}

/**
 * Checks a fixture three ways: the masker would change nothing, the value-based detectors
 * find nothing, and (when the raw capture is given) no value masked out of the raw capture
 * appears anywhere in the fixture text.
 */
export function checkFixture(fixture, raw) {
  const problems = [];
  for (const c of maskCapture(fixture).changes) problems.push({ path: c.path, kind: `unmasked ${c.category}` });
  for (const l of detectLeaks(fixture)) problems.push(l);
  if (raw !== undefined) {
    const text = JSON.stringify(fixture);
    const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const v of sensitiveValuesOf(raw)) {
      // Whole-token matches only, so 121.5 is not found inside the placeholder 121.564468.
      const forms = new Set([JSON.stringify(v).slice(1, -1), encodeURIComponent(v)]);
      const found = [...forms].some((f) =>
        new RegExp(`(?<![A-Za-z0-9.])${escapeRe(f)}(?![A-Za-z0-9])`).test(text)
      );
      if (found) problems.push({ path: "(anywhere)", kind: "value from the raw capture" });
    }
  }
  return problems;
}

function summarize(changes) {
  const counts = {};
  for (const c of changes) counts[c.category] = (counts[c.category] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
}

function main(argv) {
  const usage =
    "usage: node scripts/mask-capture.mjs <input.har|input.json> <output.masked.json>\n" +
    "       node scripts/mask-capture.mjs --check [--against <raw capture>] <file.json> [...]";
  if (argv[0] === "--check") {
    let files = argv.slice(1);
    let raw;
    if (files[0] === "--against") {
      if (!files[1]) {
        console.error(usage);
        return 2;
      }
      raw = JSON.parse(readFileSync(files[1], "utf8"));
      files = files.slice(2);
    }
    if (files.length === 0) {
      console.error(usage);
      return 2;
    }
    let dirty = 0;
    for (const file of files) {
      const problems = checkFixture(JSON.parse(readFileSync(file, "utf8")), raw);
      if (problems.length === 0) {
        console.error(`ok     ${file}`);
      } else {
        dirty++;
        // Paths and kinds only: printing the values would leak them into the terminal log.
        console.error(`UNSAFE ${file}: ${summarize(problems.map((p) => ({ category: p.kind })))}`);
        for (const p of problems.slice(0, 20)) console.error(`         ${p.kind}: ${p.path}`);
        if (problems.length > 20) console.error(`         … and ${problems.length - 20} more`);
      }
    }
    return dirty ? 1 : 0;
  }

  const [input, output] = argv;
  if (!input || !output) {
    console.error(usage);
    return 2;
  }
  const inPath = resolve(input);
  const outPath = resolve(output);
  if (inPath === outPath) {
    console.error("refusing to overwrite the input file");
    return 2;
  }
  if (/\.har$/i.test(outPath)) {
    console.error("output should be a .json file, not .har");
    return 2;
  }
  const { masked, changes } = maskCapture(JSON.parse(readFileSync(inPath, "utf8")));
  writeFileSync(outPath, JSON.stringify(masked, null, 2) + "\n");
  console.error(`wrote ${output} (${changes.length} values masked: ${summarize(changes) || "none"})`);
  console.error("Review the output before committing: the masker cannot recognise every field.");
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
