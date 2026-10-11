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
import { keepRowsOfOwners } from "./productOwnership.js";

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

// IA Insights needs OWN-SITE keyword position history for EVERY site with an
// SE Ranking project, regardless of tier — the kw_* series in
// arion.metric_monthly are built from it (Brandon 2026-07-25; the client
// backfill seeded 12 months of history that this keeps current). This
// supersedes the 2026-07-16 "clients not syncing is by design" note below:
// that was true when position history only served Market Monitor. Competitor
// capture remains Authority-gated (MM tier gating is Brandon's open decision).
async function listInsightsSites(pool) {
  const r = await pool.request().query(`
    SELECT site_id, tenant_id, domain, se_ranking_project_id, seo_addon_tier
    FROM arion.site
    WHERE se_ranking_project_id IS NOT NULL
  `);
  return r.recordset;
}

const isAuthority = (site) => String(site.seo_addon_tier || "").toLowerCase() === AUTHORITY_TIER;

// FEATURES row 27 (11 Oct 2026): every Market Monitor job runs only for
// businesses that own ARION (the SEO add-on lives under ARION). A business
// whose ARION has ended is left out and none of its rows are touched, so a
// re-subscribe picks up where it stopped. Undecided runs as before.
// NOT YET: the add-on tier itself is still the cached arion.site.seo_addon_tier
// column, because platform-api's entitlement payload carries no SEO add-on node.
async function onlyArionOwners(sites, deps, log, job) {
  const owners = await keepRowsOfOwners("arion", sites, {
    ownership: deps.ownership, did: `no Market Monitor ${job} were captured`,
  });
  for (const s of owners.summary?.skipped || []) log(`[${job}] business ${s.tenantId}: skipped — ${s.note}`);
  return owners;
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

// ── Batched position writer ──────────────────────────────────────────────────
//
// ⚠️ 2026-07-16 — this replaces ONE MERGE ROUND-TRIP PER KEYWORD PER COMPETITOR.
// A real run issues ~2,651 of them, sequentially, and that is the documented code
// cause of the "Timeout: Request failed to complete in 15000ms" failures
// arion.market_monitor_job_log recorded on 2026-07-05 and 07-06 — the visible
// prelude to the outage that started on 07-10.
//
// Now: one multi-row MERGE per CHUNK. 2,651 round-trips becomes ~14.
//
// CHUNK_SIZE is bounded by SQL Server's hard limit of 2,100 parameters per
// statement. At 9 parameters per row, 200 rows = 1,800 — comfortably under, with
// room for the limit to not be a cliff if a column is ever added.
//
// 🪤 THE MULTI-ROW MERGE GOTCHA: if the source contains two rows with the same
// join key, SQL Server raises "The MERGE statement attempted to UPDATE or DELETE
// the same row of the target table more than once" and the WHOLE chunk fails.
// The per-row version could never hit this because each statement saw one row.
// SE Ranking can legitimately return a duplicate (keyword_id, engine) — so rows
// are de-duplicated on the exact join key before the MERGE, last-write-wins,
// which matches the per-row behaviour it replaces.
const POSITION_CHUNK_SIZE = 200;

function dedupeByMergeKey(rows) {
  // Join key = (site_id, site_engine_id, keyword_id, recorded_for, competitor_domain)
  // — exactly the ON clause below, and the UQ_pos_history_daily unique index.
  const byKey = new Map();
  for (const r of rows) {
    byKey.set(`${r.siteId}|${r.engineId}|${r.keywordId}|${r.recordedFor}|${r.competitorDomain ?? ""}`, r);
  }
  return [...byKey.values()];
}

/**
 * MERGE a batch of position rows. Returns the number of rows written.
 *
 * @param rows [{ tenantId, siteId, projectId, engineId, keywordId, keyword,
 *                competitorDomain (string|null), pos (int|null), recordedFor }]
 */
export async function mergePositionRows(pool, rows) {
  const deduped = dedupeByMergeKey(rows);
  let written = 0;

  for (let i = 0; i < deduped.length; i += POSITION_CHUNK_SIZE) {
    const chunk = deduped.slice(i, i + POSITION_CHUNK_SIZE);
    const req = pool.request();
    const tuples = [];

    chunk.forEach((r, j) => {
      req.input(`t${j}`, sql.UniqueIdentifier, r.tenantId);
      req.input(`s${j}`, sql.UniqueIdentifier, r.siteId);
      req.input(`p${j}`, sql.NVarChar(50), r.projectId);
      req.input(`e${j}`, sql.NVarChar(50), r.engineId);
      req.input(`k${j}`, sql.NVarChar(50), r.keywordId);
      req.input(`w${j}`, sql.NVarChar(500), r.keyword);
      req.input(`c${j}`, sql.NVarChar(300), r.competitorDomain ?? null);
      req.input(`o${j}`, sql.Int, r.pos);
      req.input(`d${j}`, sql.Date, r.recordedFor);
      tuples.push(`(@t${j}, @s${j}, @p${j}, @e${j}, @k${j}, @w${j}, @c${j}, @o${j}, @d${j})`);
    });

    // competitor_domain is NULLABLE and part of the join key, so the ON clause
    // must compare it NULL-safely. `tgt.competitor_domain = src.competitor_domain`
    // is never true for two NULLs, which would insert a duplicate own-site row
    // every single day. The per-row version handled this with a literal
    // `IS NULL` in the own-site branch; the unified batch needs the explicit
    // both-null test.
    const res = await req.query(`
      MERGE arion.se_ranking_position_history WITH (HOLDLOCK) AS tgt
      USING (VALUES ${tuples.join(", ")})
        AS src (tenant_id, site_id, se_project_id, site_engine_id, keyword_id, keyword, competitor_domain, position, recorded_for)
        ON  tgt.site_id        = src.site_id
        AND tgt.site_engine_id = src.site_engine_id
        AND tgt.keyword_id     = src.keyword_id
        AND tgt.recorded_for   = src.recorded_for
        AND ((tgt.competitor_domain IS NULL AND src.competitor_domain IS NULL)
             OR tgt.competitor_domain = src.competitor_domain)
      WHEN MATCHED THEN
        UPDATE SET position = src.position, recorded_at = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN
        INSERT (tenant_id, site_id, se_project_id, site_engine_id, keyword_id, keyword, competitor_domain, position, recorded_for)
        VALUES (src.tenant_id, src.site_id, src.se_project_id, src.site_engine_id, src.keyword_id, src.keyword, src.competitor_domain, src.position, src.recorded_for);
    `);
    written += res.rowsAffected?.[0] ?? chunk.length;
  }

  return written;
}

// ══════════════════════════════════════════════════════════════
// JOB 1: Competitor Moves — daily position capture
// ══════════════════════════════════════════════════════════════
export async function runMovesCapture(pool, log, deps = {}) {
  // listAuthoritySites and logJobStart both used to sit OUTSIDE any try. A
  // failure in either threw straight out of the caller having written no
  // job_log row at all — which is exactly what production shows: the timer has
  // fired every morning since 2026-07-10 while job_log's last 'moves' entry is
  // 2026-07-10T03:16. The job could not report its own death because the
  // reporting call was itself unprotected.
  //
  // Both are now attributed, so the next failure names its stage instead of
  // vanishing.
  let sites;
  try {
    // 2026-07-25 — was listAuthoritySites. Own-site positions now capture for
    // EVERY project site (IA Insights needs the kw_* series for all clients);
    // competitor capture below stays Authority-gated per tier.
    sites = await listInsightsSites(pool);
  } catch (e) {
    e.message = `listInsightsSites failed (before any job_log row could be written): ${e.message}`;
    throw e;
  }
  const owners = await onlyArionOwners(sites, deps, log, "moves");
  sites = owners.kept;

  log(`[moves] processing ${sites.length} project site(s) (${sites.filter(isAuthority).length} Authority-tier)`);

  if (sites.length === 0) {
    log(`[moves] no sites with an se_ranking_project_id — nothing to capture`);
  }

  let totalRows = 0;
  const errors = [];

  for (const site of sites) {
    let logId = null;
    let siteRows = 0;
    // Per-site, declared inside the loop: rows must never leak from a site that
    // failed into the flush of the next one.
    const pendingRows = [];
    try {
      // Inside the try: if the job_log INSERT itself fails (e.g. the DB is the
      // problem), that must be a recorded per-site error rather than an
      // unhandled throw that kills the whole run silently.
      logId = await logJobStart(pool, site.tenant_id, site.site_id, "moves");

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

          // Collect, don't round-trip. This inner statement used to be ONE MERGE
          // per keyword — ~2,651 sequential round-trips per run, which is what
          // tipped 07-05/07-06 into the 15s request timeout. Flushed in chunks by
          // mergePositionRows() once the whole site is gathered.
          pendingRows.push({
            tenantId: site.tenant_id,
            siteId: site.site_id,
            projectId,
            engineId,
            keywordId,
            keyword: keywordText,
            competitorDomain: null, // own site
            pos,
            recordedFor: today,
          });
          siteRows++;
        }
      }

      // Competitor positions via SE Ranking Project API — CORRECT endpoints:
      //   GET /competitors/site/{site_id}            → list competitors for project
      //   GET /competitors/{competitor_id}/positions → daily positions per engine per keyword
      //
      // The endpoint we were previously using (/sites/{id}/competitors?se_id=X)
      // returns 400 in the current v4 API. Fixed 2026-04-19 after reading the
      // Project API docs.
      //
      // 2026-07-25 — competitor capture is a Market Monitor (Authority-tier)
      // feature; own-site capture above runs for every project site.
      const compListRaw = isAuthority(site)
        ? await projectApi("GET", `/competitors/site/${encodeURIComponent(projectId)}`)
        : { ok: true, data: [] };
      const competitors = compListRaw.ok && Array.isArray(compListRaw.data) ? compListRaw.data : [];

      if (competitors.length === 0 && isAuthority(site)) {
        log(`[moves] ${site.domain}: no competitors tracked in SE Ranking project (or /competitors/site returned empty).`);
      }

      for (const comp of competitors) {
        const compId = String(comp.id || "");
        if (!compId) continue;
        const compDomain = String(comp.url || comp.name || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "").slice(0, 299);
        if (!compDomain) continue;

        // Positions for this specific competitor across all engines/keywords
        const posRaw = await projectApi("GET", `/competitors/${encodeURIComponent(compId)}/positions`);
        if (!posRaw.ok) {
          log(`[moves] ${site.domain}: competitor ${compDomain} positions fetch failed — HTTP ${posRaw.status}`);
          continue;
        }
        const engineBlocksForComp = Array.isArray(posRaw.data) ? posRaw.data : [];

        for (const block of engineBlocksForComp) {
          const engineId = String(block.site_engine_id || "");
          const keywords = Array.isArray(block.keywords) ? block.keywords : [];

          for (const kw of keywords) {
            const keywordId = String(kw.id || "");
            const keywordText = String(kw.name || "").slice(0, 499);
            const positions = Array.isArray(kw.positions) ? kw.positions : [];
            const mostRecent = positions[positions.length - 1] || {};
            // SE Ranking uses pos=0 and/or pos=100+ for "not in top 100"
            const rawPos = Number(mostRecent.pos || 0);
            const pos = rawPos > 0 && rawPos < 100 ? rawPos : null;

            // Collect, don't round-trip — same change as the own-site loop above.
            // This is where the bulk of the ~2,651 statements came from: one per
            // keyword PER COMPETITOR.
            pendingRows.push({
              tenantId: site.tenant_id,
              siteId: site.site_id,
              projectId,
              engineId,
              keywordId,
              keyword: keywordText,
              competitorDomain: compDomain,
              pos,
              recordedFor: today,
            });
            siteRows++;
          }
        }
      }

      // ── Flush: one multi-row MERGE per chunk instead of ~2,651 singles ──────
      if (pendingRows.length) {
        await mergePositionRows(pool, pendingRows);
        log(
          `[moves] ${site.domain}: flushed ${pendingRows.length} position row(s) in ` +
          `${Math.ceil(pendingRows.length / POSITION_CHUNK_SIZE)} batch(es) (was ${pendingRows.length} round-trips)`
        );
      }

      totalRows += siteRows;
      await logJobComplete(pool, logId, "success", siteRows, null);
      log(`[moves] ${site.domain}: ${siteRows} row(s) written`);
    } catch (err) {
      // Record the real error FIRST. logJobComplete writes to the same database
      // that may itself be the failure — if it throws here, an exception raised
      // inside a catch block is unhandled and would take the whole run down,
      // losing the diagnosis we are in the middle of capturing. The DB write is
      // best-effort; the returned `errors` array is the reliable channel, and
      // the caller now logs it loudly.
      errors.push({ site: site.domain, message: err.message, stage: logId ? "capture" : "logJobStart" });
      log(`[moves] ${site.domain} ERROR: ${err.message}`);
      try {
        await logJobComplete(pool, logId, "error", siteRows, String(err.message).slice(0, 1999));
      } catch (logErr) {
        log(`[moves] ${site.domain}: could not record the error to job_log either: ${logErr.message}`);
      }
    }
  }

  return { sitesProcessed: sites.length, sitesLeftOut: owners.leftOut.length, productOff: owners.summary, rowsWritten: totalRows, errors };
}

// ══════════════════════════════════════════════════════════════
// JOB 2: Backlink Watch — weekly snapshot
// ══════════════════════════════════════════════════════════════
export async function runBacklinkSnapshot(pool, log, deps = {}) {
  const sites = (await onlyArionOwners(await listAuthoritySites(pool), deps, log, "backlinks")).kept;
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

export async function runPageChangeSweep(pool, log, deps = {}) {
  const sites = (await onlyArionOwners(await listAuthoritySites(pool), deps, log, "page changes")).kept;
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
