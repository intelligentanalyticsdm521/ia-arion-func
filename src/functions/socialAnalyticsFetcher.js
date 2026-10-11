// src/functions/socialAnalyticsFetcher.js
//
// My Brand > Social Analytics Fetcher (Wave 3 — Brandon 2026-06-22).
//
// Daily timer that pulls per-post and per-account analytics from the four
// social platforms (Facebook, Instagram, X, LinkedIn) into
// lumen.social_post_metric + lumen.social_account_metric, via the LUMEN-API
// internal endpoints stood up in routes/myBrand/socialAnalyticsInternal.js.
//
//   Schedule:  "0 43 5 * * *" — 05:43 UTC daily
//              (off-peak prime-minute spread per the timer-schedules
//              convention; aligns with US overnight hours).
//
// Flow (all inside one timer invocation):
//   1.  GET LUMEN-API /my-brand/social/_internal/tenants-with-connections
//       → list of every tenant that has at least one ACTIVE connection,
//         flattened with the platforms + connection rows it owns. Includes a
//         best-effort `tier` hint used to gate paid surfaces (X reads).
//   2.  For each tenant:
//        a) Pull every published social_post_target from the last 90 days
//           that hasn't been refetched in the last 23h (via direct read of
//           core.tenant_social_post + tenant_social_post_target joined with
//           the most-recent lumen.social_post_metric.fetched_at).
//        b) For each target, hit the platform's analytics endpoint with the
//           per-(tenant,connection) OAuth token (loaded from KV by the
//           access_token_kv_ref column on tenant_social_connection).
//           - Facebook: GET /{post-id}/insights?metric=post_impressions,post_reactions_by_type_total,post_clicks
//           - Instagram: GET /{ig-media-id}/insights?metric=impressions,reach,engagement,saved
//           - X:        GET /2/tweets/:id?tweet.fields=public_metrics,non_public_metrics
//                       (BUDGET-GATED — X read is paid pay-per-use)
//           - LinkedIn: GET /rest/posts/{urn}/statistics
//        c) Per-account metrics (follower count, reach): one call per active
//           connection.
//        d) Bulk POST collected rows to /my-brand/social/_internal/analytics/upsert
//           (chunked at 500 metrics per call to keep bodies small).
//   3.  X-specific budget cap. Before any X call, sum lumen.ai_usage.cost_usd
//       for the current month with surface='my_brand.x_analytics_read' for the
//       tenant. If > $20, halt X fetches for that tenant and emit a single
//       warn-log line.
//   4.  Caching. The "hasn't been refetched in 23h" filter is enforced
//       SQL-side via MAX(fetched_at) — no Redis, no in-memory state.
//
// NON-GOALS for this build:
//   * Backfilling > 90 days. The cap matches what the platforms reliably
//     return for free.
//   * Storing access_tokens here. KV is the only durable place.
//   * Real-time fetches. This is daily; intra-day "refresh" is a future task.
//
// Failure model: every platform call is wrapped in try/catch. A failure on
// platform A or tenant B never blocks the rest of the run. We log + continue.

import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { getSecret } from "../shared/secrets.js";
import { keepRowsByPayload } from "../shared/productOwnership.js";
import mssql from "mssql";

const SCHEDULE = "0 43 5 * * *";

// ── tunables ──────────────────────────────────────────────────────────────
const LOOKBACK_DAYS = 90;
const REFETCH_MIN_AGE_HOURS = 23;
const X_MONTHLY_CAP_USD = 20;
const X_READ_SURFACE = "my_brand.x_analytics_read";
const X_READ_TIERS = new Set(["pro", "authority", "business", "enterprise"]); // tiers that include X reads
const UPSERT_CHUNK = 500;
const HTTP_TIMEOUT_MS = 15_000;

// Assumed per-read cost basis. We charge this against the budget cap so the
// timer self-throttles long before the X bill becomes a surprise. Tune as
// the real X-API pricing solidifies — until then, this is the conservative
// stand-in (matches the IL Model "1 token = $0.005" worst-case basis from
// the ARGUS canonical scope).
const X_READ_COST_PER_CALL_USD = 0.005;

// ── small helpers ─────────────────────────────────────────────────────────

