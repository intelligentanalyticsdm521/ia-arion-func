import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runLeadgenScheduledTick, runPreRunNoticePass } from "../shared/leadgenScheduler.js";

/**
 * F-LG.6 — Lead Gen scheduled-runs dispatcher.
 *
 * Polls lumen.search_profile every 30 minutes for rows where
 *   is_scheduled = 1 AND next_run_at <= SYSUTCDATETIME()
 * then for each:
 *   - inserts a search_job (status='queued'); the lead allotment is resolved by
 *     LUMEN's settlement.ensureReserved when the sweeper claims it (G-5 — the
 *     Stripe-derived package is the only truth)
 *   - logs to lumen.leadgen_schedule_dispatch
 *   - advances next_run_at from cadence + tz
 * then a second pass emails the owner about runs two business days out.
 *
 * Schedule: every 30 min off-peak prime-minute (per convention_timer_schedules).
 *   "0 7/30 * * * *" → :07, :37 each hour.
 *   Existing arion-func timers fire at :03/:18/:33/:48 (autotopoff),
 *   :15 (hour mark of pluginSnapshot), :17/:29/:43 (market monitor),
 *   so :07/:37 is a clean unused prime-minute slot.
 *
 * Env overrides:
 *   LEADGEN_SCHEDULE_DISABLED=true    → no-op (kill switch)
 *   LEADGEN_SCHEDULE_MAX_PER_TICK=N   → cap rows per tick (default 25)
 *   LEADGEN_SCHEDULE_DEFAULT_TARGET=N → target leads when profile has no
 *                                       max_results_per_run override (default 100)
 *   LEADGEN_PRE_RUN_NOTICE_DISABLED=true → skip the pre-run notice pass
 *   LEADGEN_PRE_RUN_NOTICE_DAYS=N     → business days of notice (default 2)
 */
app.timer("leadgenScheduledRuns", {
  schedule: "0 7/30 * * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.LEADGEN_SCHEDULE_DISABLED === "true") {
      context.log("[leadgen-schedule] disabled via LEADGEN_SCHEDULE_DISABLED");
      return;
    }
    context.log("[leadgen-schedule] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const summary = await runLeadgenScheduledTick(pool, (m) => context.log(m));
    context.log("[leadgen-schedule] done", summary);

    // PASS 2 — the 2-business-day pre-run notice (A.2 P5 / X1). Same tick, no
    // new timer and no new Function App (POC rule + convention_timer_schedules).
    // Wrapped so a notice failure can never stop runs from being queued.
    try {
      const notices = await runPreRunNoticePass(pool, (m) => context.log(m));
      context.log("[leadgen-notice] done", notices);
    } catch (err) {
      context.log(`[leadgen-notice] pass failed: ${err.message}`);
    }
  },
});
