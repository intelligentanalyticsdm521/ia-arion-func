import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runMovesCapture } from "../shared/marketMonitor.js";

/**
 * Competitor Moves — daily at 03:17 UTC (off-peak, avoids :00 stampede).
 * Snapshots current positions for own-site + competitors to
 * arion.se_ranking_position_history. The /arion/seo/market-monitor endpoint
 * diffs rows across time windows to produce the Moves feed.
 *
 * ⚠️ 2026-07-16 — THIS FUNCTION HAS WRITTEN NOTHING SINCE 2026-07-10 AND SAID
 *    NOTHING ABOUT IT. Seven days of SEO rank history lost, and rank history
 *    cannot be backfilled.
 *
 * What the evidence showed:
 *   - arion.se_ranking_position_history: ~2,651 rows/day, last row 2026-07-10T03:17.
 *   - The timer IS firing. Its status blob
 *     (azure-webjobs-hosts/timers/func-iadm-arion-prod/Host.Functions.arionMarketMonitorMoves/status
 *     on storage iadmwebhooksprodstg) reads
 *     {"Last":"2026-07-16T03:17","Next":"2026-07-17T03:17"} — it has run every
 *     single morning. NOT a stuck timer.
 *   - arion.market_monitor_job_log's last 'moves' row is ALSO 2026-07-10T03:16.
 *     So the function dies BEFORE logJobStart can insert anything.
 *   - Precursor: job_log shows "Timeout: Request failed to complete in 15000ms"
 *     on 2026-07-05 and 07-06, then success on 07-09/07-10, then silence.
 *     Points at the DB connection, not SE Ranking.
 *   - Ruled out: SE Ranking API + keys work (api4.seranking.com/sites with the
 *     SYSTEM key returns 200 with live data); site selection returns its 1 site;
 *     the Function App is Running with 18 functions and no deploy since
 *     2026-04-19; the func's managed identity has db_datareader + db_datawriter
 *     on iadm_services; the SQL firewall allows Azure IPs.
 *
 * Why nobody could see the cause: this handler awaited getServicesPool() and
 * runMovesCapture() with NO try/catch, and runMovesCapture called
 * listAuthoritySites() and logJobStart() outside its own try. A failure at any
 * of those four points threw straight out of the handler having written no
 * job_log row — leaving an App Insights exception as the ONLY trace, in a
 * component (func-iadm-arion-prod202603051733, appId 107eb168-…) that is easy to
 * miss because a second, similarly-named App Insights resource also exists.
 *
 * A daily job that can fail silently for a week is an observability defect
 * first and a bug second. The handler now names its own cause.
 */
app.timer("arionMarketMonitorMoves", {
  schedule: "0 17 3 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    const startedAt = Date.now();
    context.log("[mm-moves] starting", { scheduleStatus: timer.scheduleStatus });

    // Each stage is named so a thrown error says WHICH one died. Previously any
    // failure here was indistinguishable from any other.
    let stage = "getServicesPool";
    try {
      const pool = await getServicesPool();

      stage = "runMovesCapture";
      const result = await runMovesCapture(pool, (m) => context.log(`[mm-moves] ${m}`));

      const ms = Date.now() - startedAt;
      context.log(
        `[mm-moves] done — ${result.sitesProcessed} site(s), ${result.rowsWritten} row(s), ${result.errors.length} error(s) in ${ms}ms`
      );

      // A "successful" run that wrote nothing is the exact shape this outage
      // took for seven days. Say so loudly rather than logging a cheerful zero.
      if (result.sitesProcessed > 0 && result.rowsWritten === 0) {
        context.error(
          `[mm-moves] 🔴 processed ${result.sitesProcessed} site(s) but wrote ZERO rows — ` +
            `this is the signature of the 2026-07-10 outage. Errors: ${JSON.stringify(result.errors).slice(0, 500)}`
        );
      }
      if (result.errors.length) {
        context.error(
          `[mm-moves] ${result.errors.length} site error(s): ${JSON.stringify(result.errors).slice(0, 800)}`
        );
      }
    } catch (err) {
      // Do NOT swallow — a silently-skipped daily capture is unrecoverable data
      // loss. Log full detail, then rethrow so the Functions host records a
      // FAILED invocation. A swallowed error shows as a successful run in the
      // portal, which is how this hid for a week.
      context.error(`[mm-moves] 🔴 FAILED at stage "${stage}" after ${Date.now() - startedAt}ms`, {
        stage,
        message: err?.message,
        code: err?.code,
        name: err?.name,
        stack: err?.stack,
      });
      throw err;
    }
  },
});