async function fetchWithTimeout(url, opts = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// LUMEN-API base URL — set via app setting at deploy time. Fail closed if
// missing; we never silently no-op a metrics fetch run.
function getLumenBaseUrl() {
  const u = process.env.LUMEN_API_BASE_URL;
  if (!u) throw new Error("LUMEN_API_BASE_URL is required");
  return u.replace(/\/+$/, "");
}

async function getInternalToken() {
  // Same secret value LUMEN-API expects in `x-internal-token` for the social
  // analytics internal endpoints. Set as env var at deploy time; KV-backed.
  return (
    process.env.SOCIAL_ANALYTICS_INTERNAL_TOKEN ||
    (await getSecret(
      "SOCIAL_ANALYTICS_INTERNAL_TOKEN",
      "SOCIAL-ANALYTICS-INTERNAL-TOKEN"
    ))
  );
}

// ── token loading per connection ──────────────────────────────────────────
// access_token_kv_ref holds the KV secret NAME — we resolve it to a value
// here, with a short in-memory cache (run-scoped) to avoid hammering KV.
const tokenCache = new Map();
async function loadAccessToken(kvRef) {
  if (!kvRef) return null;
  if (tokenCache.has(kvRef)) return tokenCache.get(kvRef);
  try {
    // getSecret takes (envName, secretName). Use the KV ref itself as the
    // secret name; env-fallback is the same ref normalized to upper-snake.
    const envName = String(kvRef).toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const val = await getSecret(envName, kvRef);
    tokenCache.set(kvRef, val);
    return val;
  } catch (e) {
    tokenCache.set(kvRef, null);
    return null;
  }
}

// ── LUMEN-API client ──────────────────────────────────────────────────────
async function fetchTenantsWithConnections(log) {
  const baseUrl = getLumenBaseUrl();
  const token = await getInternalToken();
  if (!token) throw new Error("SOCIAL_ANALYTICS_INTERNAL_TOKEN not available");

  const res = await fetchWithTimeout(
    `${baseUrl}/api/v1/my-brand/social/_internal/tenants-with-connections`,
    { method: "GET", headers: { "x-internal-token": token } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`tenants-with-connections HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  const tenants = json?.data?.tenants || [];
  log(`fetched ${tenants.length} tenant(s) with active connections`);
  return tenants;
}

async function bulkUpsertMetrics(metrics, log) {
  if (!metrics.length) return { inserted: 0, updated: 0, errors: [] };
  const baseUrl = getLumenBaseUrl();
  const token = await getInternalToken();
  let inserted = 0;
  let updated = 0;
  const errors = [];

  for (const batch of chunk(metrics, UPSERT_CHUNK)) {
    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/api/v1/my-brand/social/_internal/analytics/upsert`,
        {
          method: "POST",
          headers: {
            "x-internal-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ metrics: batch }),
        }
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        errors.push(`HTTP ${res.status}: ${body.slice(0, 200)}`);
        continue;
      }
      const json = await res.json();
      inserted += Number(json?.data?.inserted || 0);
      updated += Number(json?.data?.updated || 0);
      if (Array.isArray(json?.data?.errors) && json.data.errors.length) {
        for (const e of json.data.errors.slice(0, 5)) {
          errors.push(`row: ${JSON.stringify(e).slice(0, 200)}`);
        }
      }
    } catch (e) {
      errors.push(`upsert batch failed: ${e?.message?.slice(0, 200)}`);
    }
  }
  log(`upsert summary: inserted=${inserted} updated=${updated} batch_errors=${errors.length}`);
  return { inserted, updated, errors };
}

// ── SQL helpers ───────────────────────────────────────────────────────────

/**
 * Pull post-targets that need a refetch: published in the last 90 days +
 * either never fetched or last-fetched > 23h ago. We left-join on the metric
 * table and use MAX(fetched_at) per target.
 *
 * Returns rows shaped:
 *   { target_id, post_id, platform, external_post_id, connection_id,
 *     access_token_kv_ref, page_id, external_account_id, published_at }
 */
async function loadStaleTargetsForTenant(pool, tenantId, log) {
  try {
    const rs = await pool
      .request()
      .input("tenantId", mssql.UniqueIdentifier, tenantId)
      .input("lookbackDays", mssql.Int, LOOKBACK_DAYS)
      .input("minAgeHours", mssql.Int, REFETCH_MIN_AGE_HOURS)
      .query(`
        WITH last_fetch AS (
          SELECT target_id, MAX(fetched_at) AS last_fetched_at
          FROM lumen.social_post_metric
          GROUP BY target_id
        )
        SELECT
          t.target_id,
          t.post_id,
          t.platform,
          t.external_post_id,
          t.connection_id,
          t.published_at,
          c.access_token_kv_ref,
          c.external_account_id,
          c.page_id
        FROM core.tenant_social_post_target t
          JOIN core.tenant_social_post p   ON p.post_id = t.post_id
          LEFT JOIN core.tenant_social_connection c ON c.connection_id = t.connection_id
          LEFT JOIN last_fetch lf ON lf.target_id = t.target_id
        WHERE p.tenant_id = @tenantId
          AND p.status = 'published'
          AND t.external_post_id IS NOT NULL
          AND t.published_at IS NOT NULL
          AND t.published_at >= DATEADD(day, -@lookbackDays, SYSDATETIMEOFFSET())
          AND (lf.last_fetched_at IS NULL
               OR lf.last_fetched_at < DATEADD(hour, -@minAgeHours, SYSDATETIMEOFFSET()))
        ORDER BY t.published_at DESC;
      `);
    return rs.recordset || [];
  } catch (e) {
    log(`loadStaleTargets failed for tenant=${tenantId}: ${e?.message}`);
    return [];
  }
}

/**
 * Sum X-API read cost charged this calendar month for one tenant. Used to
 * enforce the $20/tenant/month budget cap before kicking off the X fetch
 * pass. Read-only — failures fall back to 0 (we'd rather risk a few extra
 * calls than skip valid data on a transient SQL hiccup).
 */
async function sumMonthlyXReadCost(pool, tenantId, log) {
  try {
    const rs = await pool
      .request()
      .input("tenantId", mssql.UniqueIdentifier, tenantId)
      .input("surface", mssql.NVarChar(50), X_READ_SURFACE)
      .query(`
        SELECT COALESCE(SUM(cost_usd), 0) AS total
        FROM lumen.ai_usage
        WHERE tenant_id = @tenantId
          AND surface   = @surface
          AND occurred_at >= DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1)
          AND occurred_at <  DATEADD(month, 1, DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1));
      `);
    return Number(rs.recordset?.[0]?.total || 0);
  } catch (e) {
    log(`sumMonthlyXReadCost failed for tenant=${tenantId}: ${e?.message}`);
    return 0;
  }
}

/**
 * Charge an X-API read against lumen.ai_usage so the budget cap stays
 * authoritative across runs. Non-fatal on errors (matches the
 * callEmitter.js policy that audit-table writes must never break the flow).
 */
async function chargeXReadUsage(pool, tenantId, costUsd, meta) {
  try {
    await pool
      .request()
      .input("tenant_id", mssql.UniqueIdentifier, tenantId)
      .input("surface", mssql.NVarChar(50), X_READ_SURFACE)
      .input("sub_kind", mssql.NVarChar(50), "tweet_fields_read")
      .input("provider", mssql.NVarChar(32), "x")
      .input("cost_usd", mssql.Decimal(10, 4), costUsd)
      .input("ok", mssql.Bit, 1)
      .input("meta_json", mssql.NVarChar(mssql.MAX), meta ? JSON.stringify(meta) : null)
      .query(`
        INSERT INTO lumen.ai_usage
          (tenant_id, surface, sub_kind, provider, cost_usd, ok, meta_json)
        VALUES
          (@tenant_id, @surface, @sub_kind, @provider, @cost_usd, @ok, @meta_json);
      `);
  } catch (e) {
    // Non-fatal — log via console (no log() handle here) and continue.
    // eslint-disable-next-line no-console
    console.warn(`[social-analytics] chargeXReadUsage non-fatal: ${e?.message?.slice(0, 200)}`);
  }
}

// ── platform fetchers ─────────────────────────────────────────────────────
// Each fetcher returns { post_metric?: {...} } or null on failure. They take
// the per-target row shape from loadStaleTargetsForTenant() + a resolved
// access token. They never throw — caller handles null/undefined.

async function fetchFacebookPostMetrics(target, token) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(target.external_post_id)}/insights`
    + `?metric=post_impressions,post_reactions_by_type_total,post_clicks`
    + `&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const data = json?.data || [];
  let impressions = null, clicks = null, likes = null;
  for (const m of data) {
    const v = m?.values?.[0]?.value;
    if (m.name === "post_impressions") impressions = Number(v) || 0;
    if (m.name === "post_clicks") clicks = Number(v) || 0;
    if (m.name === "post_reactions_by_type_total" && v && typeof v === "object") {
      likes = Object.values(v).reduce((a, b) => a + (Number(b) || 0), 0);
    }
  }
  return {
    kind: "post",
    impressions,
    clicks,
    likes,
    raw_payload: json,
  };
}

