import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { runOnboardingTick } from "../shared/onboardingRunner.js";

/**
 * Onboarding Runner Worker — every 30 seconds.
 *
 * Drives stuck arion.site rows through the post-checkout phase machine the
 * Portal-side OnboardingRunner (Portal/src/lib/onboardingRunner/) polls. Today
 * the runner POSTs `/onboarding/runner/plugin-stack-swap` (etc.) to arion-api,
 * those endpoints write `arion.site.status_phase = 'installing_plugins'` and
 * fire `arion.onboarding.*` platform events — and NOTHING consumes them. The
 * Portal sees `installing_plugins` forever and the UI is stuck on
 * "Installing your tools". This worker is the missing subscriber.
 *
 * Implementation lives in shared/onboardingRunner.js — see that file for the
 * phase machine, idempotency model (gated UPDATEs on current status_phase),
 * and the arion-api /internal/runner/advance/* contract.
 *
 * Schedule notes
 * -----------------------------------------------------------------------------
 * Brandon's task asks for "every 30s" so the Portal Runner (which polls the
 * status endpoint every few seconds) sees forward progress fast. The cron
 * expression below is a 6-field cron in Azure Functions style:
 *   "*\/30 * * * * *"  → fires at :00 and :30 of every minute.
 *
 * The existing arion-func timers fire on minute boundaries (e.g. :07/:37,
 * :17/:29/:43, :03/:18/:33/:48). The 30-second cadence is independent of
 * those slots — the worker is short (one SELECT + a handful of UPDATEs per
 * tick) so it doesn't conflict with the heavier daily timers.
 *
 * Kill switch
 * -----------------------------------------------------------------------------
 *   ONBOARDING_RUNNER_WORKER_DISABLED=true → tick is a no-op
 *
 * Other env knobs (read inside shared/onboardingRunner.js):
 *   ARION_API_BASE                — base URL for the advance HTTP calls
 *   ARION_INGEST_KEY              — x-arion-ingest-key auth on the advance calls
 *   RUNNER_STUCK_HORIZON_MIN      — max age of stuck rows to consider (default 30)
 *   RUNNER_USER_OAUTH_HORIZON_MIN — max age of pending_user_*_oauth rows (default 10080 = 7 days)
 *   RUNNER_MAX_ROWS_PER_TICK      — cap per tick (default 10)
 */
app.timer("onboardingRunnerWorker", {
  schedule: "*/30 * * * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.ONBOARDING_RUNNER_WORKER_DISABLED === "true") {
      context.log("[onboarding-runner] disabled via ONBOARDING_RUNNER_WORKER_DISABLED");
      return;
    }
    const pool = await getServicesPool();
    const summary = await runOnboardingTick(pool, {
      log: (m) => context.log(`[onboarding-runner] ${m}`),
    });
    // Only log when there's something to say — the timer fires twice a
    // minute and a quiet log on every empty tick would drown the App
    // Insights stream.
    if (summary.scanned > 0) {
      context.log(`[onboarding-runner] done — scanned=${summary.scanned} advanced=${summary.advanced || 0} failed=${summary.failed || 0} deferred=${summary.deferred || 0} skipped=${summary.skipped || 0}`);
    }
  },
});
