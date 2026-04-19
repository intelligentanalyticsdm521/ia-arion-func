/**
 * Market Monitor job logic — three independent sync jobs:
 *
 *   1. runMovesCapture(pool, log)       → daily. Snapshots current positions
 *      for your own site AND every tracked competitor into
 *      arion.se_ranking_position_history. The API later diffs rows to produce
 *      the Competitor Moves feed.
 *
 *   2. runBacklinkSnapshot(pool, log)   → weekly. Calls SE Ranking Data API
 *      /backlinks/overview and /backlinks/new-lost for each site. Inserts
 *      new/lost rows into arion.se_ranking_backlink_snapshot.
 *
 *   3. runPageChangeSweep(pool, log)    → daily. Walks arion.site_page_watch,
 *      fetches each URL, hashes the main content, compares to last hash,
 *      and logs diffs into arion.site_page_change.
 *
 * Each job:
 *   - Only touches sites where seo_addon_tier = 'authority' (Market Monitor
 *     is Authority-gated).
 *   - Writes a market_monitor_job_log row before + after so the API can
 *     show "last successful run".
 *   - Returns { sitesProcessed, rowsWritten, errors[] }.
 */
import sql from "mssql";
import crypto from "node:crypto";
import { projectApi, dataApi } from "./seranking.js";

const AUTHORITY_TIER = "authority";

// ──────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────
async function listAuthoritySites(pool) {
  const r = await pool.request().query(`
    SELECT site_id, tenant_id, domain, se_ranking_project_id, seo_addon_tier
    FROM arion.site
    WHERE se_ranking_project_id IS NOT NULL
      AND LOWER(seo_addon_tier) = '${AUTHORITY_TIER}'
  `);
  return r.recordset;
}

async function logJobStart(pool, tenantId, siteId, jobName) {
  const r = await pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("jobName", sql.NVarChar(60), jobName)
    .input("startedAt", sql.DateTimeOffset, new Date())
    .query(`
      INSERT INTO arion.market_monitor_job_log
        (tenant_id, site_id, job_name, status, started_at)
      OUTPUT INSERTED.log_id
      VALUES (@tenantId, @siteId, @jobName, 'running', @startedAt)
    `);
  return r.recordset[0]?.log_id ?? null;
}

async function logJobComplete(pool, logId, status, rowsProcessed, errorMessage) {
  if (!logId) return;
  await pool.request()
    .input("logId", sql.BigInt, logId)
    .input("status", sql.NVarChar(20), status)
    .input("rowsProcessed", sql.Int, rowsProcessed ?? null)
    .input("errorMessage", sql.NVarChar(2000), errorMessage ?? null)
    .input("completedAt", sql.DateTimeOffset, new Date())
    .query(`
      UPDATE arion.market_monitor_job_log
      SET status = @status,
          rows_processed = @rowsProcessed,
          error_message = @errorMessage,
          completed_at = @completedAt
      WHERE log_id = @logId
    `);
}