async function fetchInstagramPostMetrics(target, token) {
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(target.external_post_id)}/insights`
    + `?metric=impressions,reach,engagement,saved`
    + `&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const data = json?.data || [];
  let impressions = null, reach = null, engagement = null, saves = null;
  for (const m of data) {
    const v = m?.values?.[0]?.value;
    if (m.name === "impressions") impressions = Number(v) || 0;
    if (m.name === "reach") reach = Number(v) || 0;
    if (m.name === "engagement") engagement = Number(v) || 0;
    if (m.name === "saved") saves = Number(v) || 0;
  }
  return {
    kind: "post",
    impressions,
    reach,
    saves,
    // engagement here is an absolute count; we surface it as likes for now
    // (Wave 4 will split likes/comments via per-media-type endpoints).
    likes: engagement,
    raw_payload: json,
  };
}

async function fetchXPostMetrics(target, token) {
  const url = `https://api.twitter.com/2/tweets/${encodeURIComponent(target.external_post_id)}`
    + `?tweet.fields=public_metrics,non_public_metrics`;
  const res = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const pm = json?.data?.public_metrics || {};
  const np = json?.data?.non_public_metrics || {};
  return {
    kind: "post",
    impressions: np.impression_count != null ? Number(np.impression_count) : null,
    likes: pm.like_count != null ? Number(pm.like_count) : null,
    comments: pm.reply_count != null ? Number(pm.reply_count) : null,
    shares: pm.retweet_count != null ? Number(pm.retweet_count) : null,
    clicks: np.url_link_clicks != null ? Number(np.url_link_clicks) : null,
    raw_payload: json,
  };
}

