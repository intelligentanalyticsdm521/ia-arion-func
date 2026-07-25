// src/functions/insightsMonthlySnapshot.js
//
// IA Insights monthly snapshot timer — thin scheduler: calls arion-api's
// internal /internal/insights-snapshot-tick which owns ALL the logic
// (SE Ranking aggregation + GSC/GA4/GBP pulls into arion.metric_monthly).
// Same split as gbpAutoReply — logic in the API, scheduling here.
//
//   Schedule: "0 31 5 1 * *" — 1st of month 05:31 UTC (prime-minute spread
//             per the timer-schedules convention).
//
// ENV
//   ARION_API_BASE_URL   e.g. https://app-arion-api-prod-…azurewebsites.net
//   ARION_INGEST_KEY     shared secret for the internal endpoint
//
// Kill switch: INSIGHTS_SNAPSHOT_DISABLED=true → no-op.
//
// History note (2026-07-25): the initial deep backfill (SE Ranking 12mo,
// GSC ~16mo, GBP 18mo, GA4 to retention, all four sites) was run once by
// arion-api/scripts/_backfill_seranking_prod.mts + _backfill_google_prod.mjs.
// This timer only keeps it current (last 2 months, MERGE-idempotent).

import { app } from "@azure/functions";

const SCHEDULE = "0 31 5 1 * *";

app.timer("arionInsightsMonthlySnapshot", {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(`[insights-snapshot] ${m}`);
    if (process.env.INSIGHTS_SNAPSHOT_DISABLED === "true") { log("disabled via INSIGHTS_SNAPSHOT_DISABLED"); return; }
    const base = (process.env.ARION_API_BASE_URL || "").replace(/\/+$/, "");
    const key = process.env.ARION_INGEST_KEY || "";
    if (!base) { log("ARION_API_BASE_URL not set — skipping"); return; }
    log(`starting (schedule=${SCHEDULE})`);
    try {
      const res = await fetch(`${base}/internal/insights-snapshot-tick`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-arion-ingest-key": key },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { log(`tick HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`); return; }
      log(`done: ${JSON.stringify(body.summary || {}).slice(0, 400)}`);
    } catch (err) {
      log(`tick error: ${err.message}`);
    }
  },
});