// ══════════════════════════════════════════════════════════════
// JOB 1: Competitor Moves — daily position capture
// ══════════════════════════════════════════════════════════════
export async function runMovesCapture(pool, log) {
  const sites = await listAuthoritySites(pool);
  log(`[moves] processing ${sites.length} Authority-tier site(s)`);
  let totalRows = 0;
  const errors = [];

  for (const site of sites) {
    const logId = await logJobStart(pool, site.tenant_id, site.site_id, "moves");
    let siteRows = 0;
    try {
      const projectId = site.se_ranking_project_id;

      // Own-site current positions — /positions returns today's reading by default
      const positionsRaw = await projectApi("GET", `/sites/${encodeURIComponent(projectId)}/positions`);
      const engineBlocks = Array.isArray(positionsRaw.data) ? positionsRaw.data : [];

      const today = new Date().toISOString().split("T")[0];

      for (const block of engineBlocks) {
        const engineId = String(block.site_engine_id || "");
        const keywords = Array.isArray(block.keywords) ? block.keywords : [];

        for (const kw of keywords) {
          const keywordId = String(kw.id || "");
          const keywordText = String(kw.name || "").slice(0, 499);
          const positions = Array.isArray(kw.positions) ? kw.positions : [];
          const mostRecent = positions[positions.length - 1] || {};
          const pos = Number(mostRecent.pos) || null;

          await pool.request()
            .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
            .input("siteId", sql.UniqueIdentifier, site.site_id)
            .input("projectId", sql.NVarChar(50), projectId)
            .input("engineId", sql.NVarChar(50), engineId)
            .input("keywordId", sql.NVarChar(50), keywordId)
            .input("keyword", sql.NVarChar(500), keywordText)
            .input("pos", sql.Int, pos)
            .input("recordedFor", sql.Date, today)
            .query(`
              MERGE arion.se_ranking_position_history WITH (HOLDLOCK) AS tgt
              USING (SELECT @siteId AS site_id, @engineId AS site_engine_id, @keywordId AS keyword_id, @recordedFor AS recorded_for) AS src
                ON  tgt.site_id = src.site_id
                AND tgt.site_engine_id = src.site_engine_id
                AND tgt.keyword_id = src.keyword_id
                AND tgt.recorded_for = src.recorded_for
                AND tgt.competitor_domain IS NULL
              WHEN MATCHED THEN UPDATE SET position = @pos, recorded_at = SYSDATETIMEOFFSET()
              WHEN NOT MATCHED THEN
                INSERT (tenant_id, site_id, se_project_id, site_engine_id, keyword_id, keyword, competitor_domain, position, recorded_for)
                VALUES (@tenantId, @siteId, @projectId, @engineId, @keywordId, @keyword, NULL, @pos, @recordedFor);
            `);
          siteRows++;
        }
      }

      // Competitor positions via SE Ranking Project API.
      // NOTE (2026-04-19): /sites/{projectId}/competitors returns HTTP 400 on
      // all tried parameter combinations. Multiple candidate paths tried —
      // all 400. Likely causes: SE Ranking API regression, missing competitor
      // configuration in the project, or plan-tier gating. Until resolved,
      // log the failure per site and skip competitor capture so the Moves
      // job still completes successfully for own-site data.
      //
      // Re-enable competitor capture once we confirm a working endpoint —
      // check with SE Ranking support or probe via /arion/seo/diagnostic.
      const engineIds = Array.from(new Set(engineBlocks.map((b) => String(b.site_engine_id || "")).filter(Boolean)));
      let competitorCaptureAttempted = false;
      let competitorCaptureSucceeded = false;
      for (const engineId of engineIds) {
        const compPosRaw = await projectApi("GET", `/sites/${encodeURIComponent(projectId)}/competitors/positions?se_id=${encodeURIComponent(engineId)}`);
        competitorCaptureAttempted = true;
        if (!compPosRaw.ok) continue;
        const compKeywords = Array.isArray(compPosRaw.data) ? compPosRaw.data : [];
        if (compKeywords.length === 0) continue;
        competitorCaptureSucceeded = true;

        for (const cp of compKeywords) {
          const keywordId = String(cp.keyword_id || cp.id || "");
          const keywordText = String(cp.keyword || cp.name || "").slice(0, 499);
          const competitors = Array.isArray(cp.competitors) ? cp.competitors : [];

          for (const c of competitors) {
            const domain = String(c.url || c.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 299);
            if (!domain) continue;
            const positions = Array.isArray(c.positions) ? c.positions : [];
            const mostRecent = positions[positions.length - 1] || {};
            const pos = Number(mostRecent.pos || c.position || 0) || null;

            await pool.request()
              .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
              .input("siteId", sql.UniqueIdentifier, site.site_id)
              .input("projectId", sql.NVarChar(50), projectId)
              .input("engineId", sql.NVarChar(50), engineId)
              .input("keywordId", sql.NVarChar(50), keywordId)
              .input("keyword", sql.NVarChar(500), keywordText)
              .input("compDomain", sql.NVarChar(300), domain)
              .input("pos", sql.Int, pos)
              .input("recordedFor", sql.Date, today)
              .query(`
                MERGE arion.se_ranking_position_history WITH (HOLDLOCK) AS tgt
                USING (SELECT @siteId AS site_id, @engineId AS site_engine_id, @keywordId AS keyword_id, @compDomain AS competitor_domain, @recordedFor AS recorded_for) AS src
                  ON  tgt.site_id = src.site_id
                  AND tgt.site_engine_id = src.site_engine_id
                  AND tgt.keyword_id = src.keyword_id
                  AND tgt.competitor_domain = src.competitor_domain
                  AND tgt.recorded_for = src.recorded_for
                WHEN MATCHED THEN UPDATE SET position = @pos, recorded_at = SYSDATETIMEOFFSET()
                WHEN NOT MATCHED THEN
                  INSERT (tenant_id, site_id, se_project_id, site_engine_id, keyword_id, keyword, competitor_domain, position, recorded_for)
                  VALUES (@tenantId, @siteId, @projectId, @engineId, @keywordId, @keyword, @compDomain, @pos, @recordedFor);
              `);
            siteRows++;
          }
        }
      }

      if (competitorCaptureAttempted && !competitorCaptureSucceeded) {
        log(`[moves] ${site.domain}: competitor capture returned no data — SE Ranking /competitors endpoint may be unavailable or no competitors configured. Own-site positions captured successfully.`);
      }

      totalRows += siteRows;
      await logJobComplete(pool, logId, "success", siteRows, null);
      log(`[moves] ${site.domain}: ${siteRows} row(s) written`);
    } catch (err) {
      errors.push({ site: site.domain, message: err.message });
      await logJobComplete(pool, logId, "error", siteRows, err.message.slice(0, 1999));
      log(`[moves] ${site.domain} ERROR: ${err.message}`);
    }
  }

  return { sitesProcessed: sites.length, rowsWritten: totalRows, errors };
}