async function fetchLinkedInPostMetrics(target, token) {
  // external_post_id is the LinkedIn URN.
  const url = `https://api.linkedin.com/rest/posts/${encodeURIComponent(target.external_post_id)}/statistics`;
  const res = await fetchWithTimeout(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "linkedin-version": "202405",
      "x-restli-protocol-version": "2.0.0",
    },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  // LinkedIn statistics shape varies; pull what we can from the totals block.
  const t = json?.totalShareStatistics || json || {};
  return {
    kind: "post",
    impressions: t.impressionCount != null ? Number(t.impressionCount) : null,
    clicks: t.clickCount != null ? Number(t.clickCount) : null,
    likes: t.likeCount != null ? Number(t.likeCount) : null,
    comments: t.commentCount != null ? Number(t.commentCount) : null,
    shares: t.shareCount != null ? Number(t.shareCount) : null,
    engagement_rate:
      t.engagement != null && Number.isFinite(Number(t.engagement))
        ? Number(t.engagement)
        : null,
    raw_payload: json,
  };
}

// ── per-account fetchers ──────────────────────────────────────────────────
// One call per active connection. Returns { follower_count?, reach_30d?, ... }
// shaped for lumen.social_account_metric, or null on failure.

async function fetchFacebookAccountMetrics(conn, token) {
  const acct = conn.page_id || conn.external_account_id;
  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(acct)}`
    + `?fields=fan_count,followers_count`
    + `&access_token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return {
    kind: "account",
    follower_count:
      json?.followers_count != null
        ? Number(json.followers_count)
        : json?.fan_count != null
        ? Number(json.fan_count)
        : null,
    raw_payload: json,
  };
}

