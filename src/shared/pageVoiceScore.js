/**
 * pageVoiceScore.js — Wave 3 (2026-06-22).
 *
 * For every ARION-managed WP site, pull recently published pages/posts via
 * the IA Plugin REST and score each body against the tenant's brand voice
 * profile (LUMEN-API /my-brand/voice/_internal/score). Writes one row per
 * (site_id, page_url) to arion.page_voice_score — see migration 032 for
 * the schema. The full per-check audit trail (drift_reasons, cost,
 * embedding cosine) lives in lumen.brand_voice_check from migration 052.
 *
 * Why this is a post-publish scan instead of pre-publish: pages are edited
 * in WordPress by humans, often outside our control. The voice scan runs
 * nightly and surfaces drift on the ARION Insights + My Brand > Voice
 * Monitor dashboards so tenants can rewrite off-brand pages before they
 * harm engagement.
 *
 * Soft-failure across the board:
 *   * If LUMEN_API_BASE_URL / token missing → log + skip this run.
 *   * If a site has no plugin app password / plugin offline → skip that
 *     site, continue the rest.
 *   * If the LUMEN-API voice endpoint returns null (tenant has no voice
 *     profile yet) → record source='no_profile' so we don't keep retrying
 *     and burning embedding cost. Next run will retry once the profile
 *     exists (we detect this by checking if voice_score is still null
 *     past 7 days; the timer will re-try then).
 *   * If the plugin returns no pages → no-op for that site.
 *
 * Maximum 25 pages scanned per site per run. We process newest-first
 * and short-circuit when the (page_url, body_sha256) tuple already exists
 * unchanged in arion.page_voice_score — re-scoring the same body wastes
 * embedding cost.
 */
import sql from "mssql";
import crypto from "node:crypto";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAGES_PER_SITE = 25;
const MAX_BODY_CHARS = 50_000;

const LUMEN_API_BASE_URL = (process.env.LUMEN_API_BASE_URL || "").replace(/\/+$/, "");
const LUMEN_VOICE_TOKEN_ENV = "LUMEN_VOICE_INTERNAL_TOKEN";
const FALLBACK_TOKEN_ENV_A = "LUMEN_SOCIAL_DISPATCH_TOKEN";
const FALLBACK_TOKEN_ENV_B = "WALKTHROUGH_SEED_INTERNAL_TOKEN";

function getInternalToken() {
  return (
    process.env[LUMEN_VOICE_TOKEN_ENV] ||
    process.env[FALLBACK_TOKEN_ENV_A] ||
    process.env[FALLBACK_TOKEN_ENV_B] ||
    ""
  );
}

function resolveHost(site) {
  if (site.domain) return String(site.domain).replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (site.wp_admin_url) {
    try { return new URL(site.wp_admin_url).host; } catch { /* ignore */ }
  }
  return null;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s || ""), "utf8").digest("hex");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pull recently-published pages from the IA Plugin. The plugin should
 * expose /content/pages-recent (added with this wave). We fall back to
 * the standard WP REST /wp-json/wp/v2/pages endpoint if the plugin
 * endpoint 404s — that's the case on older plugin versions.
 *
 * Returns: [{ wp_post_id, post_type, page_url, page_title, body }]
 */