// ══════════════════════════════════════════════════════════════
// JOB 2: Backlink Watch — weekly snapshot
// ══════════════════════════════════════════════════════════════
export async function runBacklinkSnapshot(pool, log) {
  const sites = await listAuthoritySites(pool);
  log(`[backlinks] processing ${sites.length} Authority-tier site(s)`);
  let totalRows = 0;
  const errors = [];

  for (const site of sites) {
    const logId = await logJobStart(pool, site.tenant_id, site.site_id, "backlinks");
    let siteRows = 0;
    try {
      const domain = (site.domain || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
      if (!domain) throw new Error("site.domain empty");

      // SE Ranking Data API backlinks — working endpoints confirmed 2026-04-19:
      //   /backlinks/refdomains?target=X&mode=domain   → list of referring domains
      //   /backlinks/summary?target=X                  → aggregate totals
      //
      // We diff referring-domain sets across snapshots to label new/lost.
      const refDomainsRaw = await dataApi("GET", `/backlinks/refdomains?target=${encodeURIComponent(domain)}&mode=domain`);
      if (!refDomainsRaw.ok) {
        throw new Error(`Data API /backlinks/refdomains failed: HTTP ${refDomainsRaw.status} ${refDomainsRaw.errorText || ""}`);
      }

      const refdomains = Array.isArray(refDomainsRaw.data?.refdomains)
        ? refDomainsRaw.data.refdomains
        : Array.isArray(refDomainsRaw.data)
          ? refDomainsRaw.data
          : [];

      const snapshotDate = new Date().toISOString().split("T")[0];

      // Pull last known active referring domains to diff against
      const lastActive = await pool.request()
        .input("siteId", sql.UniqueIdentifier, site.site_id)
        .query(`
          SELECT DISTINCT referring_domain
          FROM arion.se_ranking_backlink_snapshot
          WHERE site_id = @siteId AND link_status = 'active'
            AND snapshot_date >= DATEADD(DAY, -14, CAST(GETUTCDATE() AS DATE))
        `);
      const previousDomains = new Set(lastActive.recordset.map((r) => r.referring_domain));
      const currentDomains = new Set();

      for (const rd of refdomains) {
        const refDomain = String(rd.refdomain || rd.referring_domain || "").toLowerCase().slice(0, 299);
        if (!refDomain) continue;
        currentDomains.add(refDomain);
        const isNew = !previousDomains.has(refDomain);
        const da = Number(rd.domain_inlink_rank || rd.domain_trust || rd.domain_authority || rd.da || 0) || null;
        const firstSeen = rd.first_seen ? new Date(rd.first_seen).toISOString().split("T")[0] : null;
        const lastSeen = rd.last_seen ? new Date(rd.last_seen).toISOString().split("T")[0] : snapshotDate;

        await pool.request()
          .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
          .input("siteId", sql.UniqueIdentifier, site.site_id)
          .input("refDomain", sql.NVarChar(300), refDomain)
          .input("da", sql.Int, da)
          .input("status", sql.NVarChar(20), isNew ? "new" : "active")
          .input("firstSeen", sql.Date, firstSeen)
          .input("lastSeen", sql.Date, lastSeen)
          .input("snapshotDate", sql.Date, snapshotDate)
          .query(`
            INSERT INTO arion.se_ranking_backlink_snapshot
              (tenant_id, site_id, referring_domain, domain_authority, link_status, first_seen, last_seen, snapshot_date)
            VALUES (@tenantId, @siteId, @refDomain, @da, @status, @firstSeen, @lastSeen, @snapshotDate)
          `);
        siteRows++;
      }

      // Lost backlinks — present last period, absent now
      for (const lostDomain of previousDomains) {
        if (currentDomains.has(lostDomain)) continue;
        await pool.request()
          .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
          .input("siteId", sql.UniqueIdentifier, site.site_id)
          .input("refDomain", sql.NVarChar(300), lostDomain)
          .input("status", sql.NVarChar(20), "lost")
          .input("snapshotDate", sql.Date, snapshotDate)
          .query(`
            INSERT INTO arion.se_ranking_backlink_snapshot
              (tenant_id, site_id, referring_domain, link_status, snapshot_date)
            VALUES (@tenantId, @siteId, @refDomain, @status, @snapshotDate)
          `);
        siteRows++;
      }

      // Also fetch the summary for the totals record (once per run — optional)
      try {
        const sumRaw = await dataApi("GET", `/backlinks/summary?target=${encodeURIComponent(domain)}`);
        if (sumRaw.ok) {
          const s = Array.isArray(sumRaw.data?.summary) ? sumRaw.data.summary[0] : null;
          if (s) log(`[backlinks] ${site.domain}: summary — ${s.backlinks || 0} total backlinks, ${s.refdomains || 0} refdomains`);
        }
      } catch (e) {
        // summary is informational only — don't fail the job on this
      }

      totalRows += siteRows;
      await logJobComplete(pool, logId, "success", siteRows, null);
      log(`[backlinks] ${site.domain}: ${siteRows} row(s) written`);
    } catch (err) {
      errors.push({ site: site.domain, message: err.message });
      await logJobComplete(pool, logId, "error", siteRows, err.message.slice(0, 1999));
      log(`[backlinks] ${site.domain} ERROR: ${err.message}`);
    }
  }

  return { sitesProcessed: sites.length, rowsWritten: totalRows, errors };
}

// ══════════════════════════════════════════════════════════════
// JOB 3: Page Changes — daily content hash sweep
// ══════════════════════════════════════════════════════════════
function stripToMainContent(html) {
  if (typeof html !== "string") return "";
  // Remove scripts, styles, comments — then collapse tags and whitespace.
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  if (typeof html !== "string") return null;
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim().slice(0, 499) : null;
}

async function fetchPage(url) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": "IADM-ARION-PageWatcher/1.0 (+https://intelligentanalyticsdm.com)" },
      signal: controller.signal,
      redirect: "follow",
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html };
  } finally {
    clearTimeout(to);
  }
}

