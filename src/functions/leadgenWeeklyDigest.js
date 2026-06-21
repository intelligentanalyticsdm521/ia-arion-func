import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runWeeklyDigestTick } from "../shared/weeklyDigestSender.js";

/**
 * F-LG.6.4 — Lead Gen weekly digest mailer.
 *
 * Every Monday at 07:00 UTC (≈ 02:00 America/Chicago, 03:00 ET, 23:00 PT
 * Sunday) — picked over a US-business-hours slot because the digest
 * summarises the PRIOR Mon–Sun and we want it in the inbox before the
 * tenant starts their week. The schedule format is the standard 6-field
 * NCRONTAB: "sec min hour day-of-month month day-of-week"; "0 0 7 * * 1"
 * fires at 07:00:00 every Monday.
 *
 * One tick:
 *   - Reads lumen.leadgen_schedule_dispatch for the prior week.
 *   - Builds per-tenant digest + resolves owner from core.tenants.
 *   - Checks email suppression (master list + per-contact marketing prefs).
 *   - Skips tenants with zero leads AND zero "paused-no-credits" rows.
 *   - Sends via iadm-webhooks /api/acs/email/send.
 *
 * Env overrides:
 *   LEADGEN_DIGEST_DISABLED=true   → no-op (kill switch).
 *   LEADGEN_DIGEST_DRY_RUN=1       → render & log, never POST. Use for
 *                                    weekend smoke tests in prod without
 *                                    a real send.
 *   LEADGEN_DIGEST_FROM_EMAIL      → optional sender override.
 *   LEADGEN_DIGEST_FROM_NAME       → optional display name.
 *
 * Brandon's locked product rule: tenants are opted in by default. The
 * per-contact suppression check inside runWeeklyDigestTick is the
 * authoritative honour-of-unsubscribe path.
 */
app.timer("leadgenWeeklyDigest", {
  schedule: "0 0 7 * * 1",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.LEADGEN_DIGEST_DISABLED === "true") {
      context.log("[leadgen-digest] disabled via LEADGEN_DIGEST_DISABLED");
      return;
    }
    context.log("[leadgen-digest] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const summary = await runWeeklyDigestTick(pool, (m) => context.log(m));
    context.log("[leadgen-digest] done", summary);
  },
});
