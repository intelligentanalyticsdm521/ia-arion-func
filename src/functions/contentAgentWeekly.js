// src/functions/contentAgentWeekly.js
//
// ARION Content & Social Agent — weekly cycle timer (Task 8 of the Content
// Agent scope v0.2). Thin scheduler: calls arion-api's internal
// /internal/content-agent-tick, which owns tenant enablement, provider
// resolution, drafting, guardrails, cost breakers and the 60% margin report
// (same logic-in-the-API split as gbpAutoReply and the social dispatcher).
//
//   Schedule: "0 41 5 * * Mon" — 05:41 UTC Mondays (prime-minute spread per
//             the timer-schedules convention; 05:41 UTC = before the US
//             business day, so the review queue is ready for the Monday
//             planning session).
//
// ENV
//   ARION_API_BASE_URL   e.g. https://app-arion-api-prod-…azurewebsites.net
//   ARION_INGEST_KEY     shared secret for the internal endpoint
//
// Kill switch: CONTENT_AGENT_DISABLED=true → no-op. This is also the scope's
// §35 rollback plan: flip the switch and the manual workflow continues
// untouched, zero data loss.

// ⚠ ENDPOINT NOT YET ON release/sept-a-2026 (checked 2026-09-03).
// arion-api POST /internal/content-agent-tick does not exist on the arion-api
// integration line: the whole ARION Content & Social Agent — lib/contentAgent/,
// routes/arion/contentAgent.js and the routes/internal.js mount — is still
// UNCOMMITTED in the C:/dev/iadm/arion-api working copy (branch reconciliation
// 2026-09-04, D-3). Until that session commits and its branch merges, this
// timer POSTs a 404 every Monday and logs "tick HTTP 404" — no throw, no
// retry storm, no data touched. The timer is registered now rather than held
// back so the schedule ships with the rest of the release and the only thing
// left to land is the API half.
//
// Its sibling sparkCampaignAgentWeekly.js has no such gap: LUMEN-API
// src/routes/campaignAgent.js:358 already mounts
// POST /api/v1/internal/campaign-agent/tick on the line.

import { app } from "@azure/functions";

const SCHEDULE = "0 41 5 * * Mon";

app.timer("contentAgentWeekly", {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(`[content-agent] ${m}`);
    if (process.env.CONTENT_AGENT_DISABLED === "true") { log("disabled via CONTENT_AGENT_DISABLED"); return; }
    const base = (process.env.ARION_API_BASE_URL || "").replace(/\/+$/, "");
    const key = process.env.ARION_INGEST_KEY || "";
    if (!base) { log("ARION_API_BASE_URL not set — skipping"); return; }
    log(`starting (schedule=${SCHEDULE})`);
    try {
      const res = await fetch(`${base}/internal/content-agent-tick`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-arion-ingest-key": key },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { log(`tick HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`); return; }
      const s = body.summary || {};
      log(`done: tenants=${s.tenants} ran=${s.ran} haltedSkips=${s.skippedHalted} failed=${s.failed} alerts=${(s.alerts || []).length}`);
      // Margin breaches deserve their own log line — they are the "seriously
      // rethink pricing" signal and must not hide inside a summary blob.
      for (const a of s.alerts || []) {
        if (a.failure_mode === "MARGIN") log(`MARGIN: ${a.message}`);
        if (a.failure_mode === "F8") log(`COST HALT: ${a.message}`);
      }
    } catch (err) {
      log(`tick error: ${err.message}`);
    }
  },
});
