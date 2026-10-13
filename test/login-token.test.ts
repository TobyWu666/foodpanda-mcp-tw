import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { refreshTokenViaBrowser } from "../src/token-manager.js";

// Synthetic JWT-shaped strings; nothing here is a real token.
const GUEST = "guest.payload.sig";
const ACCOUNT = "account.payload.sig";

/** A browser context whose page replays the given Bearer tokens to the API host. */
function fakeContext(tokens: string[]) {
  const page = new EventEmitter() as EventEmitter & Record<string, any>;
  page.goto = async () => {
    for (const t of tokens) {
      page.emit("request", {
        url: () => "https://tw.fd-api.com/api/v5/customers/addresses",
        headers: () => ({ authorization: `Bearer ${t}` }),
      });
      await new Promise((r) => setImmediate(r));
    }
  };
  page.close = async () => {};
  const context = { pages: () => [page], newPage: async () => page };
  return async () => context;
}

test("login skips a token that is not an account and returns the account one", async () => {
  const checked: string[] = [];
  const token = await refreshTokenViaBrowser(
    5,
    async (t) => {
      checked.push(t);
      return t === ACCOUNT;
    },
    fakeContext([GUEST, GUEST, ACCOUNT])
  );
  assert.equal(token, ACCOUNT);
  assert.deepEqual(checked, [GUEST, ACCOUNT], "each token is checked once");
});

test("a failing check ends the login with an error instead of hanging", async () => {
  await assert.rejects(
    refreshTokenViaBrowser(
      5,
      async () => {
        throw new Error("PerimeterX blocked");
      },
      fakeContext([ACCOUNT])
    ),
    /Could not check the login token: PerimeterX blocked/
  );
});
