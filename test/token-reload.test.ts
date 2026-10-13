import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoodpandaClient, type HttpFunction } from "../src/foodpanda-client.js";
import { persistedTokenReloader } from "../src/token-manager.js";

const details = JSON.parse(
  readFileSync(join(process.cwd(), "test", "fixtures", "tw-restaurant-details.masked.json"), "utf-8")
);

// Synthetic tokens only. The TW token carries "expires" (seconds since epoch), not "exp".
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}
const now = Math.floor(Date.now() / 1000);
const EXPIRED = jwt({ user_id: "twcust01", expires: now - 60 });
const LIVE = jwt({ user_id: "twcust01", expires: now + 1800 });
const NEWER = jwt({ user_id: "twcust01", expires: now + 3600 });

/** A fake foodpanda that accepts only the tokens in `good`, recording what it was sent. */
function fake(good: string[]) {
  const sent: string[] = [];
  const http: HttpFunction = async (_url, init) => {
    const token = (init.headers?.Authorization ?? "").replace(/^Bearer /, "");
    sent.push(token);
    if (!good.includes(token)) return { status: 401, ok: false, text: "{}" };
    return { status: 200, ok: true, text: JSON.stringify(details.response) };
  };
  return { http, sent };
}

function client(token: string | null, http: HttpFunction, saved: Array<string | null>) {
  let reads = 0;
  const reloadToken = () => {
    reads++;
    return saved.length ? saved.shift()! : null;
  };
  const fp = new FoodpandaClient(token, 25.033964, 121.564468, { http, lockFile: null, reloadToken });
  return { fp, reads: () => reads };
}

test("an expired token is swapped for a newer saved login before the request", async () => {
  const { http, sent } = fake([LIVE]);
  const { fp } = client(EXPIRED, http, [LIVE]);
  await fp.getRestaurantDetails("test01");
  assert.deepEqual(sent, [LIVE], "the expired token was never sent");
});

test("a refused token is swapped once for a newer saved login and the request retried", async () => {
  const { http, sent } = fake([NEWER]);
  const { fp } = client(LIVE, http, [NEWER]);
  await fp.getRestaurantDetails("test01");
  assert.deepEqual(sent, [LIVE, NEWER]);
});

test("no newer saved login: the refusal is reported, with no retry", async () => {
  const { http, sent } = fake([]);
  const { fp } = client(LIVE, http, [LIVE]);
  await assert.rejects(fp.getRestaurantDetails("test01"), /Session token expired or invalid/);
  assert.deepEqual(sent, [LIVE]);
});

test("never loops: a swapped-in token that is refused too ends the call", async () => {
  const { http, sent } = fake([]);
  const { fp, reads } = client(LIVE, http, [NEWER, LIVE, NEWER]);
  await assert.rejects(fp.getRestaurantDetails("test01"), /Session token expired or invalid/);
  assert.deepEqual(sent, [LIVE, NEWER]);
  assert.equal(reads(), 1);
});

test("an older or expired saved login is not swapped in", async () => {
  for (const saved of [LIVE, EXPIRED]) {
    const { http, sent } = fake([]);
    const { fp } = client(NEWER, http, [saved]);
    await assert.rejects(fp.getRestaurantDetails("test01"));
    assert.deepEqual(sent, [NEWER]);
  }
});

test("a saved login for another account is never swapped in", async () => {
  const OTHER = jwt({ user_id: "twcust02", expires: now + 3600 });
  const { http, sent } = fake([OTHER]);
  const { fp } = client(LIVE, http, [OTHER]);
  await assert.rejects(fp.getRestaurantDetails("test01"), /Session token expired or invalid/);
  assert.deepEqual(sent, [LIVE]);
});

test("token.json is read again only when it changes, and the token is never logged", () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-token-"));
  const file = join(dir, "token.json");
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(" "));
  try {
    const save = (token: string, at: number) => {
      writeFileSync(file, JSON.stringify({ token, savedAt: "x", region: "https://tw.fd-api.com" }));
      utimesSync(file, at, at);
    };
    const reload = persistedTokenReloader(file);
    assert.equal(reload(), null, "no file yet");
    save(LIVE, 1_000_000);
    assert.equal(reload(), LIVE);
    assert.equal(reload(), null, "unchanged file is not read again");
    save(EXPIRED, 1_000_100);
    assert.equal(reload(), null, "an expired saved login is ignored");
    save(NEWER, 1_000_200);
    assert.equal(reload(), NEWER);
    assert.ok(logged.every((line) => !line.includes(".sig")), "no token in the log");
  } finally {
    console.error = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
