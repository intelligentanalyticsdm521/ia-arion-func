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
    const pool = await getServicesPool();
    const result = await runPluginSnapshot(pool, (m) => context.log(`[plugin-snapshot] ${m}`));
    context.log(
      `[plugin-snapshot] done — ${result.sitesChecked} site(s) checked, ` +
      `${result.sitesWritten} snapshot(s) written, ${result.errors.length} error(s)`
    );
    if (result.errors.length) {
      for (const e of result.errors) {
        context.log(`[plugin-snapshot] error — site ${e.siteId}: ${e.reason}`);
      }
    }
  },
});
