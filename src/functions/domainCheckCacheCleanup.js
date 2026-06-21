import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";

/**
 * F-LG.15 followup — nightly TTL purge for lumen.domain_check_cache.
 *
 * The domain freshness verifier (F-LG.15 adversarial verify gate) caches
 * per-domain verdicts in lumen.domain_check_cache with a 24h TTL (expires_at
 * = checked_at + 24h, set at insert time by domainFreshness.js). Nothing
 * mutates rows after that — they just sit until the next time the same
 * domain is checked. Across thousands of jobs the table grows unbounded.
 *
 * This timer wipes rows whose expires_at is already in the past. Index
 * IX_dcc_expires (migration 043) makes the predicate a clean range seek.
 *
 * Schedule: "0 23 4 * * *" → 04:23 UTC daily.
 *   Off-peak (overnight US per convention_timer_schedules), prime-minute
 *   :23 sits between existing slots — :15 (pluginSnapshot hour mark),
 *   :17/:29/:43 (market monitor), :13 (monthlyPageSpeed). Clean.
 *
 * Env overrides:
 *   DOMAIN_CACHE_CLEANUP_DISABLED=true  → no-op (kill switch).
 *   DOMAIN_CACHE_CLEANUP_DRY_RUN=1      → COUNT only, no DELETE. Logs the
 *                                         would-delete count.
 *   DOMAIN_CACHE_CLEANUP_HARD_TTL_DAYS  → safety net. If a row somehow
 *                                         escaped the expires_at write
 *                                         (NULL would fail NOT NULL, but
 *                                         belt+suspenders), any row whose
 *                                         checked_at is older than this
 *                                         many days also gets purged.
 *                                         Default 30.
 *
 * Returns / logs summary:
 *   { dryRun, expiredDeleted, hardTtlDeleted, totalDeleted, durationMs }
 */
app.timer("domainCheckCacheCleanup", {
  schedule: "0 23 4 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.DOMAIN_CACHE_CLEANUP_DISABLED === "true") {
      context.log("[domain-cache-cleanup] disabled via DOMAIN_CACHE_CLEANUP_DISABLED");
      return;
    }
    context.log("[domain-cache-cleanup] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const summary = await runDomainCacheCleanup(pool, (m) => context.log(`[domain-cache-cleanup] ${m}`));
    context.log("[domain-cache-cleanup] done", summary);
  },
});

/**
 * Exported for the verifier script + future reuse. Pure function over a
 * connection pool: counts (or deletes) expired rows and returns a summary.
 *
 * @param {import("mssql").ConnectionPool} pool
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{dryRun:boolean, expiredDeleted:number, hardTtlDeleted:number, totalDeleted:number, durationMs:number}>}
 */
export async function runDomainCacheCleanup(pool, log = () => {}) {
  const dryRun = process.env.DOMAIN_CACHE_CLEANUP_DRY_RUN === "1";
  const hardTtlDays = Number(process.env.DOMAIN_CACHE_CLEANUP_HARD_TTL_DAYS || "30");
  const started = Date.now();

  // 1. expires_at-driven purge — the authoritative TTL the verifier set.
  let expiredDeleted = 0;
  {
    const req = pool.request();
    const verb = dryRun
      ? "SELECT COUNT(*) AS n FROM lumen.domain_check_cache WHERE expires_at < SYSUTCDATETIME()"
      : "DELETE FROM lumen.domain_check_cache WHERE expires_at < SYSUTCDATETIME()";
    const result = await req.query(verb);
    expiredDeleted = dryRun ? (result.recordset?.[0]?.n ?? 0) : (result.rowsAffected?.[0] ?? 0);
    log(`${dryRun ? "would-delete" : "deleted"} ${expiredDeleted} rows where expires_at < now`);
  }

  // 2. Hard-TTL belt+suspenders sweep on checked_at. expires_at is NOT NULL
  //    per migration 043, so this should normally hit 0 — but if a future
  //    migration ever drops the constraint, or a bad row sneaks in, we
  //    don't want it living forever.
  let hardTtlDeleted = 0;
  if (Number.isFinite(hardTtlDays) && hardTtlDays > 0) {
    const req = pool.request();
    req.input("days", hardTtlDays);
    const verb = dryRun
      ? "SELECT COUNT(*) AS n FROM lumen.domain_check_cache WHERE checked_at < DATEADD(DAY, -@days, SYSUTCDATETIME())"
      : "DELETE FROM lumen.domain_check_cache WHERE checked_at < DATEADD(DAY, -@days, SYSUTCDATETIME())";
    const result = await req.query(verb);
    hardTtlDeleted = dryRun ? (result.recordset?.[0]?.n ?? 0) : (result.rowsAffected?.[0] ?? 0);
    log(`${dryRun ? "would-delete" : "deleted"} ${hardTtlDeleted} rows where checked_at < ${hardTtlDays}d ago (hard TTL)`);
  }

  const summary = {
    dryRun,
    expiredDeleted,
    hardTtlDeleted,
    totalDeleted: expiredDeleted + hardTtlDeleted,
    durationMs: Date.now() - started,
  };
  return summary;
}