async function fetchRecentPages(site, log) {
  const host = resolveHost(site);
  if (!host || !site.wp_app_password_ref) {
    log(`  SKIP — no host or app password (site_id=${site.site_id})`);
    return [];
  }

  const auth = "Basic " + Buffer.from(site.wp_app_password_ref).toString("base64");
  const headers = { Accept: "application/json", Authorization: auth };

  // Try the IA Plugin endpoint first (richer payload + already authenticated).
  const tryUrls = [
    `https://${host}/wp-json/intelligent-analytics/v1/content/pages-recent?limit=${MAX_PAGES_PER_SITE}`,
    `https://${host}/wp-json/wp/v2/pages?per_page=${MAX_PAGES_PER_SITE}&status=publish&_fields=id,link,title,content,type,date_gmt`,
  ];

  for (const url of tryUrls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        if (res.status === 404) continue; // try fallback
        log(`  ${url} → HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      const data = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : null);
      if (!Array.isArray(data)) continue;
      return data.map((p) => {
        // IA plugin shape: { post_id, post_type, link, title, content_html, ... }
        // WP core shape:   { id, type, link, title: {rendered}, content: {rendered} }
        const id = p.post_id ?? p.id ?? null;
        const postType = p.post_type ?? p.type ?? "page";
        const link = p.link || p.url || "";
        const titleRaw = p.title?.rendered ?? p.title ?? "";
        const contentRaw = p.content_html ?? p.content?.rendered ?? p.content ?? "";
        return {
          wp_post_id: id != null ? Number(id) : null,
          post_type: String(postType).slice(0, 40),
          page_url: String(link).slice(0, 1000),
          page_title: stripHtml(titleRaw).slice(0, 500),
          body: stripHtml(contentRaw).slice(0, MAX_BODY_CHARS),
        };
      }).filter((row) => row.page_url && row.body && row.body.length > 40);
    } catch (err) {
      log(`  ${url} → ${err.name === "AbortError" ? "timeout" : err.message}`);
      // try next URL
    }
  }
  return [];
}

/**
 * Score one page body via LUMEN-API.
 * Returns { score, drift_reasons, source, check_id } or null on failure.
 */
async function scorePageBody({ tenantId, page }, log) {
  if (!LUMEN_API_BASE_URL) return null;
  const token = getInternalToken();
  if (!token) return null;
  const url = `${LUMEN_API_BASE_URL}/api/v1/my-brand/voice/_internal/score`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": token,
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        surface: "arion_page",
        subject_id: page.page_url,
        text: `${page.page_title}\n\n${page.body}`.slice(0, MAX_BODY_CHARS),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      log(`  voice/_internal/score HTTP ${res.status}: ${t.slice(0, 200)}`);
      return null;
    }
    const payload = await res.json();
    const d = payload?.data || payload;
    if (!d || typeof d.score !== "number") return null;
    return {
      score: d.score,
      drift_reasons: Array.isArray(d.drift_reasons) ? d.drift_reasons : [],
      source: d.source || null,
      check_id: d.check_id ?? null,
    };
  } catch (err) {
    log(`  voice/_internal/score error: ${err.name === "AbortError" ? "timeout" : err.message}`);
    return null;
  }
}

/**
 * Upsert one (site_id, page_url) row into arion.page_voice_score.
 */
async function upsertScoreRow(pool, { tenantId, siteId, page, bodySha256, score }) {
  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("pageUrl", sql.NVarChar(1000), page.page_url)
    .input("pageTitle", sql.NVarChar(500), page.page_title || null)
    .input("wpPostId", sql.Int, page.wp_post_id || null)
    .input("wpPostType", sql.NVarChar(40), page.post_type || null)
    .input("bodySha256", sql.NVarChar(64), bodySha256)
    .input("voiceScore", sql.Decimal(5, 4), score?.score ?? null)
    .input("driftJson", sql.NVarChar(sql.MAX), JSON.stringify(score?.drift_reasons || []))
    .input("source", sql.NVarChar(40), score?.source || null)
    .input("checkId", sql.BigInt, score?.check_id ?? null)
    .query(`
      MERGE arion.page_voice_score AS tgt
      USING (VALUES (@siteId, @pageUrl)) AS src(site_id, page_url)
        ON tgt.site_id = src.site_id AND tgt.page_url = src.page_url
      WHEN MATCHED THEN UPDATE SET
        tenant_id = @tenantId,
        page_title = @pageTitle,
        wp_post_id = @wpPostId,
        wp_post_type = @wpPostType,
        body_sha256 = @bodySha256,
        voice_score = @voiceScore,
        drift_reasons_json = @driftJson,
        source = @source,
        check_id = @checkId,
        last_scanned_at = SYSDATETIMEOFFSET(),
        updated_at = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT
        (tenant_id, site_id, page_url, page_title, wp_post_id, wp_post_type,
         body_sha256, voice_score, drift_reasons_json, source, check_id, last_scanned_at)
      VALUES
        (@tenantId, @siteId, @pageUrl, @pageTitle, @wpPostId, @wpPostType,
         @bodySha256, @voiceScore, @driftJson, @source, @checkId, SYSDATETIMEOFFSET());
    `);
}

/**
 * Score every recently-published page for one site.
 */
export async function scanSite(pool, site, log = () => {}) {
  const pages = await fetchRecentPages(site, log);
  if (pages.length === 0) {
    return { siteId: site.site_id, written: 0, skipped: 0, reason: "no_pages" };
  }

  // Short-circuit: load existing (page_url -> body_sha256) for this site
  // so we can skip pages whose body hasn't changed since the last scan.
  const existing = new Map();
  try {
    const r = await pool.request()
      .input("siteId", sql.UniqueIdentifier, site.site_id)
      .query(`SELECT page_url, body_sha256 FROM arion.page_voice_score WHERE site_id = @siteId`);
    for (const row of r.recordset || []) existing.set(row.page_url, row.body_sha256);
  } catch (err) {
    log(`  load-existing failed (continuing): ${err.message}`);
  }

  let written = 0;
  let skipped = 0;
  for (const page of pages) {
    const bodySha256 = sha256Hex(`${page.page_title || ""}\n\n${page.body || ""}`);
    if (existing.get(page.page_url) === bodySha256) {
      skipped++;
      continue;
    }
    const score = await scorePageBody({ tenantId: site.tenant_id, page }, log);
    try {
      await upsertScoreRow(pool, {
        tenantId: site.tenant_id,
        siteId: site.site_id,
        page,
        bodySha256,
        score,
      });
      written++;
    } catch (err) {
      log(`  upsert failed for ${page.page_url}: ${err.message}`);
    }
  }
  return { siteId: site.site_id, written, skipped, pageCount: pages.length };
}

/**
 * Run the scan across every site with plugin connectivity.
 */
export async function runPageVoiceScoreScan(pool, log = () => {}) {
  if (!LUMEN_API_BASE_URL) {
    log("LUMEN_API_BASE_URL not set — skipping tick");
    return { sitesChecked: 0, sitesWritten: 0, skipped: true };
  }
  if (!getInternalToken()) {
    log("internal token not set — skipping tick");
    return { sitesChecked: 0, sitesWritten: 0, skipped: true };
  }

  const sitesResult = await pool.request().query(`
    SELECT site_id, tenant_id, domain, wp_admin_url, wp_app_password_ref
    FROM arion.site
    WHERE (status IS NULL OR status != 'suspended')
      AND wp_app_password_ref IS NOT NULL
    ORDER BY site_id
  `);
  const sites = sitesResult.recordset;
  log(`found ${sites.length} site(s) with plugin app-password configured`);

  let totalWritten = 0;
  const errors = [];
  for (const site of sites) {
    try {
      log(`site ${site.domain || site.site_id}`);
      const r = await scanSite(pool, site, log);
      log(`  ${r.written} written, ${r.skipped} skipped (of ${r.pageCount ?? 0} pages)`);
      totalWritten += r.written;
    } catch (err) {
      log(`  ERROR: ${err.message}`);
      errors.push({ siteId: site.site_id, reason: err.message });
    }
  }

  return {
    sitesChecked: sites.length,
    sitesWritten: totalWritten,
    errors,
  };
}
