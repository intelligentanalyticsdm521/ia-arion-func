// test/booking-button-sync-timer.test.mjs — the daily bell for the website
// "Book now" button (FEATURES row 17, 2026-10-11). The logic lives in arion-api
// (lib/bookingButtonSync.js, POST /internal/booking-button-sync-tick); this
// pins the path, the schedule, the key header, that it never throws, and that
// index.js registers it. Importing a function module puts @azure/functions in
// test mode, so nothing is registered here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const timer = await import("../src/functions/bookingButtonSync.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ── row 17: the booking-button timer ──────────────────────────────────── */

test("booking-button timer: daily, rings the arion-api path with the internal key, never throws", async () => {
  assert.equal(timer.BOOKING_SYNC_SCHEDULE, "0 7 6 * * *");
  assert.equal(timer.BOOKING_SYNC_TICK_PATH, "/internal/booking-button-sync-tick");
  const calls = [];
  const r = await timer.ringBookingSync(() => {}, {
    env: { ARION_API_BASE_URL: "https://arion.example.test/", ARION_INGEST_KEY: "k" },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ ok: true, summary: { sites: 1, cleared: 1 } }); },
  });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://arion.example.test/internal/booking-button-sync-tick");
  assert.equal(calls[0].init.headers["x-arion-ingest-key"], "k");
  const failed = await timer.ringBookingSync(() => {}, { env: { ARION_API_BASE_URL: "https://a.test" }, fetchImpl: async () => { throw new Error("down"); } });
  assert.equal(failed.ok, false);
  const route = path.join(ROOT, "..", "arion-api-septa", "routes", "internal.js");
  if (fs.existsSync(route)) {
    assert.match(fs.readFileSync(route, "utf8"), /router\.post\('\/booking-button-sync-tick'/, "arion-api mounts the path this timer rings");
  }
  assert.match(fs.readFileSync(path.join(ROOT, "src", "index.js"), "utf8"), /import "\.\/functions\/bookingButtonSync\.js";/);
});
