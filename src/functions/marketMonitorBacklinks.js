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
    const startedAt = Date.now();
    context.log("[mm-backlinks] starting", { scheduleStatus: timer.scheduleStatus });

    // 2026-07-22 — same stage-named hardening the Moves handler got after the
    // 2026-07-10 silent outage: a bare await here threw straight out of the
    // handler with no job_log row and no attribution.
    let stage = "getServicesPool";
    try {
      const pool = await getServicesPool();

      stage = "runBacklinkSnapshot";
      const result = await runBacklinkSnapshot(pool, (m) => context.log(`[mm-backlinks] ${m}`));

      context.log(`[mm-backlinks] done — ${result.sitesProcessed} site(s), ${result.rowsWritten} row(s), ${result.errors.length} error(s) in ${Date.now() - startedAt}ms`);
      if (result.sitesProcessed > 0 && result.rowsWritten === 0) {
        context.error(`[mm-backlinks] 🔴 processed ${result.sitesProcessed} site(s) but wrote ZERO rows. Errors: ${JSON.stringify(result.errors).slice(0, 500)}`);
      }
      if (result.errors.length) {
        context.error(`[mm-backlinks] ${result.errors.length} site error(s): ${JSON.stringify(result.errors).slice(0, 800)}`);
      }
    } catch (err) {
      // Log full detail, then rethrow so the host records a FAILED invocation
      // — never a cheerful success with nothing written.
      context.error(`[mm-backlinks] 🔴 FAILED at stage "${stage}" after ${Date.now() - startedAt}ms`, {
        stage, message: err?.message, code: err?.code, name: err?.name, stack: err?.stack,
      });
      throw err;
    }
  },
});
