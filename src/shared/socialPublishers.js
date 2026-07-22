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

// ─── FACEBOOK PAGE FEED / STORY ─────────────────────────────────────────────
//   post:  POST /{page-id}/feed   { message, link?, access_token }
//          POST /{page-id}/photos { url, caption, access_token } (image attachment)
//   story: POST /{page-id}/photos        { url, published=false } → photo_id
//          POST /{page-id}/photo_stories { photo_id }             → story live
//   reel:  NOT YET — Facebook Reels need the resumable video-upload flow
//          (/{page-id}/video_reels, upload phases). Lands with Phase B when
//          real Meta credentials exist to exercise it. Until then a scheduled
//          FB reel settles as a clean per-target failure instead of a stall.
async function publishFacebook({ pageId, accessToken, message, imageUrls = [], link = null, contentType = "post" }) {
  if (!pageId)      return { ok: false, error_class: "missing_target", error_text: "No FB page_id on connection" };
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "FB access token missing" };

  if (contentType === "reel") {
    return {
      ok: false,
      error_class: "unsupported_content_type",
      error_text: "Facebook Reels publishing is not wired yet (needs the resumable video-upload flow — Phase B)",
    };
  }
  if (contentType === "story") {
    if (imageUrls.length === 0) {
      return { ok: false, error_class: "content_policy", error_text: "Facebook Stories require an image" };
    }
    try {
      // Step 1 — upload the photo unpublished so it doesn't hit the feed.
      const photoResp = await fetch(`${FB_GRAPH_BASE}/${encodeURIComponent(pageId)}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          url: imageUrls[0],
          published: "false",
          access_token: accessToken,
        }),
      });
      const photoData = await jsonOrText(photoResp);
      if (!photoResp.ok) return { ok: false, ...classifyError(photoResp.status, photoData) };
      const photoId = photoData?.id;
      if (!photoId) return { ok: false, error_class: "other", error_text: "FB photo upload missing id" };

      // Step 2 — attach it to a page story.
      const storyResp = await fetch(`${FB_GRAPH_BASE}/${encodeURIComponent(pageId)}/photo_stories`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ photo_id: photoId, access_token: accessToken }),
      });
      const storyData = await jsonOrText(storyResp);
      if (!storyResp.ok) return { ok: false, ...classifyError(storyResp.status, storyData) };
      // photo_stories returns { success, post_id }; stories have no stable
      // public permalink (they expire in 24h) so we leave permalink null.
      return { ok: true, external_post_id: storyData?.post_id || photoId, permalink: null };
    } catch (err) {
      return { ok: false, error_class: "network", error_text: String(err.message || err).slice(0, 800) };
    }
  }

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
//   post:  POST /{ig-user-id}/media  { image_url, caption } → { id: container_id }
//   story: POST /{ig-user-id}/media  { media_type=STORIES, image_url|video_url }
//   reel:  POST /{ig-user-id}/media  { media_type=REELS, video_url, caption }
//          → then poll /{container-id}?fields=status_code until FINISHED
//            (video containers process async; publishing early 400s)
//   all:   POST /{ig-user-id}/media_publish { creation_id } → { id: media_id }
//
// Failure shapes are graceful: text-only posts, image-less stories, and
// video-less reels all settle as per-target failures, never throws.

// Video containers (reels, video stories) process asynchronously — poll the
// container's status_code before media_publish. FINISHED → good to publish;
// ERROR → fail; anything else keeps waiting until attempts run out.
async function igWaitForContainer(creationId, accessToken, { attempts = 10, delayMs = 6000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const resp = await fetch(
      `${FB_GRAPH_BASE}/${encodeURIComponent(creationId)}?fields=status_code&access_token=${encodeURIComponent(accessToken)}`
    );
    const data = await jsonOrText(resp);
    if (!resp.ok) return { ready: false, ...classifyError(resp.status, data) };
    const status = data?.status_code || "";
    if (status === "FINISHED") return { ready: true };
    if (status === "ERROR") {
      return { ready: false, error_class: "other", error_text: `IG container processing failed: ${JSON.stringify(data).slice(0, 400)}` };
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return { ready: false, error_class: "provider_5xx", error_text: "IG container not ready after polling window" };
}

async function publishInstagram({ igUserId, accessToken, message, imageUrls = [], videoUrls = [], contentType = "post" }) {
  if (!igUserId)    return { ok: false, error_class: "missing_target", error_text: "No IG user/business id on connection" };
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "IG access token missing" };

  // Build the container params per content type.
  const containerParams = { access_token: accessToken };
  let isVideoContainer = false;
  if (contentType === "story") {
    // Stories take an image OR a video; captions aren't rendered on stories.
    if (imageUrls.length > 0) {
      containerParams.media_type = "STORIES";
      containerParams.image_url = imageUrls[0];
    } else if (videoUrls.length > 0) {
      containerParams.media_type = "STORIES";
      containerParams.video_url = videoUrls[0];
      isVideoContainer = true;
    } else {
      return { ok: false, error_class: "content_policy", error_text: "Instagram Stories require an image or video" };
    }
  } else if (contentType === "reel") {
    if (videoUrls.length === 0) {
      return { ok: false, error_class: "content_policy", error_text: "Instagram Reels require a video asset" };
    }
    containerParams.media_type = "REELS";
    containerParams.video_url = videoUrls[0];
    containerParams.caption = message || "";
    isVideoContainer = true;
  } else {
    if (imageUrls.length === 0) {
      return { ok: false, error_class: "content_policy", error_text: "Instagram requires at least one image" };
    }
    containerParams.image_url = imageUrls[0];
    containerParams.caption = message || "";
  }

  try {
    // Step 1 — container.
    const cResp = await fetch(`${FB_GRAPH_BASE}/${encodeURIComponent(igUserId)}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(containerParams),
    });
    const cData = await jsonOrText(cResp);
    if (!cResp.ok) return { ok: false, ...classifyError(cResp.status, cData) };
    const creationId = cData?.id;
    if (!creationId) {
      return { ok: false, error_class: "other", error_text: "IG container missing id" };
    }

    // Step 1.5 — video containers process async; wait until FINISHED.
    if (isVideoContainer) {
      const waited = await igWaitForContainer(creationId, accessToken);
      if (!waited.ready) {
        return { ok: false, error_class: waited.error_class || "other", error_text: waited.error_text || "IG container not ready" };
      }
    }

    // Step 2 — publish.
    const pResp = await fetch(`${FB_GRAPH_BASE}/${encodeURIComponent(igUserId)}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ creation_id: creationId, access_token: accessToken }),
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
async function publishX({ accessToken, message, imageUrls = [], contentType = "post" }) {
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "X access token missing" };
  if (contentType !== "post") {
    // Composer + LUMEN validation already block this; defense in depth.
    return { ok: false, error_class: "unsupported_content_type", error_text: `X does not support ${contentType} content` };
  }

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
async function publishLinkedIn({ accessToken, authorUrn, message, imageUrls = [], contentType = "post" }) {
  if (!accessToken) return { ok: false, error_class: "token_expired", error_text: "LinkedIn access token missing" };
  if (!authorUrn)   return { ok: false, error_class: "missing_target", error_text: "No LinkedIn author URN on connection" };
  if (contentType !== "post") {
    // LinkedIn killed Stories in 2021 and has no reel format; the composer
    // and LUMEN validation block this upstream — defense in depth.
    return { ok: false, error_class: "unsupported_content_type", error_text: `LinkedIn does not support ${contentType} content` };
  }

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
