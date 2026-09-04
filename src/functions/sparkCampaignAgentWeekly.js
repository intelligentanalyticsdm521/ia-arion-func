// src/functions/sparkCampaignAgentWeekly.js
//
// SPARK Campaign & Automation Agent — weekly win-back signal check + draft
// cycle. Thin scheduler in the house pattern (gbpAutoReply / socialPostDispatcher
// / contentAgentWeekly): the timer only POSTs LUMEN's internal tick; every
// piece of logic — signals, cohorts, drafting, guardrails, cost breaker — lives
// in LUMEN-API src/lib/campaignAgent/.
//
//   Schedule: "0 40 12 * * Mon" — Monday 12:40 UTC (~7:40am CT), prime-minute
//             spread per the timer-schedules convention. Drafts are waiting in
//             the review queue when the Monday planning session starts;
//             approval and the actual SEND remain explicit human actions (AC9).
//
// ENV
//   LUMEN_API_BASE_URL             e.g. https://app-lumen-api-prod-….azurewebsites.net
//   LUMEN_INTERNAL_SERVICE_TOKEN   shared secret for /api/v1/internal/* (the
//                                  canonical token; requireInternalServiceToken
//                                  also accepts LUMEN_WALKTHROUGH_SEED_TOKEN)
//
// Kill switch: CAMPAIGN_AGENT_DISABLED=true → no-op (scope §35 rollback:
// flipping this reverts to the manual campaign process with zero data loss).

import { app } from "@azure/functions";

const SCHEDULE = "0 40 12 * * Mon";

app.timer("sparkCampaignAgentWeekly", {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(`[spark-campaign-agent] ${m}`);
    if (process.env.CAMPAIGN_AGENT_DISABLED === "true") { log("disabled via CAMPAIGN_AGENT_DISABLED"); return; }
    const base = (process.env.LUMEN_API_BASE_URL || "").replace(/\/+$/, "");
    const key = process.env.LUMEN_INTERNAL_SERVICE_TOKEN || "";
    if (!base) { log("LUMEN_API_BASE_URL not set — skipping"); return; }
    if (!key) { log("LUMEN_INTERNAL_SERVICE_TOKEN not set — skipping (the endpoint fail-closes anyway)"); return; }
    log(`starting (schedule=${SCHEDULE})`);
    try {
      const res = await fetch(`${base}/api/v1/internal/campaign-agent/tick`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-token": key },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { log(`tick HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`); return; }
      const s = body.summary || {};
      log(`done: tenants=${s.tenants} results=${JSON.stringify((s.results || []).map((r) => ({ t: r.tenantId, o: r.outcome, d: r.drafted })))}`);
      for (const a of s.alerts || []) log(`ALERT [${a.failure_mode}] tenant=${a.tenantId}: ${a.message}`);
    } catch (err) {
      log(`tick error: ${err.message}`);
    }
  },
});
