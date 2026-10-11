// src/functions/bookingButtonSync.js
//
// The website "Book now" button follows the OLIVER subscription (FEATURES
// row 17, 11 Oct 2026). Thin scheduler: calls arion-api's internal
// /internal/booking-button-sync-tick, which owns the logic
// (lib/bookingButtonSync.js there): for each connected site it asks the one
// subscription answer and pushes it to the site's IA plugin —
//   OLIVER ended, or no booking page -> an EMPTY booking address (button off)
//   OLIVER owned with a booking page -> the booking page's address
//   undecided                        -> nothing pushed; the site keeps what it had.
// Before this, ARION pushed only at provisioning and when the website editor
// was opened, so an ended OLIVER left the button on the site.
//
//   Schedule: "0 7 6 * * *" — 06:07 UTC daily (prime-minute spread per the
//             timer-schedules convention; no other timer uses :07 at 06).
//
// ENV
//   ARION_API_BASE_URL   e.g. https://app-arion-api-prod-…azurewebsites.net
//   ARION_INGEST_KEY     shared secret for the internal endpoint
//
// Kill switch: BOOKING_BUTTON_SYNC_DISABLED=true → no-op.
//
// The path and schedule are exported constants, pinned by
// test/booking-button-sync-timer.test.mjs and cross-checked against the
// arion-api route when that checkout is present.

import { app } from "@azure/functions";

export const BOOKING_SYNC_SCHEDULE = "0 7 6 * * *";
export const BOOKING_SYNC_TICK_PATH = "/internal/booking-button-sync-tick";
export const BOOKING_SYNC_KILL_SWITCH = "BOOKING_BUTTON_SYNC_DISABLED";

/** One ring of the bell. Never throws: a failed tick logs and returns. */
export async function ringBookingSync(log, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env[BOOKING_SYNC_KILL_SWITCH] === "true") { log(`disabled via ${BOOKING_SYNC_KILL_SWITCH}`); return { skipped: "disabled" }; }
  const base = String(env.ARION_API_BASE_URL || "").replace(/\/+$/, "");
  const key = env.ARION_INGEST_KEY || "";
  if (!base) { log("ARION_API_BASE_URL not set — skipping"); return { skipped: "no_base_url" }; }
  try {
    const res = await fetchImpl(`${base}${BOOKING_SYNC_TICK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arion-ingest-key": key },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { log(`tick HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`); return { ok: false, status: res.status }; }
    const s = body.summary || {};
    log(`done: sites=${s.sites} pointed=${s.pointed} cleared=${s.cleared} held=${s.held} oldPlugin=${s.old_plugin} failed=${s.failed}`);
    return { ok: true, summary: s };
  } catch (err) {
    log(`tick error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

app.timer("arionBookingButtonSync", {
  schedule: BOOKING_SYNC_SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(`[booking-button-sync] ${m}`);
    log(`starting (schedule=${BOOKING_SYNC_SCHEDULE})`);
    await ringBookingSync(log);
  },
});
