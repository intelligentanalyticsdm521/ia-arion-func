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

// THE ENDPOINT IS ON THE LINE AS OF 2026-09-08. It was not when this timer was
// first registered: the whole ARION Content & Social Agent sat uncommitted in
// the C:/dev/iadm/arion-api working copy (branch reconciliation 2026-09-04,
// D-3), so this fired into a 404 every Monday - no throw, no retry storm, no
// data touched. arion-api branch feat/content-agent-takeover lands
// lib/contentAgent/, routes/arion/contentAgent.js, the routes/internal.js mount
// and migrations 063/064; the tick answers for real once that merges.
//
// Its sibling sparkCampaignAgentWeekly.js never had that gap: LUMEN-API
// src/routes/campaignAgent.js:358 mounts
// POST /api/v1/internal/campaign-agent/tick on the line.
//
// BOTH PATHS AND BOTH SCHEDULES ARE EXPORTED CONSTANTS, pinned by
// test/agent-timers.test.mjs. A path spelled inline in a fetch template is a
// path nothing can check, and a 404 every Monday is exactly the failure that
// looks like nothing at all.

import { app } from "@azure/functions";

export const CONTENT_AGENT_SCHEDULE = "0 41 5 * * Mon";
export const CONTENT_AGENT_TICK_PATH = "/internal/content-agent-tick";
export const CONTENT_AGENT_KILL_SWITCH = "CONTENT_AGENT_DISABLED";

const SCHEDULE = CONTENT_AGENT_SCHEDULE;

app.timer("contentAgentWeekly", {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(`[content-agent] ${m}`);
    if (process.env[CONTENT_AGENT_KILL_SWITCH] === "true") { log(`disabled via ${CONTENT_AGENT_KILL_SWITCH}`); return; }
    const base = (process.env.ARION_API_BASE_URL || "").replace(/\/+$/, "");
    const key = process.env.ARION_INGEST_KEY || "";
    if (!base) { log("ARION_API_BASE_URL not set — skipping"); return; }
    log(`starting (schedule=${SCHEDULE})`);
    try {
      const res = await fetch(`${base}${CONTENT_AGENT_TICK_PATH}`, {
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