async function fetchInstagramAccountMetrics(conn, token) {
  const acct = conn.external_account_id;
  // First grab follower count, then insights for reach/impressions 30d.
  const baseUrl = `https://graph.facebook.com/v19.0/${encodeURIComponent(acct)}`;
  const profileRes = await fetchWithTimeout(
    `${baseUrl}?fields=followers_count&access_token=${encodeURIComponent(token)}`
  );
  let followerCount = null, rawProfile = null;
  if (profileRes.ok) {
    rawProfile = await profileRes.json().catch(() => null);
    followerCount = rawProfile?.followers_count != null ? Number(rawProfile.followers_count) : null;
  }
  const insightsRes = await fetchWithTimeout(
    `${baseUrl}/insights?metric=reach,impressions&period=days_28&access_token=${encodeURIComponent(token)}`
  );
  let reach30d = null, impressions30d = null, rawInsights = null;
  if (insightsRes.ok) {
    rawInsights = await insightsRes.json().catch(() => null);
    for (const m of rawInsights?.data || []) {
      const v = m?.values?.[0]?.value;
      if (m.name === "reach") reach30d = Number(v) || 0;
      if (m.name === "impressions") impressions30d = Number(v) || 0;
    }
  }
  return {
    kind: "account",
    follower_count: followerCount,
    reach_30d: reach30d,
    impressions_30d: impressions30d,
    raw_payload: { profile: rawProfile, insights: rawInsights },
  };
}

