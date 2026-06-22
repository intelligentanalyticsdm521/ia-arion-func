// shared/socialDispatcher.js — driver for the social-post dispatcher timer.
//
// Called every 5 minutes by functions/socialPostDispatcher.js.
//
// One tick:
//   1. GET LUMEN-API /api/v1/my-brand/social/_internal/due-posts (atomic
//      claim — the API flips status='scheduled' → 'publishing' inside the
//      SELECT so a second timer can't race).
//   2. For each claimed post:
//        a. For each per-platform target:
//             - Resolve the access token from KV via access_token_kv_ref.
//             - Pick the right body (per_platform_body[platform] override
//               with body_default fallback).
//             - Resolve image URLs from the attached brand_asset rows
//               (blob_ref → CDN URL).
//             - Call the matching publisher in socialPublishers.js.
//        b. PATCH LUMEN-API /api/v1/my-brand/social/_internal/post/:postId/result
//           with the per-target outcomes. LUMEN-API rolls post.status
//           forward to 'published' / 'partial_failure' / 'failed' based
//           on the aggregate of ALL targets (not just the ones in this
//           PATCH — supports multi-tick settlement).
//   3. Errors NEVER bubble — a 500 on one post must not poison the others.
//
// Token resolution: access_token_kv_ref is the KV secret NAME (per the
// schema comment on core.tenant_social_connection in migration 053). We
// pull via getSecret(env, secretName) which short-circuits to process.env
// when the same name happens to be set as an app setting (useful for
// local-dev override).
//
// Image URL resolution:
//   * Production blobs land under the storage account configured for the
//     My Brand image studio (env: STORAGE_BLOB_BASE_URL, default the
//     prod public-read container). blob_ref is the path AFTER the
//     container — e.g. "tenants/<tenantId>/2026/06/22/foo.png".
//   * If blob_ref already starts with http:// or https:// (uploaded asset
//     case), we pass it through.

import { getSecret } from "./secrets.js";
import { publishers } from "./socialPublishers.js";

const LUMEN_API_BASE_URL = (process.env.LUMEN_API_BASE_URL || "").replace(/\/+$/, "");
const DISPATCH_TOKEN_ENV = "LUMEN_SOCIAL_DISPATCH_TOKEN";
const FALLBACK_TOKEN_ENV = "WALKTHROUGH_SEED_INTERNAL_TOKEN";
const MAX_POSTS_PER_TICK = parseInt(process.env.SOCIAL_DISPATCH_MAX_PER_TICK || "50", 10);
const STORAGE_BLOB_BASE_URL = (
  process.env.SOCIAL_BLOB_BASE_URL ||
  process.env.BRAND_BLOB_BASE_URL ||
  process.env.STORAGE_BLOB_BASE_URL ||
  ""
).replace(/\/+$/, "");

function getDispatchToken() {
  return process.env[DISPATCH_TOKEN_ENV] || process.env[FALLBACK_TOKEN_ENV] || "";
}

function resolveAssetUrl(blobRef) {
  if (!blobRef) return null;
  const s = String(blobRef);
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (!STORAGE_BLOB_BASE_URL) return null;
  // blob_ref already includes container/path — strip a leading slash.
  return `${STORAGE_BLOB_BASE_URL}/${s.replace(/^\/+/, "")}`;
}

function pickPlatformBody(post, platform) {
  const fromMap =
    post.per_platform_body && typeof post.per_platform_body === "object"
      ? post.per_platform_body[platform]
      : null;
  return (fromMap || post.body_default || "").toString();
}

/**
 * One tick — wraps every external call in try/catch so a single failure
 * never breaks the tick.
 *
 * @param log — `(msg) => void` for context.log forwarding
 * @returns   — { scanned, claimed, published, partial_failure, failed, errors[] }
 */
