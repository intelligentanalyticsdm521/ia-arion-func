import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runMovesCapture } from "../shared/marketMonitor.js";

/**
 * Competitor Moves — daily at 03:17 UTC (off-peak, avoids :00 stampede).
 * Snapshots current positions for own-site + competitors to
 * arion.se_ranking_position_history. The /arion/seo/market-monitor endpoint
 * diffs rows across time windows to produce the Moves feed.
 */
app.timer("arionMarketMonitorMoves", {
  schedule: "0 17 3 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[mm-moves] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const result = await runMovesCapture(pool, (m) => context.log(`[mm-moves] ${m}`));
    context.log(`[mm-moves] done — ${result.sitesProcessed} site(s), ${result.rowsWritten} row(s), ${result.errors.length} error(s)`);
  },
});
