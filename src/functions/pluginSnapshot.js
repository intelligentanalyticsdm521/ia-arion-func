import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runPluginSnapshot } from "../shared/pluginSnapshot.js";

/**
 * Plugin Snapshot — nightly 05:17 UTC (off-peak for US clients).
 *
 * Pulls security / performance / content / updates / theme data from every
 * connected site's IA Plugin and upserts a daily row into
 * arion.site_plugin_snapshot. Also refreshes arion.site_plugin_inventory.
 *
 * Portal's trend views + Insights posture score use these snapshot rows
 * instead of hitting live plugin endpoints on every page load, so WP server
 * load scales flat regardless of how many portal users view how many pages.
 *
 * Live plugin pulls (via arion-api /plugin/* proxies) continue to serve the
 * on-demand "current state" views. Snapshots serve historical trends +
 * fallback when a site is briefly unreachable.
 */
app.timer("arionPluginSnapshot", {
  schedule: "0 17 5 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[plugin-snapshot] starting", { scheduleStatus: timer.scheduleStatus });
    const startedAt = Date.now();

    // 2026-08-14 — same stage-named hardening the market-monitor handlers got
    // after the 2026-07-10 silent outage (01c96fd). This job checked sites and
    // wrote ZERO rows every night since it was written, and reported it at
    // context.log level with a cheerful "done" — so nothing ever surfaced it.
    // A job that processes sites and writes nothing is an OUTAGE, not an info line.
    let stage = "getServicesPool";
    try {
      const pool = await getServicesPool();

      stage = "runPluginSnapshot";
      const result = await runPluginSnapshot(pool, (m) => context.log(`[plugin-snapshot] ${m}`));

      context.log(
        `[plugin-snapshot] done — ${result.sitesChecked} site(s) checked, ` +
        `${result.sitesWritten} snapshot(s) written, ${result.errors.length} error(s) ` +
        `in ${Date.now() - startedAt}ms`
      );
      if (result.sitesChecked > 0 && result.sitesWritten === 0) {
        context.error(
          `[plugin-snapshot] 🔴 checked ${result.sitesChecked} site(s) but wrote ZERO snapshots. ` +
          `Errors: ${JSON.stringify(result.errors).slice(0, 800)}`
        );
      }
      if (result.errors.length) {
        context.error(
          `[plugin-snapshot] ${result.errors.length} site error(s): ${JSON.stringify(result.errors).slice(0, 800)}`
        );
      }
    } catch (err) {
      // Log full detail, then rethrow so the host records a FAILED invocation —
      // never a cheerful success with nothing written.
      context.error(`[plugin-snapshot] 🔴 FAILED at stage "${stage}" after ${Date.now() - startedAt}ms`, {
        stage, message: err?.message, code: err?.code, name: err?.name, stack: err?.stack,
      });
      throw err;
    }
  },
});
