import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runMonthlyPageSpeed } from "../shared/pagespeedRunner.js";

/**
 * Monthly PageSpeed — fires on the 1st of each month at 05:13 UTC
 * (overnight US hours, off-peak prime-minute spread per timer convention).
 *
 * Runs Google PSI for every ARION site in mobile + desktop strategies,
 * captures CrUX field data + Lighthouse opportunities, and stores in
 * arion.site_pagespeed_snapshot so the Portal Core Web Vitals page always
 * has fresh data without requiring a manual run.
 */
app.timer("arionMonthlyPageSpeed", {
  schedule: "0 13 5 1 * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[monthly-pagespeed] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const result = await runMonthlyPageSpeed(pool, (m) => context.log(`[monthly-pagespeed] ${m}`));
    context.log(
      `[monthly-pagespeed] done — ${result.sitesProcessed} site(s), ${result.snapshotsWritten} snapshot(s), ${result.errors.length} error(s)`
    );
  },
});
