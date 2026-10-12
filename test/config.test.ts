import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_COUNTRY, loadRegionConfig, stateDir } from "../src/config.js";

test("tw is the default region, with the values seen in the tw capture", () => {
  assert.equal(DEFAULT_COUNTRY, "tw");
  const cfg = loadRegionConfig({});
  assert.equal(cfg.apiBase, "https://tw.fd-api.com");
  assert.equal(cfg.webHost, "https://www.foodpanda.com.tw");
  assert.equal(cfg.locale, "zh_TW");
  assert.equal(cfg.currency, "TWD");
  assert.equal(cfg.globalEntityId, "FP_TW");
  assert.equal(cfg.languageId, 6);
});

test("tw leaves values the capture did not show unset instead of guessing", () => {
  const cfg = loadRegionConfig({ FOODPANDA_COUNTRY: "tw" });
  assert.equal(cfg.searchHash, "");
  assert.equal(cfg.vendorListHash, "");
});

test("env overrides win over the tw preset", () => {
  const cfg = loadRegionConfig({
    FOODPANDA_API_BASE: "https://example.test/",
    FOODPANDA_WEB_HOST: "https://web.example.test",
    FOODPANDA_LOCALE: "en_TW",
    FOODPANDA_CURRENCY: "XXX",
    FOODPANDA_GLOBAL_ENTITY_ID: "FP_XX",
    FOODPANDA_LANGUAGE_ID: "7",
    FOODPANDA_GQL_SEARCH_HASH: "abc",
  });
  assert.equal(cfg.apiBase, "https://example.test");
  assert.equal(cfg.webHost, "https://web.example.test");
  assert.equal(cfg.locale, "en_TW");
  assert.equal(cfg.currency, "XXX");
  assert.equal(cfg.globalEntityId, "FP_XX");
  assert.equal(cfg.languageId, 7);
  assert.equal(cfg.searchHash, "abc");
});

test("country selection is case-insensitive and other presets still load", () => {
  assert.equal(loadRegionConfig({ FOODPANDA_COUNTRY: " TW " }).apiBase, "https://tw.fd-api.com");
  const hk = loadRegionConfig({ FOODPANDA_COUNTRY: "hk" });
  assert.equal(hk.apiBase, "https://hk.fd-api.com");
  assert.equal(hk.globalEntityId, "");
  assert.equal(loadRegionConfig({ FOODPANDA_COUNTRY: "hk", FOODPANDA_LANGUAGE_ID: "" }).languageId, 1);
  assert.equal(loadRegionConfig({ FOODPANDA_COUNTRY: "ph" }).globalEntityId, "FP_PH");
});

test("unknown countries and bad language ids are rejected", () => {
  assert.throws(() => loadRegionConfig({ FOODPANDA_COUNTRY: "sg" }), /Unknown FOODPANDA_COUNTRY='sg'/);
  assert.throws(() => loadRegionConfig({ FOODPANDA_LANGUAGE_ID: "zh" }), /must be an integer/);
});

test("browser defaults are unchanged", () => {
  const cfg = loadRegionConfig({});
  assert.equal(cfg.browserTransport, true);
  assert.equal(cfg.headless, true);
  assert.equal(cfg.browserChannel, "chromium");
  assert.equal(loadRegionConfig({ FOODPANDA_HEADLESS: "0" }).headless, false);
});

test("state dir honours FOODPANDA_STATE_DIR", () => {
  assert.equal(stateDir({ FOODPANDA_STATE_DIR: "/tmp/fp-state" }), "/tmp/fp-state");
  assert.match(stateDir({}), /\.foodpanda-mcp$/);
});
