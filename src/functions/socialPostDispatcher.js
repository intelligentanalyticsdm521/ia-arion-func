import { app } from "@azure/functions";
import { runSocialDispatchTick } from "../shared/socialDispatcher.js";

/**
 * My Brand > Social — post dispatcher (Wave 3, 2026-06-22).
 *
 * Polls LUMEN-API every 5 minutes for scheduled posts whose
 * `scheduled_for` is in the past and publishes them to the connected
 * Facebook / Instagram / X / LinkedIn accounts.
 *
 * SCHEDULE — every 5 minutes ("0 *\/5 * * * *"). The 5-minute granularity
 * matches the composer's UI (users pick a slot rounded to the nearest 5
 * minutes); see SCOPE_WORKING.md My-Brand-Social section. This is the
 * ONLY 5-min timer in arion-func today so we don't worry about prime-minute
 * spread (which the convention reserves for daily/hourly timers).
 *
 * Sequencing detail: the GET /due-posts endpoint flips the post's
 * `status='scheduled' → 'publishing'` inside a `UPDATE ... OUTPUT` so a
 * second timer (or accidental double-deploy) can't claim the same row.
 * The dispatcher then PATCHes per-target outcomes and LUMEN-API rolls the
 * post forward to 'published' / 'partial_failure' / 'failed' based on the
 * aggregate of ALL targets.
 *
 * Env knobs:
 *   SOCIAL_DISPATCH_DISABLED=true          → no-op (kill switch).
 *   SOCIAL_DISPATCH_MAX_PER_TICK=N         → cap posts per tick (default 50).
 *   LUMEN_SOCIAL_DISPATCH_TOKEN            → shared secret with LUMEN-API.
 *                                            Falls back to
 *                                            WALKTHROUGH_SEED_INTERNAL_TOKEN
 *                                            if the dedicated one is unset
 *                                            (per Wave 3 brief — one
 *                                            shared secret is fine).
 *   LUMEN_API_BASE_URL                     → e.g. https://app-lumen-api-prod-…
 *                                            .azurewebsites.net
 *   SOCIAL_BLOB_BASE_URL                   → public CDN root for brand-asset
 *                                            blob_ref resolution (e.g.
 *                                            https://stiadmbrand.blob.core
 *                                            .windows.net/ia-brand-assets).
 *
 * Failure isolation: one bad post (publisher throws, KV miss, PATCH 4xx)
 * never poisons the others — every per-post block is wrapped in try/catch
 * inside runSocialDispatchTick and the surrounding handler.
 */
app.timer("socialPostDispatcher", {
  schedule: "0 */5 * * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.SOCIAL_DISPATCH_DISABLED === "true") {
      context.log("[social-dispatcher] disabled via SOCIAL_DISPATCH_DISABLED");
      return;
    }
    context.log("[social-dispatcher] starting", { scheduleStatus: timer.scheduleStatus });
    try {
      const summary = await runSocialDispatchTick((m) => context.log(m));
      context.log("[social-dispatcher] done", summary);
    } catch (err) {
      // Last-resort guard — runSocialDispatchTick already catches per-post
      // errors, but a setup error (no token / no base URL) bubbles. We log
      // and return so the function-app doesn't show a red invocation.
      context.log(`[social-dispatcher] tick error: ${err.message}`);
    }
  },
});
