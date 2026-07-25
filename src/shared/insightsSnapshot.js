// insightsSnapshot.js — monthly IA Insights metric aggregation.
//
// Writes arion.metric_monthly (migration 046), the storage foundation the
// whole Insights funnel reads through GET /arion/insights/metrics. One row
// per (site, metric, dimension value, month), MERGE-idempotent so re-runs
// refresh rather than duplicate.
//
// Sources today: SE Ranking own-site position history (kw_tracked / kw_top3 /
// kw_top10 / kw_top30 overall + per-keyword 'kw_position' dimension rows on
// the canonical Google-desktop engine). GSC / GBP / GA4 sources join this
// file as their token plumbing is wired (see SCOPE_WORKING.md backfill scope).
//
// History note (2026-07-25): the initial 12-month backfill for all four prod
// sites was run by arion-api/scripts/_backfill_seranking_prod.mts — this job
// keeps it current from the daily capture in marketMonitor.js.

import sql from "mssql";

/** Google desktop in SE Ranking's engine taxonomy. */
const GOOGLE_DESKTOP_ENGINE_ID = 200;

export async function runInsightsSnapshot(pool, log) {
  const sites = (await pool.request().query(`
    SELECT site_id, tenant_id, domain FROM arion.site
    WHERE se_ranking_project_id IS NOT NULL
  `)).recordset;
  log(`[insights-snapshot] ${sites.length} project site(s)`);

  let rowsUpserted = 0;
  const errors = [];

  for (const site of sites) {
    try {
      // Canonical engine: the site's engine with the most own-site rows.
      // (All current projects track desktop/mobile/maps; desktop dominates.
      // If SE Ranking engine metadata is ever persisted, prefer
      // search_engine_id = GOOGLE_DESKTOP_ENGINE_ID explicitly.)
      const pe = await pool.request()
        .input("sid", sql.UniqueIdentifier, site.site_id)
        .query(`
          SELECT TOP 1 site_engine_id FROM arion.se_ranking_position_history
          WHERE site_id=@sid AND competitor_domain IS NULL
          GROUP BY site_engine_id ORDER BY COUNT(*) DESC`);
      const engineId = pe.recordset[0]?.site_engine_id;
      if (!engineId) { log(`[insights-snapshot] ${site.domain}: no position history yet — skipped`); continue; }

      const res = await pool.request()
        .input("tid", sql.UniqueIdentifier, site.tenant_id)
        .input("sid", sql.UniqueIdentifier, site.site_id)
        .input("eng", sql.NVarChar(40), engineId)
        .query(`
          WITH kwMonth AS (
            SELECT DATEFROMPARTS(YEAR(recorded_for), MONTH(recorded_for), 1) pm,
                   keyword_id, MAX(keyword) kw,
                   AVG(CAST(position AS float)) avg_pos
            FROM arion.se_ranking_position_history
            WHERE site_id=@sid AND site_engine_id=@eng AND competitor_domain IS NULL
              AND recorded_for >= DATEADD(month, -13, GETUTCDATE())
            GROUP BY DATEFROMPARTS(YEAR(recorded_for), MONTH(recorded_for), 1), keyword_id
          ), agg AS (
            SELECT pm, 'kw_tracked' mk, CAST(NULL AS nvarchar(40)) dim, CAST(NULL AS nvarchar(200)) dimv, CAST(COUNT(*) AS decimal(18,4)) v FROM kwMonth GROUP BY pm
            UNION ALL SELECT pm, 'kw_top3',  NULL, NULL, SUM(CASE WHEN avg_pos <= 3  THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
            UNION ALL SELECT pm, 'kw_top10', NULL, NULL, SUM(CASE WHEN avg_pos <= 10 THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
            UNION ALL SELECT pm, 'kw_top30', NULL, NULL, SUM(CASE WHEN avg_pos <= 30 THEN 1 ELSE 0 END) FROM kwMonth GROUP BY pm
            UNION ALL SELECT pm, 'kw_position', 'keyword', LEFT(kw, 200), CAST(avg_pos AS decimal(18,4)) FROM kwMonth WHERE avg_pos IS NOT NULL
          )
          MERGE arion.metric_monthly AS tgt
          USING (SELECT @tid tenant_id, @sid site_id, pm, 'seranking' src, mk, dim, dimv, v FROM agg) AS src
            ON tgt.site_id = src.site_id AND tgt.period_month = src.pm AND tgt.metric_key = src.mk
               AND ISNULL(tgt.dimension,'~') = ISNULL(src.dim,'~') AND ISNULL(tgt.dimension_value,'~') = ISNULL(src.dimv,'~')
          WHEN MATCHED THEN UPDATE SET value = src.v, captured_at = SYSUTCDATETIME()
          WHEN NOT MATCHED THEN INSERT (tenant_id, site_id, period_month, source, metric_key, dimension, dimension_value, value)
            VALUES (src.tenant_id, src.site_id, src.pm, src.src, src.mk, src.dim, src.dimv, src.v);`);
      const n = res.rowsAffected.reduce((a, b) => a + b, 0);
      rowsUpserted += n;
      log(`[insights-snapshot] ${site.domain}: ${n} metric row(s) upserted (engine ${engineId})`);
    } catch (err) {
      errors.push({ site: site.domain, message: err.message });
      log(`[insights-snapshot] ${site.domain} ERROR: ${err.message}`);
    }
  }

  return { sitesProcessed: sites.length, rowsUpserted, errors };
}
