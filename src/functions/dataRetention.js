// dataRetention — nightly rollup + prune of arion.site_page_view, lumen.email_event, platform.lead_cache.
// G5-S5 (RETENTION-001/002/003). DRY_RUN=1 default — flip to '0' per sub-task only after 2 clean dry-run nights.
// Schedule: 0 37 5 * * * (5:37 UTC, per convention_timer_schedules).

import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { getPlatformPool } from "../shared/platformPool.js";

/**
 * Retention windows in days. Tuned to 90 across all three sub-tasks per G5-S5.
 */
const RETENTION_DAYS = 90;

app.timer("dataRetention", {
  schedule: "0 37 5 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.DATA_RETENTION_DISABLED === "true") {
      context.log("[data-retention] disabled via DATA_RETENTION_DISABLED");
      return;
    }
    context.log("[data-retention] starting", { scheduleStatus: timer.scheduleStatus });

    // Global default DRY_RUN=1. Per-sub-task overrides let us promote one
    // sub-task at a time after 2 clean dry-run nights.
    const globalDry = (process.env.DRY_RUN ?? "1") !== "0";

    // Sub-task 1 — arion.site_page_view rollup + prune.
    try {
      const dryRun = readSubtaskDryRun("DATA_RETENTION_PAGEVIEW_DRY_RUN", globalDry);
      const summary = await rollupSitePageView(dryRun, (m) => context.log(`[data-retention][pageview] ${m}`));
      context.log("[data-retention][pageview] done", summary);
    } catch (err) {
      context.log.error(`[data-retention][pageview] FAILED: ${err.message}`);
    }

    // Sub-task 2 — lumen.email_event retention.
    try {
      const dryRun = readSubtaskDryRun("DATA_RETENTION_EMAILEVENT_DRY_RUN", globalDry);
      const summary = await pruneEmailEvents(dryRun, (m) => context.log(`[data-retention][emailevent] ${m}`));
      context.log("[data-retention][emailevent] done", summary);
    } catch (err) {
      context.log.error(`[data-retention][emailevent] FAILED: ${err.message}`);
    }

    // Sub-task 3 — platform.lead_cache prune.
    try {
      const dryRun = readSubtaskDryRun("DATA_RETENTION_LEADCACHE_DRY_RUN", globalDry);
      const summary = await pruneLeadCache(dryRun, (m) => context.log(`[data-retention][leadcache] ${m}`));
      context.log("[data-retention][leadcache] done", summary);
    } catch (err) {
      context.log.error(`[data-retention][leadcache] FAILED: ${err.message}`);
    }

    context.log("[data-retention] complete");
  },
});

function readSubtaskDryRun(envVar, fallback) {
  const v = process.env[envVar];
  if (v === undefined || v === "") return fallback;
  return v !== "0";
}

/**
 * Sub-task 1 (RETENTION-001) — roll arion.site_page_view rows older than 90d
 * into arion.site_page_view_daily aggregate, then delete source rows.
 *
 * NOTE (schema surprise): migration 004 defines arion.site_page_view with
 * columns (view_id, site_id, page_url, referrer, scroll_depth, time_on_page,
 * screen_width, created_at). The G5-S5 spec references (tenant_id, page_path,
 * occurred_at, view_count) — those columns don't exist. We adapt:
 *   - group by (site_id, page_url, DATE(created_at))
 *   - view_count is derived from COUNT(*) (one row per view)
 *   - tenant_id is NOT stored on this table; resolve via join if needed
 *     later. TODO(G5-S5): confirm whether site_page_view_daily should include
 *     tenant_id (would need JOIN core.sites) or stick to site_id only.
 * TODO(G5-S5): create arion.site_page_view_daily table in a migration before
 * flipping DATA_RETENTION_PAGEVIEW_DRY_RUN=0. Suggested shape:
 *   (site_id UNIQUEIDENTIFIER, page_url NVARCHAR(1000), day DATE,
 *    view_count INT, PK(site_id, page_url, day)).
 */
