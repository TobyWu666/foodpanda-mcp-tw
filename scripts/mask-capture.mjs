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
//   - coordinates: latitude/longitude are replaced with a fixed public landmark (Taipei 101)
// Keys are matched exactly (after lowercasing and dropping `_`/`-`), so restaurant and dish
// names, prices and ids stay intact. Free text is also scanned for emails, Taiwan phone
// numbers and JWTs.
//
// --check re-runs the masker on each file and exits 1 if it would change anything, i.e. the
// file still contains something that looks personal. Run it before committing a fixture.
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

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Taiwan mobiles (09xx-xxx-xxx, +886 9xx…) and landlines (0x-xxxx-xxxx, +886 x…).
const TW_PHONE_RE = /(?<![\d.])(?:\+?886[\s-]?|0)(?:9\d{2}[\s-]?\d{3}[\s-]?\d{3}|[2-8]\d?[\s-]?\d{3,4}[\s-]?\d{4})(?![\d.])/g;

const isPlaceholder = (v) => typeof v === "string" && /^\[REDACTED(:[a-z]+)?\]$/.test(v);

export function createMasker() {
  const changes = [];
  const record = (path, category) => changes.push({ path, category });

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
    record(path, category);
    return `[REDACTED:${category}]`;
  }

  function coordinate(value, placeholder, path) {
    if (typeof value === "number") {
      if (value === placeholder) return value;
      record(path, "coordinate");
      return placeholder;
    }
    if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) {
      if (Number(value) === placeholder) return value;
      record(path, "coordinate");
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
      if (masked !== null) return masked;
    }
    let out = s;
    const replace = (re, category) => {
      out = out.replace(re, (m) => {
        record(path, category);
        return `[REDACTED:${category}]`;
      });
    };
    replace(BEARER_RE, "secret");
    replace(JWT_RE, "secret");
    replace(EMAIL_RE, "email");
    replace(TW_PHONE_RE, "phone");
    return out;
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
    if (LAT_KEYS.has(k)) return coordinate(value, PLACEHOLDER_LAT, path);
    if (LNG_KEYS.has(k)) return coordinate(value, PLACEHOLDER_LNG, path);
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
    "       node scripts/mask-capture.mjs --check <file.json> [...]";
  if (argv[0] === "--check") {
    const files = argv.slice(1);
    if (files.length === 0) {
      console.error(usage);
      return 2;
    }
    let dirty = 0;
    for (const file of files) {
      const { changes } = maskCapture(JSON.parse(readFileSync(file, "utf8")));
      if (changes.length === 0) {
        console.error(`ok     ${file}`);
      } else {
        dirty++;
        console.error(`UNSAFE ${file}: ${summarize(changes)}`);
        for (const c of changes.slice(0, 20)) console.error(`         ${c.category}: ${c.path}`);
        if (changes.length > 20) console.error(`         … and ${changes.length - 20} more`);
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
