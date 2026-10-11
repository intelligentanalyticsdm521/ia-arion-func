// test/subscription-config-sync-timer.test.mjs — the daily bell for each
// website's subscription state (ia_spark_capture + ia_tier), 2026-10-11. The
// logic lives in arion-api (lib/websiteBuilder/subscriptionConfig.js, POST
// /internal/subscription-config-tick); this pins the path, the schedule, the
// key header, that it never throws, and that index.js registers it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const timer = await import("../src/functions/subscriptionConfigSync.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("subscription-config timer: daily, rings the arion-api path with the internal key, never throws", async () => {
  assert.equal(timer.SUBSCRIPTION_SYNC_SCHEDULE, "0 17 6 * * *");
  assert.equal(timer.SUBSCRIPTION_SYNC_TICK_PATH, "/internal/subscription-config-tick");
  const calls = [];
  const r = await timer.ringSubscriptionSync(() => {}, {
    env: { ARION_API_BASE_URL: "https://arion.example.test/", ARION_INGEST_KEY: "k" },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ ok: true, summary: { sites: 5, pushed: 5, capture_on: 2, tier_pushed: 5 } }); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary.pushed, 5);
  assert.equal(calls[0].url, "https://arion.example.test/internal/subscription-config-tick");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-arion-ingest-key"], "k");

  const failed = await timer.ringSubscriptionSync(() => {}, { env: { ARION_API_BASE_URL: "https://a.test" }, fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(failed.ok, false);
  const refused = await timer.ringSubscriptionSync(() => {}, { env: { ARION_API_BASE_URL: "https://a.test" }, fetchImpl: async () => json({ error: "no" }, 401) });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 401);
  const off = await timer.ringSubscriptionSync(() => {}, { env: { ARION_API_BASE_URL: "https://a.test", SUBSCRIPTION_CONFIG_SYNC_DISABLED: "true" }, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(off.skipped, "disabled");
  const unset = await timer.ringSubscriptionSync(() => {}, { env: {}, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(unset.skipped, "no_base_url");

  const route = path.join(ROOT, "..", "arion-api-septa", "routes", "internal.js");
  if (fs.existsSync(route)) {
    assert.match(fs.readFileSync(route, "utf8"), /router\.post\('\/subscription-config-tick', requireIngestKey/, "arion-api mounts the path this timer rings, behind the ingest key");
  }
  assert.match(fs.readFileSync(path.join(ROOT, "src", "index.js"), "utf8"), /import "\.\/functions\/subscriptionConfigSync\.js";/);
});
