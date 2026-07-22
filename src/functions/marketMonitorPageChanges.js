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
    const startedAt = Date.now();
    context.log("[mm-pagechanges] starting", { scheduleStatus: timer.scheduleStatus });

    // 2026-07-22 — same stage-named hardening the Moves handler got after the
    // 2026-07-10 silent outage: a bare await here threw straight out of the
    // handler with no job_log row and no attribution.
    let stage = "getServicesPool";
    try {
      const pool = await getServicesPool();

      stage = "runPageChangeSweep";
      const result = await runPageChangeSweep(pool, (m) => context.log(`[mm-pagechanges] ${m}`));

      context.log(`[mm-pagechanges] done — ${result.sitesProcessed} site(s), ${result.rowsWritten} row(s), ${result.errors.length} error(s) in ${Date.now() - startedAt}ms`);
      if (result.sitesProcessed > 0 && result.rowsWritten === 0) {
        context.error(`[mm-pagechanges] 🔴 processed ${result.sitesProcessed} site(s) but wrote ZERO rows. Errors: ${JSON.stringify(result.errors).slice(0, 500)}`);
      }
      if (result.errors.length) {
        context.error(`[mm-pagechanges] ${result.errors.length} site error(s): ${JSON.stringify(result.errors).slice(0, 800)}`);
      }
    } catch (err) {
      // Log full detail, then rethrow so the host records a FAILED invocation
      // — never a cheerful success with nothing written.
      context.error(`[mm-pagechanges] 🔴 FAILED at stage "${stage}" after ${Date.now() - startedAt}ms`, {
        stage, message: err?.message, code: err?.code, name: err?.name, stack: err?.stack,
      });
      throw err;
    }
  },
});
