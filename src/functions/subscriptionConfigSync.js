// src/functions/subscriptionConfigSync.js — the daily bell for each connected
// website's subscription state (2026-10-11, "the subscription is the
// permission"). arion-api's POST /internal/subscription-config-tick pushes two
// options to every connected site's plugin: ia_spark_capture (the SPARK
// identify call, pixel and chat tag run only for a business with SPARK) and
// ia_tier (the ARION tier the business pays for, so a downgrade reaches the
// site the same day instead of never). The logic lives in arion-api
// lib/websiteBuilder/subscriptionConfig.js; this file only rings the bell,
// the same way bookingButtonSync.js does for the "Book now" button.
import { app } from "@azure/functions";

export const SUBSCRIPTION_SYNC_SCHEDULE = "0 17 6 * * *"; // daily 06:17 UTC, ten minutes after the booking-button bell
export const SUBSCRIPTION_SYNC_TICK_PATH = "/internal/subscription-config-tick";
export const SUBSCRIPTION_SYNC_KILL_SWITCH = "SUBSCRIPTION_CONFIG_SYNC_DISABLED";

/** One ring of the bell. Never throws: a failed tick logs and returns. */
export async function ringSubscriptionSync(log, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env[SUBSCRIPTION_SYNC_KILL_SWITCH] === "true") { log(`disabled via ${SUBSCRIPTION_SYNC_KILL_SWITCH}`); return { skipped: "disabled" }; }
  const base = String(env.ARION_API_BASE_URL || "").replace(/\/+$/, "");
  const key = env.ARION_INGEST_KEY || "";
  if (!base) { log("ARION_API_BASE_URL not set — skipping"); return { skipped: "no_base_url" }; }
  try {
    const res = await fetchImpl(`${base}${SUBSCRIPTION_SYNC_TICK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arion-ingest-key": key },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { log(`tick HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`); return { ok: false, status: res.status }; }
    const s = body.summary || {};
    log(`done: sites=${s.sites} pushed=${s.pushed} captureOn=${s.capture_on} tierPushed=${s.tier_pushed} tierHeld=${s.tier_held} oldPlugin=${s.old_plugin} failed=${s.failed}`);
    return { ok: true, summary: s };
  } catch (err) {
    log(`tick error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

app.timer("arionSubscriptionConfigSync", {
  schedule: SUBSCRIPTION_SYNC_SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(`[subscription-config-sync] ${m}`);
    log(`starting (schedule=${SUBSCRIPTION_SYNC_SCHEDULE})`);
    await ringSubscriptionSync(log);
  },
});
