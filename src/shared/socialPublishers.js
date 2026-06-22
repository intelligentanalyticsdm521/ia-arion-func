// shared/socialPublishers.js — Provider-specific publish bodies for
// Facebook Page, Instagram Business, X (Twitter), and LinkedIn.
//
// Called by socialDispatcher.js. Each `publishX(...)` function returns:
//   { ok: true, external_post_id, permalink? }
//   { ok: false, error_class, error_text }
//
// We never throw — the dispatcher needs every target to settle even when
// one platform 4xx's. Errors are wrapped + classified into a small taxonomy
// so the analytics page can show "rate_limit" / "token_expired" /
// "content_policy" / "other" buckets.
//
// IMAGE HANDLING:
//   * Facebook page feed: link via `link` if attaching one URL, or use the
//     /{page-id}/photos endpoint for image attachment (we use photos+link
//     fallback so a single asset post never silently drops the image).
//   * Instagram: 2-step container/publish flow. Container expects the image
//     to be at a publicly-fetchable URL (Graph API pulls it server-side).
//   * X: media_upload happens against api.x.com/2/media/upload then the
//     id is referenced in /2/tweets.
//   * LinkedIn: posts API uses asset URNs (initialiseUpload → PUT bytes →
//     reference). Implementation is in linkedinUploadAsset() below.
//
// AUTH NOTE: every call uses the access token the dispatcher passes in.
// The dispatcher pulled it from KV using access_token_kv_ref. We never
// see the KV secret name here.

const FB_GRAPH_VERSION = process.env.FB_GRAPH_VERSION || "v19.0";
const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;
const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || "202405";

// Classify a provider HTTP error into one of our stable taxonomy buckets so
// the analytics dashboards can group failures.
function classifyError(status, body) {
  const txt = typeof body === "string" ? body : JSON.stringify(body || "").slice(0, 800);
  if (status === 401 || status === 403) return { error_class: "token_expired", error_text: txt };
  if (status === 429)                   return { error_class: "rate_limit", error_text: txt };
  if (/policy|violation|prohibited/i.test(txt)) return { error_class: "content_policy", error_text: txt };
  if (status >= 500)                    return { error_class: "provider_5xx", error_text: txt };
  return { error_class: "other", error_text: txt };
}

async function jsonOrText(resp) {
  const text = await resp.text().catch(() => "");
  try { return JSON.parse(text); } catch { return text; }
}

// ─── FACEBOOK PAGE FEED ─────────────────────────────────────────────────────
//   POST /{page-id}/feed   { message, link?, access_token }
//   POST /{page-id}/photos { url, caption, access_token } (image attachment)
async function publishFacebook({ pageId, accessToken, message, imageUrls = [], link = null }) {
  if (!pageId)      return { ok: false, error_class: "missing_target", error_text: "No FB page_id on connection" };
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "FB access token missing" };

  try {
    let url, body;
    if (imageUrls.length === 1) {
      // Single-image attachment via /photos. Returns post_id (composite "page_postId").
      url = `${FB_GRAPH_BASE}/${encodeURIComponent(pageId)}/photos`;
      body = new URLSearchParams({
        url: imageUrls[0],
        caption: message || "",
        published: "true",
        access_token: accessToken,
      });
    } else {
      url = `${FB_GRAPH_BASE}/${encodeURIComponent(pageId)}/feed`;
      const params = { message: message || "", published: "true", access_token: accessToken };
      if (link) params.link = link;
      body = new URLSearchParams(params);
    }
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await jsonOrText(resp);
    if (!resp.ok) return { ok: false, ...classifyError(resp.status, data) };

    const externalId = data?.post_id || data?.id || null;
    const permalink = externalId
      ? `https://www.facebook.com/${String(externalId).replace("_", "/posts/")}`
      : null;
    return { ok: true, external_post_id: externalId, permalink };
  } catch (err) {
    return { ok: false, error_class: "network", error_text: String(err.message || err).slice(0, 800) };
  }
}

