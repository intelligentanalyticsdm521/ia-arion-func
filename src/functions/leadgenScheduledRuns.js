import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runLeadgenScheduledTick } from "../shared/leadgenScheduler.js";

/**
 * F-LG.6 — Lead Gen scheduled-runs dispatcher.
 *
 * Polls lumen.search_profile every 30 minutes for rows where
 *   is_scheduled = 1 AND next_run_at <= SYSUTCDATETIME()
 * then for each:
 *   - checks credit pool (pauses + emails if empty per F-LG.6.5)
 *   - inserts a search_job (status='queued')
 *   - logs to lumen.leadgen_schedule_dispatch
 *   - advances next_run_at from cadence + tz
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
 *   LEADGEN_SCHEDULE_PAUSE_ON_DRY_POOL=false → keep firing even with 0 credits
 *                                              (default true — pause + email)
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
  },
});