async function fetchXAccountMetrics(conn, token) {
  const acct = conn.external_account_id;
  const url = `https://api.twitter.com/2/users/${encodeURIComponent(acct)}?user.fields=public_metrics`;
  const res = await fetchWithTimeout(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const pm = json?.data?.public_metrics || {};
  return {
    kind: "account",
    follower_count: pm.followers_count != null ? Number(pm.followers_count) : null,
    raw_payload: json,
  };
}

async function fetchLinkedInAccountMetrics(conn, token) {
  // For an organization/company URN the followers endpoint is:
  //   GET /rest/networkSizes/{urn}?edgeType=COMPANY_FOLLOWED_BY_MEMBER
  const acct = conn.external_account_id;
  const url = `https://api.linkedin.com/rest/networkSizes/${encodeURIComponent(acct)}`
    + `?edgeType=CompanyFollowedByMember`;
  const res = await fetchWithTimeout(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "linkedin-version": "202405",
      "x-restli-protocol-version": "2.0.0",
    },
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  return {
    kind: "account",
    follower_count: json?.firstDegreeSize != null ? Number(json.firstDegreeSize) : null,
    raw_payload: json,
  };
}

// ── per-tenant orchestration ──────────────────────────────────────────────

/**
 * May this run make paid X reads for a business?
 * X reads are a paid spend: only for a business whose My Brand is CONFIRMED
 * (opts.spendAllowed true). We could not confirm -> no X reads this run; the
 * free reads still run. The tier comes from the subscription (platform-api's
 * my_brand node, opts.tier) when it carries one; LUMEN's best-effort hint is
 * the fallback. An unknown tier on a confirmed business is allowed (the
 * monthly budget cap still applies), as before.
 */
export function xReadsAllowed(opts = {}, hintTier = null) {
  if (opts.spendAllowed !== true) return false;
  const tier = String(opts.tier || hintTier || "").toLowerCase();
  return !tier || X_READ_TIERS.has(tier);
}

async function processTenant(pool, tenant, log, opts = {}) {
  const tenantId = tenant.tenant_id;
  // The tier comes from the subscription (platform-api's my_brand node) when it
  // carries one; LUMEN's best-effort hint is the fallback.
  const xAllowedByTier = xReadsAllowed(opts, tenant.tier);
  if (opts.spendAllowed === false) log(`tenant=${tenantId} X reads held — could not confirm this business's subscription just now`);

  // Pre-check the X budget so we can skip the X work cheaply.
  const xSpend = await sumMonthlyXReadCost(pool, tenantId, log);
  const xOverBudget = xSpend >= X_MONTHLY_CAP_USD;
  if (xOverBudget) {
    log(
      `WARN tenant=${tenantId} X reads halted — monthly spend $${xSpend.toFixed(4)} ` +
      `>= cap $${X_MONTHLY_CAP_USD}`
    );
  }

  const metricsBuffer = [];
  const today = todayIsoDate();

  // ── (a) per-post fetches ──────────────────────────────────────────────
  const targets = await loadStaleTargetsForTenant(pool, tenantId, log);
  log(`tenant=${tenantId} stale post-targets=${targets.length}`);

  // Group by connection so token resolution is amortized.
  const tokenByConn = new Map(); // connection_id -> token
  for (const t of targets) {
    if (!t.connection_id) continue;
    if (!tokenByConn.has(t.connection_id)) {
      tokenByConn.set(t.connection_id, await loadAccessToken(t.access_token_kv_ref));
    }
  }

  let xCallsThisRun = 0;
  for (const t of targets) {
    const token = t.connection_id ? tokenByConn.get(t.connection_id) : null;
    if (!token) continue;

    try {
      let m = null;
      if (t.platform === "facebook") {
        m = await fetchFacebookPostMetrics(t, token);
      } else if (t.platform === "instagram") {
        m = await fetchInstagramPostMetrics(t, token);
      } else if (t.platform === "x") {
        if (!xAllowedByTier) continue;          // tier doesn't include paid X reads
        if (xOverBudget) continue;              // cap hit
        // Pre-emptive cap check: don't exceed budget mid-loop.
        const projected = xSpend + (xCallsThisRun + 1) * X_READ_COST_PER_CALL_USD;
        if (projected >= X_MONTHLY_CAP_USD) {
          log(`tenant=${tenantId} X reads paused mid-loop (projected $${projected.toFixed(4)} >= cap)`);
          continue;
        }
        m = await fetchXPostMetrics(t, token);
        xCallsThisRun++;
        await chargeXReadUsage(pool, tenantId, X_READ_COST_PER_CALL_USD, {
          target_id: t.target_id,
          external_post_id: t.external_post_id,
        });
      } else if (t.platform === "linkedin") {
        m = await fetchLinkedInPostMetrics(t, token);
      }

      if (!m) continue;
      metricsBuffer.push({
        kind: "post",
        target_id: t.target_id,
        tenant_id: tenantId,
        platform: t.platform,
        external_post_id: t.external_post_id,
        metric_date: today,
        impressions: m.impressions ?? null,
        reach: m.reach ?? null,
        likes: m.likes ?? null,
        comments: m.comments ?? null,
        shares: m.shares ?? null,
        clicks: m.clicks ?? null,
        saves: m.saves ?? null,
        engagement_rate: m.engagement_rate ?? null,
        raw_payload: m.raw_payload || null,
      });
    } catch (e) {
      log(
        `tenant=${tenantId} platform=${t.platform} post=${t.external_post_id} fetch error: ` +
        `${e?.message?.slice(0, 200)}`
      );
    }
  }

  // ── (b) per-account fetches ───────────────────────────────────────────
  for (const conn of tenant.connections || []) {
    // We need a token per connection — reuse the cache.
    let token = null;
    // The account-fetch path doesn't carry the kv_ref directly, so do a tiny
    // per-tenant lookup. (We could enhance the LUMEN endpoint to return the
    // ref later; for now we read from the targets we already loaded.)
    const matchTarget = targets.find((t) => t.connection_id === conn.connection_id);
    if (matchTarget) {
      token = tokenByConn.get(conn.connection_id) || null;
    } else {
      // Connection has zero posts in window — load its KV ref directly.
      try {
        const rs = await pool
          .request()
          .input("cid", mssql.UniqueIdentifier, conn.connection_id)
          .query(`
            SELECT access_token_kv_ref
            FROM core.tenant_social_connection
            WHERE connection_id = @cid;
          `);
        token = await loadAccessToken(rs.recordset?.[0]?.access_token_kv_ref);
      } catch (e) {
        log(`tenant=${tenantId} conn=${conn.connection_id} token load error: ${e?.message}`);
      }
    }
    if (!token) continue;

    try {
      let a = null;
      if (conn.platform === "facebook") {
        a = await fetchFacebookAccountMetrics(conn, token);
      } else if (conn.platform === "instagram") {
        a = await fetchInstagramAccountMetrics(conn, token);
      } else if (conn.platform === "x") {
        if (!xAllowedByTier || xOverBudget) continue;
        const projected = xSpend + (xCallsThisRun + 1) * X_READ_COST_PER_CALL_USD;
        if (projected >= X_MONTHLY_CAP_USD) continue;
        a = await fetchXAccountMetrics(conn, token);
        xCallsThisRun++;
        await chargeXReadUsage(pool, tenantId, X_READ_COST_PER_CALL_USD, {
          external_account_id: conn.external_account_id,
          kind: "account_metrics",
        });
      } else if (conn.platform === "linkedin") {
        a = await fetchLinkedInAccountMetrics(conn, token);
      }

      if (!a) continue;
      metricsBuffer.push({
        kind: "account",
        tenant_id: tenantId,
        platform: conn.platform,
        external_account_id: conn.external_account_id,
        metric_date: today,
        follower_count: a.follower_count ?? null,
        follower_change: null, // wave-4 day-over-day diff
        reach_30d: a.reach_30d ?? null,
        impressions_30d: a.impressions_30d ?? null,
        raw_payload: a.raw_payload || null,
      });
    } catch (e) {
      log(
        `tenant=${tenantId} platform=${conn.platform} acct=${conn.external_account_id} ` +
        `fetch error: ${e?.message?.slice(0, 200)}`
      );
    }
  }

  log(
    `tenant=${tenantId} buffered metrics=${metricsBuffer.length} ` +
    `(x_calls=${xCallsThisRun}, x_spend_pre=$${xSpend.toFixed(4)})`
  );

  // ── (c) bulk upsert ────────────────────────────────────────────────────
  const result = await bulkUpsertMetrics(metricsBuffer, log);
  return {
    tenant_id: tenantId,
    targets_fetched: targets.length,
    metrics_buffered: metricsBuffer.length,
    inserted: result.inserted,
    updated: result.updated,
    upsert_errors: result.errors.length,
    x_calls: xCallsThisRun,
  };
}

// ── one run ───────────────────────────────────────────────────────────────

/**
 * One run of the fetcher.
 *
 * MY BRAND ONLY (11 Oct 2026, "They only get the features for subscriptions
 * they are signed up for"). Social analytics are My Brand, and platform-api
 * answers products.my_brand as owned when the business owns ARION OR SPARK.
 *   decided not owned -> left out: no platform read, no paid X read, nothing
 *                        written;
 *   undecided         -> the free reads of the business's own posts run as
 *                        before, but no paid X read (a spend is never made on
 *                        "we do not know");
 *   owned             -> as before, with the tier from the same payload.
 *
 * @param deps { fetchTenants, getPool, processTenant, getEntitlements } test seams
 */
export async function runSocialAnalyticsTick(log, deps = {}) {
  const fetchTenants = deps.fetchTenants || fetchTenantsWithConnections;
  const getPool = deps.getPool || getServicesPool;
  const runTenant = deps.processTenant || processTenant;
  const totals = { tenants: 0, leftOut: 0, inserted: 0, updated: 0, upsertErrors: 0, errors: 0 };

  try {
    const listed = await fetchTenants(log);
    totals.tenants = listed.length;
    if (!listed.length) {
      log("no tenants with active connections — done");
      return totals;
    }

    const owners = await keepRowsByPayload("my_brand", listed, { getEntitlements: deps.getEntitlements });
    totals.leftOut = owners.notOwned.length;
    for (const t of owners.notOwned) {
      log(`tenant=${t.tenant_id} skipped — neither ARION nor SPARK is in this business's subscription, so its social analytics were not fetched`);
    }
    if (!owners.kept.length) return totals;

    const pool = await getPool();

    for (const tenant of owners.kept) {
      const answer = owners.stateOf.get(String(tenant.tenant_id || "").trim().toUpperCase());
      try {
        const r = await runTenant(pool, tenant, log, {
          spendAllowed: answer?.state === "owned",
          tier: answer?.node?.tier || null,
        });
        totals.inserted += r.inserted;
        totals.updated += r.updated;
        totals.upsertErrors += r.upsert_errors;
      } catch (e) {
        totals.errors++;
        log(`tenant=${tenant.tenant_id} FAILED: ${e?.message?.slice(0, 300)}`);
      }
    }
  } catch (e) {
    log(`FATAL: ${e?.message?.slice(0, 300)}`);
    totals.errors++;
  }
  return totals;
}

export { processTenant };

// ── timer registration ────────────────────────────────────────────────────

app.timer("socialAnalyticsFetcher", {
  schedule: SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (msg) => context.log(`[social-analytics] ${msg}`);
    log(`starting (schedule=${SCHEDULE})`);
    if (timer?.isPastDue) log("isPastDue=true");

    const startedAt = Date.now();
    const totals = await runSocialAnalyticsTick(log);

    const elapsedMs = Date.now() - startedAt;
    log(
      `done in ${elapsedMs}ms — tenants=${totals.tenants} ` +
      `inserted=${totals.inserted} updated=${totals.updated} ` +
      `upsert_errors=${totals.upsertErrors} tenant_errors=${totals.errors}`
    );
  },
});
