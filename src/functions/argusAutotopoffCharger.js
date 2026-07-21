import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { getSecret } from "../shared/secrets.js";
import { runArgusAutotopoff } from "../shared/argusAutotopoff.js";

/**
 * ARGUS Auto-Topoff Charger — every 15 minutes.
 *
 * Scans lumen.argus_autotopoff_config for enabled rows whose tenant's
 * credit balance has dropped below threshold_credits. Fires a Stripe
 * Invoice (one-time, charge_automatically, off-session) for the
 * configured pack size, then updates month_spent_usd + last_charge_at.
 * The existing webhook (oliver-api routes/webhooks.js invoice.paid
 * branch) handles the credit grant idempotently via ia_argus_purchase=1
 * metadata on the invoice line.
 *
 * Schedule: every 15 min, off the prime-minute spread (3, 18, 33, 48)
 *   "0 3/15 * * * *" → :03, :18, :33, :48 each hour.
 *
 * Env overrides:
 *   ARGUS_AUTOTOPOFF_DRY_RUN=1  → log "would charge" instead of charging
 *
 * Idempotency: stripe.invoices.create uses
 *   `autotopoff_${tenant_id}_${YYYYMMDDHH}`
 * so a tenant cannot be double-charged within the same UTC hour even if
 * the timer mis-fires or the webhook is slow to grant credits.
 */
/**
 * Global spend kill-switch (migration 146). FAIL-CLOSED: charging requires the
 * PRESENCE of lumen.argus_platform_config key 'spend_enabled' = 'true'.
 * Missing table, missing row, any other value, or a read error all mean SKIP —
 * an absence can never arm the charger (reference_absence_based_guards_fail_open).
 * Flip without a deploy:
 *   UPDATE lumen.argus_platform_config SET [value]='true' WHERE [key]='spend_enabled'
 */
export async function isArgusSpendEnabled(pool) {
  try {
    const r = await pool
      .request()
      .query("SELECT [value] FROM lumen.argus_platform_config WHERE [key] = N'spend_enabled'");
    return String(r.recordset?.[0]?.value || "").toLowerCase() === "true";
  } catch {
    return false; // unreadable switch = OFF
  }
}

app.timer("argusAutotopoffCharger", {
  schedule: "0 3/15 * * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[argus-autotopoff] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    if (!(await isArgusSpendEnabled(pool))) {
      context.log("[argus-autotopoff] SKIPPED — global spend kill-switch is not 'true' (lumen.argus_platform_config)");
      return;
    }
    const summary = await runArgusAutotopoff(pool, {
      log: (msg) => context.log(`[argus-autotopoff] ${msg}`),
      secretLoader: getSecret,
    });
    context.log("[argus-autotopoff] done", summary);
  },
});
