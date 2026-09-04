// src/shared/businessIdentity.js — arion-func's thin client for the ONE business
// identity. Seams audit §10 / §0 item 8, decision SEAM-10-A.
//
// The chain itself lives in platform-api `lib/businessIdentity.js` and is
// served at GET /internal/business-identity/:tenantId. NOTHING IN THIS FILE
// DECIDES WHAT A BUSINESS IS CALLED. If you find yourself adding a `||` here,
// you are building the tenth chain.
//
// TWO name chains lived in this repo — neither of them in the audit's list of
// nine, both found by reading the code on this pass:
//
//   src/shared/leadgenScheduler.js   business_name || "your business"
//   src/shared/weeklyDigestSender.js business_name || "Lead Gen"
//
// The second is the worst of the eleven: a business whose name was not recorded
// received a weekly digest addressed to "Lead Gen" — our internal product name,
// in a client-facing email. Neither chain read preferred_business_name at all,
// so a business that had asked to be called something else was called something
// else everywhere EXCEPT here.
//
// ── THE CACHE: 60 SECONDS, AND WHY THIS ONE IS SAFE ───────────────────────
// Small pack 2 deleted the notification-gate client's 30-second cache because a
// cached PERMISSION outlived a bounce webhook and re-mailed a dead address. The
// distinction is not "caches are bad", it is what the cached thing is:
//
//   · a permission changes asynchronously, from outside, and the cost of being
//     one second stale is a message reaching somebody who said stop;
//   · a NAME changes when its owner edits a settings page, and the cost of
//     being one minute stale is one minute of the old name.
//
// Sixty seconds is the same TTL platform-api's own entitlement and template
// caches use, and it is stated here rather than inherited so the reason travels
// with the number.
//
// ── STALE-ON-FAILURE IS DELIBERATE ────────────────────────────────────────
// If platform-api cannot answer, this returns the LAST KNOWN identity for that
// business, flagged `stale: true`, and logs. Only if there has never been one
// does it fall back to the neutral name. A live client's invoice must not
// re-brand itself to "Your Service Provider" because of a thirty-second blip
// on our side — and the 503 that the route answers on a database failure (as
// opposed to the 200 + neutral it answers for a business that genuinely has no
// name) is what makes telling those apart possible.
//
// NEVER THROWS. Every caller here is rendering something a customer is about
// to read; a failure to look up a name must not fail the digest.
//
// REQUIRES: PLATFORM_API_URL and PLATFORM_INTERNAL_TOKEN (SEAM-11, read only
// through src/shared/platformEnv.js).

import { platformApiUrl, platformInternalToken } from "./platformEnv.js";

/** THE one last resort, byte-identical to platform-api's NEUTRAL_BUSINESS_NAME
 *  and to iadm-webhooks', LUMEN's and arion-func's copies. Pinned by a test in
 *  each repo. */
export const NEUTRAL_BUSINESS_NAME = "Your Service Provider";

export const IDENTITY_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5000;

/** tenantId(lower) -> { identity, at, stale } */
const _cache = new Map();
const CACHE_MAX = 500;

/** The shape a caller gets when we have never had an answer for this business. */
export function neutralIdentity(tenantId) {
  return {
    tenant_id: String(tenantId || ""),
    found: false,
    display_name: NEUTRAL_BUSINESS_NAME,
    name_source: "neutral",
    legal_name: null,
    slug: null,
    email: null,
    phone: null,
    support_email: null,
    billing_email: null,
    website_url: null,
    logo_url: null,
    brand_color: null,
    tagline: null,
    industry: null,
    neutral: true,
    source: "unavailable",
  };
}

export function clearIdentityCache() { _cache.clear(); }

function cacheSet(key, identity, at) {
  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  // `at` comes from the SAME clock the read uses. Stamping with Date.now()
  // while comparing against an injected clock is a cache that never expires
  // under test and expires normally in production — i.e. a cache whose TTL
  // nothing proves.
  _cache.set(key, { identity, at });
}

/**
 * The business's identity. Never throws, never rejects.
 *
 * @param {string} tenantId
 * @param {{fetchImpl?:Function, now?:Function, log?:object}} [opts]
 * @returns {Promise<object>} always an identity object; check `.source` and
 *   `.stale` when you care whether it is fresh.
 */
export async function getBusinessIdentity(tenantId, opts = {}) {
  const key = String(tenantId || "").trim().toLowerCase();
  if (!key) return neutralIdentity(tenantId);

  const now = opts.now || Date.now;
  const log = opts.log || console;
  const hit = _cache.get(key);
  if (hit && now() - hit.at < IDENTITY_TTL_MS) return hit.identity;

  const base = platformApiUrl();
  const token = platformInternalToken();
  const doFetch = opts.fetchImpl || globalThis.fetch;

  const degrade = (reason) => {
    if (hit) {
      // Last known good. Deliberately NOT re-dated: the entry keeps its
      // original timestamp so the next call retries rather than settling into
      // a stale name for the life of the process (the iadm-webhooks
      // senderCache incident, in the shape that caused it).
      log.warn?.(`[businessIdentity] ${reason} for ${key} — serving the last known name`);
      return { ...hit.identity, stale: true, source: "stale-cache" };
    }
    log.warn?.(`[businessIdentity] ${reason} for ${key} — no cached name, using the neutral one`);
    return neutralIdentity(tenantId);
  };

  if (!base || !token) return degrade("PLATFORM_API_URL / PLATFORM_INTERNAL_TOKEN not configured");

  let res;
  try {
    res = await doFetch(`${base}/internal/business-identity/${encodeURIComponent(key)}`, {
      headers: { "x-internal-token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return degrade(`unreachable (${e?.message || e})`);
  }
  if (!res.ok) return degrade(`HTTP ${res.status}`);

  let identity;
  try {
    identity = await res.json();
  } catch (e) {
    return degrade(`unreadable body (${e?.message || e})`);
  }
  if (!identity || typeof identity.display_name !== "string" || !identity.display_name) {
    return degrade("response carried no display_name");
  }

  const shaped = { ...identity, stale: false, source: identity.found ? "platform" : "platform-neutral" };
  cacheSet(key, shaped, now());
  return shaped;
}

/** The one-liner most call sites want. Never throws. */
export async function businessDisplayName(tenantId, opts = {}) {
  return (await getBusinessIdentity(tenantId, opts)).display_name;
}

export default { getBusinessIdentity, businessDisplayName, clearIdentityCache, NEUTRAL_BUSINESS_NAME };
