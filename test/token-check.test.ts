import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwtPayload, persistedTokenProblem, tokenProblem } from "../src/token-check.js";

// Synthetic tokens only: header and signature are placeholders, the payload is made up.
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

const NOW = Date.parse("2026-10-12T00:00:00Z");
const future = Math.floor(NOW / 1000) + 3600;
const past = Math.floor(NOW / 1000) - 60;
const TW = "https://tw.fd-api.com";

test("decodes a JWT payload and rejects non-JWTs", () => {
  assert.deepEqual(decodeJwtPayload(jwt({ user_id: "u1" })), { user_id: "u1" });
  assert.equal(decodeJwtPayload("not-a-token"), null);
  assert.equal(decodeJwtPayload("a.%%%.c"), null);
});

test("expired tokens are rejected, live or exp-less ones accepted", () => {
  assert.match(tokenProblem(jwt({ exp: past }), NOW) ?? "", /expired/);
  assert.equal(tokenProblem(jwt({ exp: future }), NOW), null);
  assert.equal(tokenProblem(jwt({}), NOW), null);
  assert.equal(tokenProblem("garbage", NOW), "not a JWT");
});

test("a token saved for another region is rejected", () => {
  const data = { token: jwt({ exp: future }), savedAt: "x", region: "https://hk.fd-api.com" };
  assert.match(persistedTokenProblem(data, TW, NOW) ?? "", /saved for https:\/\/hk\.fd-api\.com/);
});

test("a token file without a region is rejected", () => {
  const data = { token: jwt({ exp: future }), savedAt: "x" };
  assert.match(persistedTokenProblem(data, TW, NOW) ?? "", /does not record its region/);
});

test("a same-region live token is accepted, trailing slashes ignored", () => {
  const data = { token: jwt({ exp: future }), savedAt: "x", region: `${TW}/` };
  assert.equal(persistedTokenProblem(data, TW, NOW), null);
});

test("a same-region expired token is rejected", () => {
  const data = { token: jwt({ exp: past }), savedAt: "x", region: TW };
  assert.match(persistedTokenProblem(data, TW, NOW) ?? "", /expired/);
});

test("malformed files are rejected", () => {
  assert.equal(persistedTokenProblem(null, TW, NOW), "unreadable token file");
  assert.equal(persistedTokenProblem({ token: "" , region: TW }, TW, NOW), "no token in file");
});
