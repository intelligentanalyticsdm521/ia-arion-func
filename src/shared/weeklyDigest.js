// shared/weeklyDigest.js — F-LG.6.4 Lead Gen weekly digest builder (ESM mirror).
//
// The canonical implementation lives in
//   LUMEN-API/src/services/leadgen/weeklyDigest.js (CJS)
// and that's where any future read-side surface (admin preview endpoint,
// in-product test-send) should call. This file mirrors the same SQL so the
// arion-func ESM timer can run without dragging in the LUMEN-API CJS module.
// Keep both in sync; the verify script (LUMEN-API) is the source-of-truth for
// regression — if a SQL shape changes here, update there and re-run.
//
// IMPORTANT — all SQL is parameterized.

import mssqlDefault from "mssql";

const TOP_RUNS = 25;

/**
 * Build the prior-week digest for a single tenant.
 *
 * @param pool      — mssql ConnectionPool (already connected)
 * @param tenantId  — tenant id (nvarchar)
 * @param weekStart — UTC Monday 00:00 marking start of window
 * @param mssql     — optional mssql instance (defaults to the package import)
 */
export async function buildWeeklyDigestForTenant(pool, tenantId, weekStart, mssql = mssqlDefault) {
  if (!tenantId) return null;
  if (!(weekStart instanceof Date) || isNaN(weekStart.getTime())) {
    throw new Error("weekStart must be a valid Date");
  }
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const dispR = await pool.request()
    .input("tid", mssql.NVarChar, tenantId)
    .input("from", mssql.DateTimeOffset, weekStart)
    .input("to", mssql.DateTimeOffset, weekEnd)
    .query(`
      SELECT
        SUM(CASE WHEN status IN ('queued','error') THEN 1 ELSE 0 END) AS runs_count,
        SUM(CASE WHEN status = 'skipped_no_credits' THEN 1 ELSE 0 END) AS runs_skipped_count
        FROM lumen.leadgen_schedule_dispatch
       WHERE tenant_id = @tid
         AND fired_at >= @from
         AND fired_at <  @to`);
  const runs_count = dispR.recordset[0]?.runs_count || 0;
  const runs_skipped_count = dispR.recordset[0]?.runs_skipped_count || 0;

  const runsR = await pool.request()
    .input("tid", mssql.NVarChar, tenantId)
    .input("from", mssql.DateTimeOffset, weekStart)
    .input("to", mssql.DateTimeOffset, weekEnd)
    .input("top", mssql.Int, TOP_RUNS)
    .query(`
      SELECT TOP (@top)
             d.profile_id,
             p.profile_name,
             d.fired_at AS ran_at,
             COALESCE(j.leads_found, 0) AS leads_found,
             d.status
        FROM lumen.leadgen_schedule_dispatch d
        LEFT JOIN lumen.search_profile p ON p.id = d.profile_id
        LEFT JOIN lumen.search_job     j ON j.id = d.search_job_id
       WHERE d.tenant_id = @tid
         AND d.fired_at >= @from
         AND d.fired_at <  @to
       ORDER BY d.fired_at DESC`);

  const totalsR = await pool.request()
    .input("tid", mssql.NVarChar, tenantId)
    .input("from", mssql.DateTimeOffset, weekStart)
    .input("to", mssql.DateTimeOffset, weekEnd)
    .query(`
      WITH window_jobs AS (
        SELECT j.id AS job_id, j.profile_id, j.leads_found
          FROM lumen.leadgen_schedule_dispatch d
          JOIN lumen.search_job j ON j.id = d.search_job_id
         WHERE d.tenant_id = @tid
           AND d.fired_at >= @from
           AND d.fired_at <  @to
      )
      SELECT
        (SELECT COALESCE(SUM(leads_found), 0) FROM window_jobs) AS leads_total,
        (SELECT TOP 1 p.profile_name
           FROM window_jobs w
           JOIN lumen.search_profile p ON p.id = w.profile_id
          GROUP BY p.profile_name
          ORDER BY SUM(w.leads_found) DESC, p.profile_name ASC) AS top_search_profile_name`);
  const leads_total = totalsR.recordset[0]?.leads_total || 0;
  const top_search_profile_name = totalsR.recordset[0]?.top_search_profile_name || null;

  const ledR = await pool.request()
    .input("tid", mssql.NVarChar, tenantId)
    .input("from", mssql.DateTimeOffset, weekStart)
    .input("to", mssql.DateTimeOffset, weekEnd)
    .query(`
      SELECT
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS leads_promoted,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS leads_suppressed
        FROM lumen.lead
       WHERE tenant_id = @tid
         AND created_at >= @from
         AND created_at <  @to
         AND search_profile_id IN (
           SELECT DISTINCT profile_id
             FROM lumen.leadgen_schedule_dispatch
            WHERE tenant_id = @tid
              AND fired_at >= @from
              AND fired_at <  @to
              AND search_job_id IS NOT NULL)`);
  const leads_promoted = ledR.recordset[0]?.leads_promoted || 0;
  const leads_suppressed = ledR.recordset[0]?.leads_suppressed || 0;

  return {
    window: { from: weekStart.toISOString(), to: weekEnd.toISOString() },
    runs_count,
    runs_skipped_count,
    leads_total,
    leads_promoted,
    leads_suppressed,
    top_search_profile_name,
    runs: runsR.recordset.map((r) => ({
      profile_id: r.profile_id,
      profile_name: r.profile_name || `(profile ${r.profile_id})`,
      ran_at: r.ran_at instanceof Date ? r.ran_at.toISOString() : r.ran_at,
      leads_found: r.leads_found || 0,
      status: r.status,
    })),
  };
}

/**
 * Tenants that fired at least one scheduled dispatch in the window AND have
 * at least one is_scheduled=1 profile (i.e. they're "in the program" still —
 * if they've turned schedules off we don't keep emailing them).
 */
export async function listDigestEligibleTenants(pool, weekStart, mssql = mssqlDefault) {
  if (!(weekStart instanceof Date) || isNaN(weekStart.getTime())) {
    throw new Error("weekStart must be a valid Date");
  }
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const r = await pool.request()
    .input("from", mssql.DateTimeOffset, weekStart)
    .input("to", mssql.DateTimeOffset, weekEnd)
    .query(`
      SELECT d.tenant_id, COUNT(*) AS dispatch_count
        FROM lumen.leadgen_schedule_dispatch d
       WHERE d.fired_at >= @from
         AND d.fired_at <  @to
         AND EXISTS (
           SELECT 1 FROM lumen.search_profile p
            WHERE p.tenant_id = d.tenant_id AND p.is_scheduled = 1)
       GROUP BY d.tenant_id`);
  return r.recordset.map((row) => ({
    tenant_id: row.tenant_id,
    dispatch_count: row.dispatch_count,
  }));
}

/**
 * UTC Monday 00:00 at the start of the PRIOR week relative to `now`.
 * Mirrors the LUMEN-API helper of the same name — keep in sync.
 */
export function priorWeekStartUtc(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = d.getUTCDay();
  const offsetToMonday = (dayOfWeek + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offsetToMonday);
  d.setUTCDate(d.getUTCDate() - 7);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
