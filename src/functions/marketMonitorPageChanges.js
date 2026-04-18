import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runPageChangeSweep } from "../shared/marketMonitor.js";

/**
 * Page Changes — daily at 05:41 UTC.
 * Walks arion.site_page_watch, fetches each URL, hashes the main content,
 * and logs differences into arion.site_page_change.
 */
app.timer("arionMarketMonitorPageChanges", {
  schedule: "0 41 5 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[mm-pagechanges] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const result = await runPageChangeSweep(pool, (m) => context.log(`[mm-pagechanges] ${m}`));
    context.log(`[mm-pagechanges] done — ${result.sitesProcessed} site(s), ${result.rowsWritten} row(s), ${result.errors.length} error(s)`);
  },
});
