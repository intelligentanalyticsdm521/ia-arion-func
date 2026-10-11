// src/shared/featureKeys.js — every feature key arion-func's timers name, and
// the startup check that compares them with the catalog.
//
// Scope 2.4 (SCOPE_FEATURE_CATALOG_2026-10-11.md): "A startup check per app:
// fetch /internal/feature-catalog once, log every key ... that the catalog
// does not have." A key the catalog lacks is "missing" for every business,
// and a timer HOLDS on a missing key, so a typo would quietly stop the job;
// this says so once when the Functions host loads.
//
// The Google review replies timer (functions/gbpAutoReply.js) names no key
// here on purpose: it only rings arion-api, whose runner gates on
// arion_business_reviews itself.
//
// test/feature-keys.test.mjs pins every key below to this repo's copy of the
// catalog keys (test/fixtures/feature-keys.json); platform-api
// scripts/_check-feature-keys.mjs diffs that copy against the seed.
import { MARKET_MONITOR_FEATURE } from "./marketMonitor.js";
import { VOICE_MONITOR_FEATURE } from "./pageVoiceScore.js";
import { X_READS_FEATURE } from "../functions/socialAnalyticsFetcher.js";
import { platformApiUrl, platformInternalToken } from "./platformEnv.js";

/** Every catalog key arion-func gates on (sorted, unique). */
export function namedFeatureKeys() {
  return [...new Set([MARKET_MONITOR_FEATURE, VOICE_MONITOR_FEATURE, X_READS_FEATURE])].sort();
}

/**
 * Fetch GET /internal/feature-catalog once and log every named key it lacks.
 * Never throws. Returns what it found (for tests).
 */
export async function checkFeatureKeysAtStartup(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || console;
  const base = platformApiUrl(env);
  const tok = platformInternalToken(env);
  if (!base || !tok) {
    log.warn?.("[featureKeys] PLATFORM_API_URL / PLATFORM_INTERNAL_TOKEN not set; the timers' feature keys were not checked against the catalog");
    return { checked: false, missing: [], reason: "not_configured" };
  }
  const doFetch = deps.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.ENTITLEMENT_TIMEOUT_MS || 4000));
  try {
    const res = await doFetch(`${base}/internal/feature-catalog`, { headers: { "x-internal-token": tok }, signal: controller.signal });
    if (!res || !res.ok) {
      log.warn?.(`[featureKeys] platform-api answered ${res?.status} for the feature catalog; the timers' feature keys were not checked`);
      return { checked: false, missing: [], reason: `http_${res?.status}` };
    }
    const body = await res.json();
    const have = new Set((body?.features || []).map((f) => String(f.key)));
    const missing = namedFeatureKeys().filter((k) => !have.has(k));
    if (missing.length) {
      log.error?.(`[featureKeys] ${missing.length} feature key(s) arion-func's timers gate on are not in the catalog; those timers hold for every business until it is fixed: ${missing.join(", ")}`);
    } else {
      log.log?.(`[featureKeys] all ${namedFeatureKeys().length} feature keys arion-func's timers gate on are in the catalog (${have.size} rows)`);
    }
    return { checked: true, missing, count: have.size };
  } catch (err) {
    log.warn?.(`[featureKeys] could not read the feature catalog: ${err.message}`);
    return { checked: false, missing: [], reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

export default { namedFeatureKeys, checkFeatureKeysAtStartup };
