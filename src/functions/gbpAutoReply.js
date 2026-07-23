// src/functions/gbpAutoReply.js
//
// GBP Pro+ auto-reply timer (Brandon 2026-07-22). Thin scheduler: calls
// arion-api's internal /internal/gbp-auto-reply-tick which owns all the
// GBP + Claude + credit-metering logic (same split as the social
// dispatcher — logic in the API, scheduling here).
//
//   Schedule: "0 20 6 * * *" — 06:20 UTC daily (prime-minute spread per the
//             timer-schedules convention; once a day is plenty for reviews).
//
// ENV
//   ARION_API_BASE_URL   e.g. https://app-arion-api-prod-…azurewebsites.net
//   ARION_INGEST_KEY     shared secret for the internal endpoint
//
// Kill switch: GBP_AUTO_REPLY_DISABLED=true → no-op.

import { app } from "@azure/functions";

const SCHEDULE = "0 20 6 * * *";

app.timer("gbpAutoReply", {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(`[gbp-auto-reply] ${m}`);
    if (process.env.GBP_AUTO_REPLY_DISABLED === "true") { log("disabled via GBP_AUTO_REPLY_DISABLED"); return; }
    const base = (process.env.ARION_API_BASE_URL || "").replace(/\/+$/, "");
    const key = process.env.ARION_INGEST_KEY || "";
    if (!base) { log("ARION_API_BASE_URL not set — skipping"); return; }
    log(`starting (schedule=${SCHEDULE})`);
    try {
      const res = await fetch(`${base}/internal/gbp-auto-reply-tick`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-arion-ingest-key": key },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { log(`tick HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`); return; }
      log(`done: ${JSON.stringify(body.summary || {})}`);
    } catch (err) {
      log(`tick error: ${err.message}`);
    }
  },
});