export async function rollupSitePageView(dryRun, log = () => {}) {
  const started = Date.now();
  const pool = await getServicesPool();

  const cutoffPredicate =
    "created_at < DATEADD(DAY, -" + RETENTION_DAYS + ", SYSUTCDATETIME())";

  if (dryRun) {
    const r = await pool
      .request()
      .query(`SELECT COUNT(*) AS n FROM arion.site_page_view WHERE ${cutoffPredicate}`);
    const n = r.recordset?.[0]?.n ?? 0;
    log(`would-rollup+delete ${n} rows older than ${RETENTION_DAYS}d`);
    return { dryRun, rolledUp: 0, deleted: 0, wouldAffect: n, durationMs: Date.now() - started };
  }

  // Real path — do the INSERT...SELECT then DELETE inside a transaction so
  // we can't lose rows if the DELETE fails mid-flight.
  const tx = pool.transaction();
  await tx.begin();
  let rolledUp = 0;
  let deleted = 0;
  try {
    const ins = await tx.request().query(`
      INSERT INTO arion.site_page_view_daily (site_id, page_url, day, view_count)
      SELECT site_id, page_url, CAST(created_at AS DATE) AS day, COUNT(*) AS view_count
      FROM arion.site_page_view
      WHERE ${cutoffPredicate}
      GROUP BY site_id, page_url, CAST(created_at AS DATE)
    `);
    rolledUp = ins.rowsAffected?.[0] ?? 0;

    const del = await tx.request().query(
      `DELETE FROM arion.site_page_view WHERE ${cutoffPredicate}`
    );
    deleted = del.rowsAffected?.[0] ?? 0;

    await tx.commit();
    log(`rolled up ${rolledUp} daily rows, deleted ${deleted} source rows`);
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }

  return { dryRun, rolledUp, deleted, durationMs: Date.now() - started };
}

/**
 * Sub-task 2 (RETENTION-002) — prune lumen.email_event rows older than 90d,
 * keeping compliance-relevant events forever.
 *
 * NOTE (spec vs schema): G5-S5 spec says keep ('bounce','complaint',
 * 'delivered_failed'). Actual event_type values (per migration 008) are
 * 'sent','delivered','opened','clicked','bounced','complained',
 * 'unsubscribed','failed'. Mapping used here:
 *   bounce           → bounced
 *   complaint        → complained
 *   delivered_failed → failed
 *   plus unsubscribed (also compliance-relevant — CAN-SPAM proof).
 * TODO(G5-S5): confirm with Brandon that keeping 'unsubscribed' forever
 * matches intent before flipping DRY_RUN=0.
 *
 * lumen.* lives in iadm_services (same server, same DB as arion), so we
 * reuse getServicesPool — no cross-DB connection needed.
 */
export async function pruneEmailEvents(dryRun, log = () => {}) {
  const started = Date.now();
  const pool = await getServicesPool();

  const keepClause =
    "event_type NOT IN ('bounced','complained','failed','unsubscribed')";
  const cutoffClause =
    "occurred_at < DATEADD(DAY, -" + RETENTION_DAYS + ", SYSUTCDATETIME())";
  const wherePredicate = `${cutoffClause} AND ${keepClause}`;

  if (dryRun) {
    const r = await pool
      .request()
      .query(`SELECT COUNT(*) AS n FROM lumen.email_event WHERE ${wherePredicate}`);
    const n = r.recordset?.[0]?.n ?? 0;
    log(`would-delete ${n} rows older than ${RETENTION_DAYS}d (excluding compliance-retained event_types)`);
    return { dryRun, deleted: 0, wouldAffect: n, durationMs: Date.now() - started };
  }

  const del = await pool
    .request()
    .query(`DELETE FROM lumen.email_event WHERE ${wherePredicate}`);
  const deleted = del.rowsAffected?.[0] ?? 0;
  log(`deleted ${deleted} rows older than ${RETENTION_DAYS}d`);
  return { dryRun, deleted, durationMs: Date.now() - started };
}

/**
 * Sub-task 3 (RETENTION-003) — prune platform.lead_cache rows older than 90d
 * where status='discarded'.
 *
 * NOTE (schema surprise): platform.lead_cache (migration 003_lumen_business_
 * leadgen.sql) has no `status` column — it tracks freshness via `is_expired`
 * BIT + `expires_at` DATETIME2. There's no explicit 'discarded' concept in
 * the current schema. Best-effort mapping: prune rows where is_expired=1
 * AND enriched_at older than 90d.
 * TODO(G5-S5): confirm mapping with Brandon before flipping
 * DATA_RETENTION_LEADCACHE_DRY_RUN=0. If a `status` column is added later,
 * update this predicate to WHERE status='discarded'.
 */
export async function pruneLeadCache(dryRun, log = () => {}) {
  const started = Date.now();
  const pool = await getPlatformPool();

  const wherePredicate =
    "enriched_at < DATEADD(DAY, -" + RETENTION_DAYS + ", SYSUTCDATETIME()) " +
    "AND is_expired = 1";

  if (dryRun) {
    const r = await pool
      .request()
      .query(`SELECT COUNT(*) AS n FROM platform.lead_cache WHERE ${wherePredicate}`);
    const n = r.recordset?.[0]?.n ?? 0;
    log(`would-delete ${n} discarded/expired rows older than ${RETENTION_DAYS}d`);
    return { dryRun, deleted: 0, wouldAffect: n, durationMs: Date.now() - started };
  }

  const del = await pool
    .request()
    .query(`DELETE FROM platform.lead_cache WHERE ${wherePredicate}`);
  const deleted = del.rowsAffected?.[0] ?? 0;
  log(`deleted ${deleted} rows`);
  return { dryRun, deleted, durationMs: Date.now() - started };
}
