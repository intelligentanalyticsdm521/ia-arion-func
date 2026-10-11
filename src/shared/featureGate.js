// src/shared/featureGate.js — the feature catalog's rule for arion-func's
// timers.
//
// Brandon, 11 Oct 2026: "I would think we have a feature list and then a
// subscription tier list and those are synced up." The list is core.features
// (platform-api db/seed/feature_catalog.json); platform-api answers, for one
// business, payload.features[key] = { allowed: true|false|null, reason, needs,
// product, min_tier, addon, addon_min_tier, kind, availability }. A timer
// names the KEY it does work for; what tier or add-on rung the key needs lives
// only in the catalog.
//
// A timer's work is a background JOB or a model SPEND, so an undecided answer
// HOLDS: nothing is done for that business this run and it is asked again
// next run. (THE RULE, platform-api lib/featureCatalog.js featureGate, copied
// verbatim below; the same copy is in arion-api lib/featureGate.js.)
//
//   allowed true   -> run
//   allowed false  -> left out, untouched, with the reason
//   allowed null   -> held (asked again next run)
//   key missing    -> a catalog mismatch: logged at error, held
//   no payload / catalog unreadable -> held
import { fetchEntitlements } from "./productOwnership.js";

/** The intents that HOLD on an undecided answer. */
export const HOLDING_INTENTS = Object.freeze(["send", "cross_write", "spend", "job"]);

/** The SEO add-on rungs, lowest first (platform-api SEO_ADDON_RANK order). */
export const SEO_ADDON_TIERS = Object.freeze(["starter", "essentials", "growth", "authority"]);

/**
 * THE RULE, as code. A verbatim copy of platform-api lib/featureCatalog.js
 * featureGate (scope 2.3). Pure.
 */
export function featureGate(features, key, intent = "read") {
  const holds = HOLDING_INTENTS.includes(intent);
  const entry = features && Object.prototype.hasOwnProperty.call(features, key) ? features[key] : null;
  if (!entry) {
    const reason = `feature ${key} is not in the catalog answer`;
    return { action: holds ? "hold" : "run", log: "error", feature: key, reason, needs: null };
  }
  if (entry.allowed === true) return { action: "run", log: null, feature: key, reason: entry.reason, needs: null };
  if (entry.allowed === false) {
    return {
      action: "refuse", log: null, feature: key, reason: entry.reason, needs: entry.needs || null,
      body: {
        error: "feature_not_in_plan",
        feature: key,
        needs: entry.needs || null,
        message: entry.needs ? `Not in your plan. This needs ${entry.needs}.` : "Not available for this business.",
      },
    };
  }
  return { action: holds ? "hold" : "run", log: "info", feature: key, reason: entry.reason, needs: entry.needs || null };
}

/** payload.features when platform-api could read its catalog, else null. */
export function featuresOf(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.sources && payload.sources.catalog === "unreadable") return null;
  return payload.features && typeof payload.features === "object" ? payload.features : null;
}

/**
 * The decision for one business and one key. Never throws.
 * @param {object} [deps] { getEntitlements } test seam (default: platform-api)
 * @returns {Promise<{action, log, feature, reason, needs, entry: object|null}>}
 */
export async function featureDecision(tenantId, key, intent = "job", deps = {}) {
  let payload = null;
  try {
    payload = tenantId ? await (deps.getEntitlements || fetchEntitlements)(tenantId) : null;
  } catch {
    payload = null;
  }
  const features = featuresOf(payload);
  if (!features) {
    const holds = HOLDING_INTENTS.includes(intent);
    return {
      action: holds ? "hold" : "run", log: "warn", feature: key, entry: null, needs: null,
      reason: payload ? "the feature list could not be read" : "this business's plan could not be read",
    };
  }
  return { ...featureGate(features, key, intent), entry: features[key] || null };
}

/** Does a site's SEO add-on rung reach the rung a catalog row needs? required null = any rung. */
export function rungMeets(siteRung, required) {
  if (!required) return true;
  const need = SEO_ADDON_TIERS.indexOf(String(required).toLowerCase());
  if (need < 0) return true; // a rung word this code does not know is never a denial
  return SEO_ADDON_TIERS.indexOf(String(siteRung || "").trim().toLowerCase()) >= need;
}

/**
 * Of these rows, which may a timer work on for `key`? One payload read per
 * business. Rows of a business whose decision is not "run" are left out
 * (refused) or held (undecided / mismatch), untouched. `siteOk(row, entry)`
 * narrows further per row (the SEO rung).
 *
 * @returns {Promise<{ kept: any[], refused: Array<{tenantId, reason, needs}>, held: Array<{tenantId, reason}> }>}
 */
export async function keepRowsWithFeature(key, rows, opts = {}) {
  const { intent = "job", tenantOf = (r) => r?.tenant_id, getEntitlements, siteOk = () => true, log = console } = opts;
  const decisions = new Map();
  const refused = [];
  const held = [];
  const kept = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = tenantOf(row);
    const k = String(id || "").toUpperCase();
    if (!decisions.has(k)) {
      const d = await featureDecision(id, key, intent, { getEntitlements });
      decisions.set(k, d);
      if (d.action === "refuse") refused.push({ tenantId: id, reason: d.reason, needs: d.needs });
      else if (d.action === "hold") held.push({ tenantId: id, reason: d.reason });
      if (d.log === "error") log.error?.(`[featureGate] ${key} for ${id}: ${d.reason} -> ${d.action}`);
      else if (d.log && d.action !== "run") log.warn?.(`[featureGate] ${key} for ${id}: ${d.reason} -> ${d.action}`);
    }
    const d = decisions.get(k);
    if (d.action === "run" && siteOk(row, d.entry)) kept.push(row);
  }
  return { kept, refused, held };
}

export default { featureGate, featureDecision, featuresOf, rungMeets, keepRowsWithFeature, HOLDING_INTENTS, SEO_ADDON_TIERS };
