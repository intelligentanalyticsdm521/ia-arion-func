/**
 * Monthly PageSpeed runner — runs Google PageSpeed Insights for every active
 * ARION site (mobile + desktop) and persists the snapshot to
 * arion.site_pagespeed_snapshot.
 *
 * This is the CrUX + Opportunities-aware version that matches the v2.0.7
 * plugin + arion-api rebuild. Called by the monthlyPageSpeed.js timer.
 */
import sql from "mssql";
import { getSecret } from "./secrets.js";

const PSI_BASE = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const REQUEST_TIMEOUT_MS = 45_000;

function extractOpportunities(audits, limit = 8) {
  const keys = [
    "render-blocking-resources",
    "unused-css-rules",
    "unused-javascript",
    "modern-image-formats",
    "uses-responsive-images",
    "efficient-animated-content",
    "offscreen-images",
    "total-byte-weight",
    "uses-long-cache-ttl",
    "uses-optimized-images",
    "uses-text-compression",
    "server-response-time",
    "redirects",
    "font-display",
    "critical-request-chains",
    "dom-size",
  ];
  const out = [];
  for (const k of keys) {
    const a = audits?.[k];
    if (!a) continue;
    if (a.score != null && a.score >= 0.9) continue;
    out.push({
      id: k,
      title: a.title || k,
      display_value: a.displayValue || null,
      numeric_value: a.numericValue ?? null,
      numeric_unit: a.numericUnit || null,
      score: a.score ?? null,
    });
  }
  out.sort((a, b) => (b.numeric_value ?? -1) - (a.numeric_value ?? -1));
  return out.slice(0, limit);
}