export async function runSocialDispatchTick(log = () => {}) {
  const summary = {
    scanned: 0,
    claimed: 0,
    published: 0,
    partial_failure: 0,
    failed: 0,
    target_published: 0,
    target_failed: 0,
    errors: [],
  };

  if (!LUMEN_API_BASE_URL) {
    log("[social-dispatcher] LUMEN_API_BASE_URL is not set — skipping tick");
    summary.errors.push("LUMEN_API_BASE_URL not set");
    return summary;
  }
  const dispatchToken = getDispatchToken();
  if (!dispatchToken) {
    log(`[social-dispatcher] neither ${DISPATCH_TOKEN_ENV} nor ${FALLBACK_TOKEN_ENV} set — skipping tick`);
    summary.errors.push("dispatch token not set");
    return summary;
  }

  // 1. Claim due posts.
  let posts = [];
  try {
    const url = `${LUMEN_API_BASE_URL}/api/v1/my-brand/social/_internal/due-posts?limit=${MAX_POSTS_PER_TICK}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { "x-internal-token": dispatchToken },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log(`[social-dispatcher] due-posts HTTP ${resp.status}: ${text.slice(0, 200)}`);
      summary.errors.push(`due-posts HTTP ${resp.status}`);
      return summary;
    }
    const body = await resp.json().catch(() => ({}));
    posts = Array.isArray(body?.data) ? body.data : [];
    summary.scanned = posts.length;
    summary.claimed = posts.length;
  } catch (err) {
    log(`[social-dispatcher] due-posts fetch error: ${err.message}`);
    summary.errors.push(`due-posts fetch: ${err.message}`);
    return summary;
  }

  if (posts.length === 0) {
    log("[social-dispatcher] no due posts");
    return summary;
  }

  // 2. Publish each post's targets and patch the result back.
  for (const post of posts) {
    const postId = post.post_id;
    const tenantId = post.tenant_id;
    const targets = Array.isArray(post.targets) ? post.targets : [];
    const imageUrls = (post.assets || [])
      .filter(a => a && (a.kind === "image" || /^image\//.test(a.mime || "")))
      .map(a => resolveAssetUrl(a.blob_ref))
      .filter(Boolean);

    const targetUpdates = [];
    for (const t of targets) {
      const platform = (t.platform || "").toLowerCase();
      const publish = publishers[platform];
      if (!publish) {
        targetUpdates.push({
          platform,
          status: "failed",
          error_class: "unsupported_platform",
          error_text: `No publisher for platform '${platform}'`,
        });
        summary.target_failed++;
        continue;
      }
      if (t.connection_status && t.connection_status !== "active") {
        targetUpdates.push({
          platform,
          status: "failed",
          error_class: "token_expired",
          error_text: `Connection status is '${t.connection_status}'`,
        });
        summary.target_failed++;
        continue;
      }

      // Resolve access token via KV. The KV ref doubles as the env-var name
      // for short-circuit (getSecret reads process.env first).
      let accessToken = null;
      if (t.access_token_kv_ref) {
        try {
          accessToken = await getSecret(t.access_token_kv_ref, t.access_token_kv_ref);
        } catch (err) {
          log(`[social-dispatcher] token fetch failed post=${postId} platform=${platform}: ${err.message}`);
        }
      }
      if (!accessToken) {
        targetUpdates.push({
          platform,
          status: "failed",
          error_class: "token_expired",
          error_text: "Access token not available in KV",
        });
        summary.target_failed++;
        continue;
      }

      const message = pickPlatformBody(post, platform);

      let result;
      try {
        const args = { accessToken, message, imageUrls };
        if (platform === "facebook")  args.pageId = t.page_id || t.external_account_id;
        if (platform === "instagram") args.igUserId = t.external_account_id;
        if (platform === "linkedin")  args.authorUrn = t.external_account_id; // expected to be urn:li:person:...
        result = await publish(args);
      } catch (err) {
        result = { ok: false, error_class: "publisher_threw", error_text: String(err.message || err).slice(0, 800) };
      }

      if (result.ok) {
        targetUpdates.push({
          platform,
          status: "published",
          external_post_id: result.external_post_id,
          permalink: result.permalink,
        });
        summary.target_published++;
        log(`[social-dispatcher] published post=${postId} platform=${platform} ext=${result.external_post_id || "?"}`);
      } else {
        targetUpdates.push({
          platform,
          status: "failed",
          error_class: result.error_class,
          error_text: result.error_text,
        });
        summary.target_failed++;
        log(`[social-dispatcher] FAILED post=${postId} platform=${platform} class=${result.error_class}`);
      }
    }

    // 3. PATCH the result back. Best-effort — if it fails the row stays
    // 'publishing' and the next tick will re-attempt (the claim-on-select
    // gate means we won't double-publish; the post just stalls until the
    // PATCH succeeds).
    if (targetUpdates.length === 0) {
      // No targets at all → mark the post 'failed' so it doesn't stay in
      // 'publishing' forever.
      targetUpdates.push({
        platform: "_none",
        status: "failed",
        error_class: "no_targets",
        error_text: "Post has no per-platform targets",
      });
    }

    try {
      const patchUrl = `${LUMEN_API_BASE_URL}/api/v1/my-brand/social/_internal/post/${encodeURIComponent(postId)}/result`;
      const patchResp = await fetch(patchUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": dispatchToken,
          // Carry the tenantId in headers for the audit middleware downstream
          // (LUMEN-API logs every internal-token call with the originating
          // tenant when available).
          "x-tenant-id": tenantId || "",
        },
        body: JSON.stringify({ target_updates: targetUpdates }),
      });
      if (!patchResp.ok) {
        const text = await patchResp.text().catch(() => "");
        log(`[social-dispatcher] PATCH result HTTP ${patchResp.status} post=${postId}: ${text.slice(0, 200)}`);
        summary.errors.push(`PATCH ${postId} HTTP ${patchResp.status}`);
        continue;
      }
      const body = await patchResp.json().catch(() => ({}));
      const finalStatus = body?.data?.post_status;
      if (finalStatus === "published")        summary.published++;
      else if (finalStatus === "partial_failure") summary.partial_failure++;
      else if (finalStatus === "failed")      summary.failed++;
      // null finalStatus = still publishing (more targets unresolved) — that's
      // fine, the next tick can settle them via a separate PATCH.
    } catch (err) {
      log(`[social-dispatcher] PATCH result error post=${postId}: ${err.message}`);
      summary.errors.push(`PATCH ${postId}: ${err.message}`);
    }
  }

  return summary;
}