export async function runPageChangeSweep(pool, log) {
  const sites = await listAuthoritySites(pool);
  log(`[pagechanges] processing ${sites.length} Authority-tier site(s)`);
  let totalRows = 0;
  const errors = [];

  for (const site of sites) {
    const logId = await logJobStart(pool, site.tenant_id, site.site_id, "page_changes");
    let siteRows = 0;
    try {
      // Load the watchlist for this site
      const watchRes = await pool.request()
        .input("siteId", sql.UniqueIdentifier, site.site_id)
        .query(`
          SELECT watch_id, page_url, page_type, competitor_domain, last_content_hash, last_title
          FROM arion.site_page_watch
          WHERE site_id = @siteId AND enabled = 1
        `);
      const watchlist = watchRes.recordset;
      log(`[pagechanges] ${site.domain}: ${watchlist.length} watched page(s)`);

      for (const w of watchlist) {
        try {
          const fetched = await fetchPage(w.page_url);
          if (!fetched.ok) {
            log(`[pagechanges] fetch failed ${w.page_url}: HTTP ${fetched.status}`);
            continue;
          }
          const main = stripToMainContent(fetched.html);
          const hash = crypto.createHash("sha256").update(main).digest("hex");
          const title = extractTitle(fetched.html);
          const excerpt = main.slice(0, 999);

          if (w.last_content_hash && hash !== w.last_content_hash) {
            // Detected change — compute rough magnitude via Levenshtein-free
            // word-set Jaccard distance (cheap, robust enough for a % signal).
            const prevWords = new Set((w.last_excerpt || "").split(/\s+/).filter(Boolean));
            const newWords = new Set(main.split(/\s+/).filter(Boolean));
            const intersection = new Set([...prevWords].filter((x) => newWords.has(x)));
            const union = new Set([...prevWords, ...newWords]);
            const magnitude = union.size > 0 ? Math.max(0, Math.min(1, 1 - intersection.size / union.size)) : 1;

            await pool.request()
              .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
              .input("siteId", sql.UniqueIdentifier, site.site_id)
              .input("pageUrl", sql.NVarChar(1000), w.page_url)
              .input("pageType", sql.NVarChar(40), w.page_type)
              .input("competitorDomain", sql.NVarChar(300), w.competitor_domain || null)
              .input("hashPrev", sql.NVarChar(64), w.last_content_hash)
              .input("hashNew", sql.NVarChar(64), hash)
              .input("magnitude", sql.Decimal(5, 2), Number(magnitude.toFixed(2)))
              .input("excerptPrev", sql.NVarChar(1000), w.last_excerpt || null)
              .input("excerptNew", sql.NVarChar(1000), excerpt)
              .input("titlePrev", sql.NVarChar(500), w.last_title || null)
              .input("titleNew", sql.NVarChar(500), title)
              .query(`
                INSERT INTO arion.site_page_change
                  (tenant_id, site_id, page_url, page_type, competitor_domain,
                   content_hash_prev, content_hash_new, change_magnitude,
                   excerpt_prev, excerpt_new, title_prev, title_new)
                VALUES (@tenantId, @siteId, @pageUrl, @pageType, @competitorDomain,
                        @hashPrev, @hashNew, @magnitude,
                        @excerptPrev, @excerptNew, @titlePrev, @titleNew)
              `);
            siteRows++;
          }

          // Update the watchlist row with the new hash/title/excerpt
          await pool.request()
            .input("watchId", sql.BigInt, w.watch_id)
            .input("hash", sql.NVarChar(64), hash)
            .input("title", sql.NVarChar(500), title)
            .input("excerpt", sql.NVarChar(1000), excerpt)
            .query(`
              UPDATE arion.site_page_watch
              SET last_content_hash = @hash,
                  last_title = @title,
                  last_excerpt = @excerpt,
                  last_checked_at = SYSDATETIMEOFFSET()
              WHERE watch_id = @watchId
            `);
        } catch (innerErr) {
          log(`[pagechanges] page ${w.page_url} ERROR: ${innerErr.message}`);
        }
      }

      totalRows += siteRows;
      await logJobComplete(pool, logId, "success", siteRows, null);
      log(`[pagechanges] ${site.domain}: ${siteRows} change(s) detected`);
    } catch (err) {
      errors.push({ site: site.domain, message: err.message });
      await logJobComplete(pool, logId, "error", siteRows, err.message.slice(0, 1999));
      log(`[pagechanges] ${site.domain} ERROR: ${err.message}`);
    }
  }

  return { sitesProcessed: sites.length, rowsWritten: totalRows, errors };
}