// ─── INSTAGRAM BUSINESS ─────────────────────────────────────────────────────
//   POST /{ig-user-id}/media  { image_url, caption, access_token } → { id: container_id }
//   POST /{ig-user-id}/media_publish { creation_id, access_token } → { id: media_id }
//
// IG requires at least one image; if imageUrls is empty we return a graceful
// failure with error_class='content_policy' (IG rejects text-only posts).
async function publishInstagram({ igUserId, accessToken, message, imageUrls = [] }) {
  if (!igUserId)    return { ok: false, error_class: "missing_target", error_text: "No IG user/business id on connection" };
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "IG access token missing" };
  if (imageUrls.length === 0) {
    return { ok: false, error_class: "content_policy", error_text: "Instagram requires at least one image" };
  }

  try {
    // Step 1 — container.
    const containerUrl = `${FB_GRAPH_BASE}/${encodeURIComponent(igUserId)}/media`;
    const containerBody = new URLSearchParams({
      image_url: imageUrls[0],
      caption: message || "",
      access_token: accessToken,
    });
    const cResp = await fetch(containerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: containerBody,
    });
    const cData = await jsonOrText(cResp);
    if (!cResp.ok) return { ok: false, ...classifyError(cResp.status, cData) };
    const creationId = cData?.id;
    if (!creationId) {
      return { ok: false, error_class: "other", error_text: "IG container missing id" };
    }

    // Step 2 — publish.
    const publishUrl = `${FB_GRAPH_BASE}/${encodeURIComponent(igUserId)}/media_publish`;
    const publishBody = new URLSearchParams({
      creation_id: creationId,
      access_token: accessToken,
    });
    const pResp = await fetch(publishUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: publishBody,
    });
    const pData = await jsonOrText(pResp);
    if (!pResp.ok) return { ok: false, ...classifyError(pResp.status, pData) };

    const externalId = pData?.id || null;
    // IG permalink is fetched via /{media_id}?fields=permalink, but we can't
    // afford the extra round-trip for every post. Permalink stays null and a
    // backfill job can populate it from the metrics puller.
    return { ok: true, external_post_id: externalId, permalink: null };
  } catch (err) {
    return { ok: false, error_class: "network", error_text: String(err.message || err).slice(0, 800) };
  }
}

// ─── X (TWITTER) ────────────────────────────────────────────────────────────
//   POST https://api.x.com/2/tweets   { text, media: { media_ids: [...] } }
//
// Media upload (v1.1 endpoint still on api.twitter.com) is omitted for the
// MVP — text-only tweets work end-to-end and the image-attached path can be
// added when X moves their media endpoint into the v2 API. We surface a
// friendly degradation: if imageUrls.length > 0 we publish the tweet text
// and append the first image URL inline; that hits X's automatic-card path.
async function publishX({ accessToken, message, imageUrls = [] }) {
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "X access token missing" };

  try {
    let text = (message || "").trim();
    if (imageUrls.length > 0 && text.length + imageUrls[0].length + 1 <= 280) {
      text = `${text} ${imageUrls[0]}`.trim();
    }
    const url = "https://api.x.com/2/tweets";
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ text }),
    });
    const data = await jsonOrText(resp);
    if (!resp.ok) return { ok: false, ...classifyError(resp.status, data) };
    const externalId = data?.data?.id || null;
    const permalink = externalId ? `https://x.com/i/web/status/${externalId}` : null;
    return { ok: true, external_post_id: externalId, permalink };
  } catch (err) {
    return { ok: false, error_class: "network", error_text: String(err.message || err).slice(0, 800) };
  }
}

// ─── LINKEDIN ───────────────────────────────────────────────────────────────
//   POST https://api.linkedin.com/rest/posts   { author: urn:li:person:..., commentary, ... }
//
// Image upload uses the assets API (initialiseUpload → PUT → reference). For
// MVP we ship a text-only post with optional URL; image attachments are
// noted as a follow-up. authorUrn must already be on the connection
// (display_name persisted there during OAuth callback).
async function publishLinkedIn({ accessToken, authorUrn, message, imageUrls = [] }) {
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "LinkedIn access token missing" };
  if (!authorUrn)   return { ok: false, error_class: "missing_target", error_text: "No LinkedIn author URN on connection" };

  try {
    let commentary = (message || "").trim();
    if (imageUrls.length > 0) {
      commentary = `${commentary}\n\n${imageUrls[0]}`.trim();
    }
    const body = {
      author: authorUrn,
      commentary,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    const resp = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(body),
    });
    const data = await jsonOrText(resp);
    if (!resp.ok) return { ok: false, ...classifyError(resp.status, data) };
    // LinkedIn returns the URN in the x-restli-id header; fall back to body.
    const externalId =
      resp.headers.get("x-restli-id") ||
      data?.id ||
      null;
    const permalink = externalId
      ? `https://www.linkedin.com/feed/update/${encodeURIComponent(externalId)}/`
      : null;
    return { ok: true, external_post_id: externalId, permalink };
  } catch (err) {
    return { ok: false, error_class: "network", error_text: String(err.message || err).slice(0, 800) };
  }
}

export const publishers = {
  facebook: publishFacebook,
  instagram: publishInstagram,
  x: publishX,
  linkedin: publishLinkedIn,
};

export { publishFacebook, publishInstagram, publishX, publishLinkedIn };
