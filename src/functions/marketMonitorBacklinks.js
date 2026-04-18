import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runBacklinkSnapshot } from "../shared/marketMonitor.js";

/**
 * Backlink Watch — weekly Sunday 04:23 UTC.
 * Pulls the latest referring-domain list from SE Ranking Data API and diffs
 * against the last week's snapshot to label new/lost links.
 */
app.timer("arionMarketMonitorBacklinks", {
  schedule: "0 23 4 * * 0",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[mm-backlinks] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const result = await runBacklinkSnapshot(pool, (m) => context.log(`[mm-backlinks] ${m}`));
    context.log(`[mm-backlinks] done — ${result.sitesProcessed} site(s), ${result.rowsWritten} row(s), ${result.errors.length} error(s)`);
  },
});