function extractCrux(experience) {
  if (!experience?.metrics) return null;
  const m = experience.metrics;
  const pluck = (key) => {
    const v = m[key];
    if (!v) return null;
    return {
      percentile: v.percentile ?? null,
      category: v.category ?? null,
      distributions: v.distributions ?? null,
    };
  };
  return {
    overall_category: experience.overall_category ?? null,
    origin_fallback: experience.origin_fallback ?? null,
    lcp: pluck("LARGEST_CONTENTFUL_PAINT_MS"),
    inp: pluck("INTERACTION_TO_NEXT_PAINT"),
    cls: pluck("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
    fcp: pluck("FIRST_CONTENTFUL_PAINT_MS"),
    ttfb: pluck("EXPERIMENTAL_TIME_TO_FIRST_BYTE"),
  };
}

/**
 * PSI is genuinely flaky — it returns HTTP 500 "Lighthouse returned error:
 * Something went wrong." on a meaningful fraction of calls and succeeds on an
 * immediate retry. Verified 2026-07-24: two back-to-back calls for
 * intelligentanalyticsdm.com returned 500 then 200.
 *
 * Without a retry, one transient 500 silently drops that site's snapshot for
 * the ENTIRE cadence window (30 or 90 days) — which is why prod held only 4
 * PSI rows, all written by onboarding, and the monthly timer had never
 * produced a single row.
 */
const PSI_MAX_ATTEMPTS = 3;
const PSI_RETRY_BASE_MS = 4000;

async function runPSI(url, strategy) {
  let lastErr;
  for (let attempt = 1; attempt <= PSI_MAX_ATTEMPTS; attempt++) {
    try {
      return await runPSIOnce(url, strategy);
    } catch (err) {
      lastErr = err;
      if (attempt < PSI_MAX_ATTEMPTS) {
        // Linear backoff — PSI is rate-limited per minute, so spacing out
        // beats hammering it.
        await new Promise((r) => setTimeout(r, PSI_RETRY_BASE_MS * attempt));
      }
    }
  }
  throw new Error(`${lastErr?.message || "unknown"} (after ${PSI_MAX_ATTEMPTS} attempts)`);
}

async function runPSIOnce(url, strategy) {
  // v2.0.12 — load from Key Vault if env var not set
  const apiKey = await getSecret('GOOGLE_API_KEY', 'GOOGLE-PAGESPEED-API-KEY');
  const params = new URLSearchParams({ url, strategy });
  params.append("category", "performance");
  params.append("category", "accessibility");
  params.append("category", "seo");
  params.append("category", "best-practices");
  if (apiKey) params.set("key", apiKey);

  const fetchUrl = `${PSI_BASE}?${params.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(fetchUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cats = data.lighthouseResult?.categories || {};
    const audits = data.lighthouseResult?.audits || {};
    const scoreOf = (c) => (c?.score != null ? Math.round(c.score * 100) : null);
    const metricOf = (k) => {
      const a = audits[k];
      return a ? { value: a.numericValue ?? null, display: a.displayValue ?? null } : { value: null, display: null };
    };
    return {
      strategy,
      url,
      scores: {
        performance: scoreOf(cats.performance),
        accessibility: scoreOf(cats.accessibility),
        seo: scoreOf(cats.seo),
        bestPractices: scoreOf(cats["best-practices"]),
      },
      metrics: {
        lcp: metricOf("largest-contentful-paint"),
        cls: metricOf("cumulative-layout-shift"),
        inp: metricOf("interaction-to-next-paint"),
        fcp: metricOf("first-contentful-paint"),
        si: metricOf("speed-index"),
        tbt: metricOf("total-blocking-time"),
      },
      field_url: extractCrux(data.loadingExperience),
      field_origin: extractCrux(data.originLoadingExperience),
      opportunities: extractOpportunities(audits),
      fetchedAt: new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function persistSnapshot(pool, tenantId, siteId, result, triggeredBy) {
  const today = new Date().toISOString().slice(0, 10);
  const m = result.metrics || {};
  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("runDate", sql.Date, today)
    .input("strategy", sql.NVarChar(10), result.strategy)
    .query(`DELETE FROM arion.site_pagespeed_snapshot
            WHERE tenant_id=@tenantId AND site_id=@siteId AND run_date=@runDate AND strategy=@strategy`);

  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("runDate", sql.Date, today)
    .input("strategy", sql.NVarChar(10), result.strategy)
    .input("performanceScore", sql.Int, result.scores?.performance ?? null)
    .input("accessibilityScore", sql.Int, result.scores?.accessibility ?? null)
    .input("seoScore", sql.Int, result.scores?.seo ?? null)
    .input("bestPracticesScore", sql.Int, result.scores?.bestPractices ?? null)
    .input("mobilePerformance", sql.Int, result.strategy === "mobile" ? result.scores?.performance ?? null : null)
    .input("desktopPerformance", sql.Int, result.strategy === "desktop" ? result.scores?.performance ?? null : null)
    .input("lcpMs", sql.Int, Math.round(m.lcp?.value ?? 0) || null)
    .input("inpMs", sql.Int, Math.round(m.inp?.value ?? 0) || null)
    .input("clsScore", sql.Decimal(6, 4), m.cls?.value != null ? Number(m.cls.value).toFixed(4) : null)
    .input("fcpMs", sql.Int, Math.round(m.fcp?.value ?? 0) || null)
    .input("tbtMs", sql.Int, Math.round(m.tbt?.value ?? 0) || null)
    .input("opportunities", sql.NVarChar(sql.MAX), JSON.stringify(result.opportunities || []))
    .input("cruxUrl", sql.NVarChar(sql.MAX), result.field_url ? JSON.stringify(result.field_url) : null)
    .input("cruxOrigin", sql.NVarChar(sql.MAX), result.field_origin ? JSON.stringify(result.field_origin) : null)
    .input("triggeredBy", sql.NVarChar(50), triggeredBy || "monthly")
    .query(`
      INSERT INTO arion.site_pagespeed_snapshot
        (tenant_id, site_id, run_date, strategy,
         performance_score, accessibility_score, seo_score, best_practices_score,
         mobile_performance, desktop_performance,
         lcp_ms, inp_ms, cls_score, fcp_ms, tbt_ms,
         opportunities, crux_url_json, crux_origin_json, triggered_by)
      VALUES (@tenantId, @siteId, @runDate, @strategy,
              @performanceScore, @accessibilityScore, @seoScore, @bestPracticesScore,
              @mobilePerformance, @desktopPerformance,
              @lcpMs, @inpMs, @clsScore, @fcpMs, @tbtMs,
              @opportunities, @cruxUrl, @cruxOrigin, @triggeredBy)
    `);
}

/**
 * Per-plan PSI cadence:
 *   Starter / Essentials / Lite → every 90 days (quarterly)
 *   Growth / Authority / Business → every 30 days (monthly)
 *
 * The timer fires monthly (1st) and for each site checks if it's due based
 * on its plan + last-run date. Sites that ran within their cadence window
 * are skipped to avoid wasted PSI quota.
 */
function cadenceDaysForTier(tier) {
  const t = String(tier || "").toLowerCase();
  if (t === "starter" || t === "essentials" || t === "lite" || t === "standard" || t === "pro") return 90;
  if (t === "growth" || t === "authority" || t === "business" || t === "enterprise") return 30;
  return 90; // safe default for unknown tiers
}

export async function runMonthlyPageSpeed(pool, log) {
  const out = { sitesProcessed: 0, sitesSkipped: 0, snapshotsWritten: 0, errors: [] };

  const sitesRes = await pool.request().query(`
    SELECT s.site_id, s.tenant_id, s.domain, s.arion_tier
    FROM arion.site s
    WHERE s.domain IS NOT NULL AND s.domain <> ''
  `);
  const sites = sitesRes.recordset || [];
  log(`found ${sites.length} site(s)`);

  for (const site of sites) {
    const cadence = cadenceDaysForTier(site.arion_tier);

    // Check last run_date for this site — skip if within cadence window
    try {
      const lastRun = await pool.request()
        .input("siteId", site.site_id)
        .query(`SELECT TOP 1 run_date FROM arion.site_pagespeed_snapshot WHERE site_id = @siteId AND triggered_by IN ('monthly','quarterly') ORDER BY run_date DESC`);
      const lastRunDate = lastRun.recordset?.[0]?.run_date;
      if (lastRunDate) {
        const daysSince = (Date.now() - new Date(lastRunDate).getTime()) / 86400000;
        if (daysSince < cadence - 2) {
          // -2 day fudge so a 30-day plan run on the 1st of consecutive months isn't skipped
          out.sitesSkipped++;
          log(`${site.domain} skipped (tier=${site.arion_tier || "—"}, cadence=${cadence}d, last=${Math.round(daysSince)}d ago)`);
          continue;
        }
      }
    } catch (e) {
      log(`${site.domain} cadence check failed: ${e.message}`);
    }

    out.sitesProcessed++;
    const triggeredBy = cadence >= 90 ? "quarterly" : "monthly";
    const url = "https://" + String(site.domain).replace(/^https?:\/\//, "").replace(/\/$/, "");
    for (const strategy of ["mobile", "desktop"]) {
      try {
        const result = await runPSI(url, strategy);
        await persistSnapshot(pool, site.tenant_id, site.site_id, result, triggeredBy);
        out.snapshotsWritten++;
        log(`${site.domain} ${strategy} (${triggeredBy}): ${result.scores?.performance ?? "?"}`);
      } catch (err) {
        out.errors.push({ site_id: site.site_id, strategy, message: err.message });
        log(`${site.domain} ${strategy} FAILED: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  return out;
}
