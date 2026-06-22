import { app } from "@azure/functions";
import sql from "mssql";
import { getServicesPool } from "../shared/servicesPool.js";

/**
 * ARGUS Cross-Platform Intelligence — daily cache sweep.
 *
 * Per Brandon's locked Insights hierarchy (2026-06-20), the 6 cross-platform
 * reports live in argus.cross_channel_cache (oliver-api migration 098 —
 * DB table name preserved for back-compat; concept renamed 2026-06-22).
 * The platform-api routes use lazy refresh — recompute when a user GETs a
 * report whose cache is > 12h old.
 *
 * This timer:
 *   1. Sweeps EXPIRED rows (> 24h old) so the next user request always
 *      recomputes (avoids serving > 24h stale data even if the lazy path
 *      misfires).
 *   2. (Optional) Pre-warms Pro+ tenants: nudges the cache TTL boundary
 *      so the daily refresh happens overnight, not at first morning login.
 *
 * Schedule: 05:43 UTC daily (off-peak prime-minute spread per
 *   convention_timer_schedules.md). Overnight for US users; no DST adj.
 *
 * Pre-warming uses an internal callback URL pattern: we don't import
 * platform-api directly (different repo), so we hit
 *   GET ${PLATFORM_API_URL}/argus/cross-platform-intelligence/{tenantId}/reports?refresh=true
 *   (legacy alias /argus/cross-channel-intelligence/* also accepted by platform-api)
 * for each Pro+ tenant. The function-app's managed identity must be
 * granted access to platform-api (already wired for the autotopoff timer).
 *
 * Env knobs:
 *   ARGUS_CROSS_CHANNEL_REFRESH_DRY_RUN=1   log only, do not nudge cache
 *   PLATFORM_API_URL                        base URL of platform-api
 *
 * Idempotent: deleting a stale row is safe; re-inserting via the next
 * lazy GET is idempotent.
 */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

app.timer("argusCrossChannelRefresh", {
  schedule: "0 43 5 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    const dryRun = process.env.ARGUS_CROSS_CHANNEL_REFRESH_DRY_RUN === "1";
    context.log("[argus-xchannel-refresh] starting", {
      dryRun,
      isPastDue: timer.isPastDue,
    });

    let pool;
    try {
      pool = await getServicesPool();
    } catch (err) {
      context.log("[argus-xchannel-refresh] pool error:", err.message);
      return;
    }

    // 1) Purge rows older than 24h. Lazy refresh will recompute on next GET.
    let purgedCount = 0;
    try {
      if (dryRun) {
        const r = await pool.request().query(`
          SELECT COUNT(*) AS n FROM argus.cross_channel_cache
          WHERE calculated_at < DATEADD(HOUR, -24, SYSUTCDATETIME())
        `);
        purgedCount = r.recordset[0]?.n || 0;
        context.log(`[argus-xchannel-refresh] dry-run: would purge ${purgedCount} stale rows`);
      } else {
        const r = await pool.request().query(`
          DELETE FROM argus.cross_channel_cache
          WHERE calculated_at < DATEADD(HOUR, -24, SYSUTCDATETIME())
        `);
        purgedCount = r.rowsAffected?.[0] || 0;
        context.log(`[argus-xchannel-refresh] purged ${purgedCount} stale rows`);
      }
    } catch (err) {
      // Missing table (pre-098 deploy) — non-fatal.
      context.log("[argus-xchannel-refresh] purge skipped (table likely missing):", err.message);
    }

    // 2) Identify candidate tenants to pre-warm: Pro+ ARGUS tenants.
    //    We pull from core.tenant_subscription where product='argus' and
    //    tier IN ('pro','data_plan','enterprise'). Skip pre-warming for
    //    free/standard — they only see 3 reports anyway.
    let candidates = [];
    try {
      const r = await pool.request().query(`
        SELECT DISTINCT tenant_id
        FROM core.tenant_subscription
        WHERE product = 'argus'
          AND tier IN ('pro','data_plan','enterprise')
          AND status IN ('active','trialing')
      `);
      candidates = (r.recordset || []).map((row) => row.tenant_id);
    } catch (err) {
      context.log("[argus-xchannel-refresh] candidate query skipped (subscription table missing):", err.message);
    }

    context.log(`[argus-xchannel-refresh] ${candidates.length} Pro+ tenants eligible for pre-warm`);

    // 3) Optional HTTP pre-warm. Only run if PLATFORM_API_URL is set.
    const platformApiUrl = (process.env.PLATFORM_API_URL || "").replace(/\/+$/, "");
    const summary = {
      purged: purgedCount,
      candidates: candidates.length,
      pre_warmed: 0,
      pre_warm_errors: 0,
    };

    if (platformApiUrl && !dryRun && candidates.length > 0) {
      // Pre-warm each tenant by calling the refresh endpoint with the
      // tenant-key header. Best effort — never fail the whole sweep on
      // individual tenant errors.
      for (const tenantId of candidates) {
        try {
          const url = `${platformApiUrl}/argus/cross-platform-intelligence/${encodeURIComponent(tenantId)}/reports?refresh=true`;
          const resp = await fetch(url, {
            method: "GET",
            headers: {
              "x-tenant-key": tenantId,
              "x-internal-refresh": "argus-cross-platform-timer",
            },
          });
          if (resp.ok) summary.pre_warmed++;
          else summary.pre_warm_errors++;
        } catch {
          summary.pre_warm_errors++;
        }
      }
    } else if (!platformApiUrl) {
      context.log("[argus-xchannel-refresh] PLATFORM_API_URL not set; skipping pre-warm");
    }

    context.log("[argus-xchannel-refresh] done", summary);
  },
});
