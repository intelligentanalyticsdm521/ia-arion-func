import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runInsightsSnapshot } from "../shared/insightsSnapshot.js";

/**
 * IA Insights monthly snapshot — fires on the 1st of each month at 05:31 UTC
 * (prime-minute spread per timer convention).
 *
 * Aggregates the prior months' captured data into arion.metric_monthly — the
 * storage every Insights dashboard reads via GET /arion/insights/metrics.
 * MERGE-idempotent: safe to re-run, refreshes the current month on each pass.
 * Sources today: SE Ranking position history (kw_* + per-keyword dimension
 * rows). GSC / GBP / GA4 extend runInsightsSnapshot as their plumbing lands.
 */
app.timer("arionInsightsMonthlySnapshot", {
  schedule: "0 31 5 1 * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[insights-snapshot] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const result = await runInsightsSnapshot(pool, (m) => context.log(m));
    context.log(
      `[insights-snapshot] done — ${result.sitesProcessed} site(s), ${result.rowsUpserted} row(s) upserted, ${result.errors.length} error(s)`
    );
  },
});
