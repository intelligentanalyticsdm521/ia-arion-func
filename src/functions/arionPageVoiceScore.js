import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runPageVoiceScoreScan } from "../shared/pageVoiceScore.js";

/**
 * ARION Page Voice Score — daily 05:55 UTC (off-peak for US tenants).
 *
 * Wave 3 (Brandon 2026-06-22). For every ARION-managed WP site, pull
 * recent published pages/posts via the IA Plugin REST + score each body
 * against the tenant's brand voice profile (LUMEN-API
 * /api/v1/my-brand/voice/_internal/score). Persists per-(site_id, page_url)
 * rows in arion.page_voice_score (see arion-api migration 032). The full
 * per-check audit trail with cost telemetry lives in lumen.brand_voice_check
 * from LUMEN-API migration 052.
 *
 * Why post-publish (timer) instead of pre-publish (plugin hook):
 *   Pages are edited in WordPress by humans, often outside our control.
 *   Brand voice drift is best surfaced as a nightly scan + dashboard
 *   alert rather than a hard-block on save.
 *
 * Schedule: 05:55 UTC — overnight for US tenants, off-peak window,
 * stays out of the way of the other 05:XX timers (17 plugin-snapshot,
 * 41 page-changes, 43 weekly-digest send window).
 *
 * Env vars required:
 *   * LUMEN_API_BASE_URL                — e.g. https://app-lumen-api-prod-cus.azurewebsites.net
 *   * LUMEN_VOICE_INTERNAL_TOKEN        — shared secret with LUMEN-API
 *     (falls back to LUMEN_SOCIAL_DISPATCH_TOKEN / WALKTHROUGH_SEED_INTERNAL_TOKEN)
 */
app.timer("arionPageVoiceScore", {
  schedule: "0 55 5 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[page-voice-score] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const result = await runPageVoiceScoreScan(pool, (m) => context.log(`[page-voice-score] ${m}`));
    context.log(
      `[page-voice-score] done — ${result.sitesChecked} site(s) scanned, ` +
      `${result.sitesWritten} score row(s) written, ${(result.errors || []).length} error(s)`
    );
    if (result.errors?.length) {
      for (const e of result.errors) {
        context.log(`[page-voice-score] error — site ${e.siteId}: ${e.reason}`);
      }
    }
  },
});
