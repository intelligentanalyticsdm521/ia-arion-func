// src/shared/productOwnership.js — "does this business have <product> switched on?",
// asked by every background job before it does work for a business.
//
// Scope: overnight-report/SCOPE_ACCESS_FOLLOWS_SUBSCRIPTION_2026-10-07.md §4.3
// ("Agents and timers stop"). When a business stops paying for a product, the
// product's API already refuses it (§4.1). The timers did not: the scheduled
// lead-gen dispatcher kept queueing paid lead searches, and kept emailing the
// "your run is in two days" notice, for a business whose SPARK had ended.
// Every runner now asks here, right after it has chosen its businesses, and
// leaves out the ones whose product is off.
//
// A DECLARED COPY of oliver-api lib/productOwnership.js (same rule, same SQL,
// same words), with LUMEN's ownedJsonOrNull and one addition: `deps.mssql`,
// because a verify script can hand this file a pool from LUMEN's own mssql
// copy (the dual-mssql gotcha leadgenScheduler.js describes).
//
// SPARK: THE ROW FIRST, PLATFORM-API SECOND (as in LUMEN's copy). The SPARK
// gate answers from platform-api, which counts a live Stripe SPARK item as
// owned even when the row is off or missing (platform-api lib/entitlements.js
// `owned = !!dbRow || !!stripeTier`). So a row that says "off" is only a
// question: each such business is asked of platform-api's
// /internal/entitlements/:id, and only a DECIDED "not owned" stops its lead
// searches. Unreachable, undecided or "Stripe shows SPARK" keeps it running,
// logged at error (review 2026-10-08, finding 1).
//
// THE ANSWER comes from the same table every product gate reads:
// iadm_platform core.tenant_services (+ core.services, core.tenants).
//   ON   = a row for the product with is_enabled = 1 on an active service, or
//          the business is the platform owner or an agency (never switched off
//          by the subscription, scope §1.2).
//   OFF  = the business is known and has no such row. This is the same answer
//          the product's own API gives (LUMEN's requireSparkAccess row read):
//          a business the API refuses must not get its timers either.
//
// WHEN WE DO NOT KNOW, NOTHING CHANGES. (Brandon's standing rule for this build:
// never deny on "we don't know".) If the platform database cannot be read, if it
// answers with no rows at all for a non-empty question (a wrong database or a
// half-read looks like that), or if one business is missing from core.tenants,
// that business is KEPT and the runner runs exactly as it did before this file
// existed. The reason is logged at error so a person sees it. Decided here, and
// a departure from the scope's sketch ("skip that run"): see the stream-3
// report; flipping it is the one constant UNDECIDED_RUNS_AS_BEFORE.
//
// CACHE: decided answers only, 60 seconds per product and business. A failure is
// never cached, so the next tick asks again.
import sql from "mssql";
import { platformApiUrl, platformInternalToken } from "./platformEnv.js";

// THE APPLY SWITCH (decision (a), 2026-10-08). A timer stops for an ended
// business ONLY once the entitlement sync is allowed to write:
// ENTITLEMENT_SYNC_MODE exactly 'apply', read the way oliver-api
// lib/entitlementSync.js syncModeFromEnv reads it. Unset, or anything else, is
// the dry run: the check still runs and logs which businesses WOULD stop, but
// every business runs exactly as it did before this build. Production already
// has rows switched off (Briarwood Dental, Midwest Ag Services); nothing
// changes for them on push day, only after Brandon approves the first apply.
// ONE place decides it: timerStopsLive(), applied at the end of filterOwned.
export const UNDECIDED_RUNS_AS_BEFORE = true;
export const CACHE_TTL_MS = 60 * 1000;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEPT_KINDS = new Set(["platform_owner", "agency"]);
const PRODUCT_NAMES = { oliver: "OLIVER", stella: "STELLA", spark: "SPARK", arion: "ARION" };
// The gates read their service key from these settings (requireOliverAccess,
// requireStellaAccess, requireArionAccess). The copy must read the same one,
// or a set variable would read every business as "not part of the plan".
const SERVICE_KEY_ENV = { oliver: "OLIVER_SERVICE_KEY", stella: "STELLA_SERVICE_KEY", arion: "ARION_SERVICE_KEY" };
// Products whose gate answers from platform-api (Stripe folded in), not the row.
const CONFIRM_WITH_PLATFORM = new Set(["spark"]);

/**
 * platform-api's entitlement payload for one business (the answer LUMEN's SPARK
 * gate uses), or null when it is not configured, unreachable or not 200.
 * Never throws.
 */
export async function fetchEntitlements(tenantId, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 4000 } = {}) {
  const base = platformApiUrl(env);
  const tok = platformInternalToken(env);
  if (!base || !tok || typeof fetchImpl !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/internal/entitlements/${encodeURIComponent(tenantId)}`, {
      method: "GET", headers: { "x-internal-token": tok }, signal: controller.signal,
    });
    if (!res || !res.ok) return null;
    return (await res.json()) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
const defaultGetEntitlements = (tenantId) => fetchEntitlements(tenantId);

const _cache = new Map(); // `${product}:${TENANTID}` -> { at, on, reason }

/**
 * May a timer stop for an ended business right now? Only when
 * ENTITLEMENT_SYNC_MODE is exactly 'apply' (the test oliver-api's
 * syncModeFromEnv makes).
 */
export function timerStopsLive(env = process.env) {
  return (env || {}).ENTITLEMENT_SYNC_MODE === "apply";
}

/**
 * The dry-run half of the switch: before the first apply, a business whose
 * product is off is still run for, exactly as before. It is listed in `held`
 * (and logged) so the dry run shows who WOULD stop.
 */
function holdUnlessApply(out, passed, { env, log }) {
  out.mode = timerStopsLive(env) ? "apply" : "dry_run";
  if (!out.off.length || out.mode === "apply") return out;
  out.held = out.off;
  out.off = [];
  out.owned = [...passed];
  log.log?.("[productOwnership]",
    `${productName(out.product)} is off for ${out.held.length} business(es), but timers stop only once ENTITLEMENT_SYNC_MODE is 'apply' (now: dry run), so they ran as before: ${out.held.map((o) => `${o.tenantId} (${o.reason})`).join(", ")}`);
  return out;
}

/** Forget cached answers (tests, or a founder who just switched a product back on). */
export function clearOwnershipCache() { _cache.clear(); }

const norm = (v) => String(v || "").trim().toUpperCase();
export const productName = (product) => PRODUCT_NAMES[String(product).toLowerCase()] || String(product).toUpperCase();

/** The core.services.service_key the product's gate reads (env override, as the gate does). */
export function serviceKeyFor(product, env = process.env) {
  const key = String(product || "").trim().toLowerCase();
  const name = SERVICE_KEY_ENV[key];
  const v = name ? String(env?.[name] || "").trim() : "";
  return (v || key).toLowerCase();
}

/**
 * The sentence a runner's summary carries for a business it left out: which
 * product, what did not happen, and what brings it back.
 *   ended=true  -> "SPARK has ended for this business, so the Responder did not
 *                  answer this lead. It starts again after a re-subscribe."
 *   ended=false -> "SPARK isn't part of this business's plan, so ..."
 */
export function skipSentence(product, ended, did = "nothing was run for it") {
  const p = productName(product);
  return ended
    ? `${p} has ended for this business, so ${did}. It starts again after a re-subscribe.`
    : `${p} isn't part of this business's plan, so ${did}.`;
}

/**
 * Of these businesses, which have `product` on?
 *
 * Never throws. Returns:
 *   owned     — the ids to run for, as they were passed in (order kept)
 *   off       — [{ tenantId, reason }] the ids left out, with the reason in words
 *   undecided — true when the read failed or made no sense; then owned = every id
 *   unknown   — ids missing from core.tenants (kept, logged)
 *   error     — what went wrong, when undecided
 *
 * @param {object} platformPool  connected mssql pool on iadm_platform
 * @param {'oliver'|'stella'|'spark'|'arion'} product  core.services.service_key
 * @param {Array<string>} tenantIds
 * @param {object} [deps]  { log, now } test seams
 */
export async function filterOwned(platformPool, product, tenantIds, deps = {}) {
  const { log = console, now = Date.now, mssql = sql, env = process.env } = deps;
  const key = String(product || "").trim().toLowerCase();
  const serviceKey = serviceKeyFor(key, env);
  const passed = [...(tenantIds || [])];
  const out = { product: key, owned: [], off: [], held: [], unknown: [], unconfirmed: [], undecided: false, error: null, mode: timerStopsLive(env) ? "apply" : "dry_run" };
  if (!passed.length) return out;

  const asked = [...new Set(passed.map(norm).filter((id) => GUID_RE.test(id)))];
  const verdict = new Map(); // TENANTID -> { on, reason }
  const t = now();
  const toRead = [];
  for (const id of asked) {
    const hit = _cache.get(`${serviceKey}:${id}`);
    if (hit && t - hit.at < CACHE_TTL_MS) verdict.set(id, hit);
    else toRead.push(id);
  }

  if (toRead.length) {
    let rows;
    try {
      if (!platformPool || typeof platformPool.request !== "function") throw new Error("no platform database connection");
      const r = await platformPool.request()
        .input("ids", mssql.NVarChar(mssql.MAX), JSON.stringify(toRead))
        .input("product", mssql.NVarChar(100), serviceKey)
        .query(`
          SELECT t.tenant_id, t.tenant_kind,
                 CAST(CASE WHEN EXISTS (
                   SELECT 1 FROM core.tenant_services ts
                     JOIN core.services s ON s.service_id = ts.service_id
                    WHERE ts.tenant_id = t.tenant_id
                      AND ts.is_enabled = 1 AND s.is_active = 1
                      AND LOWER(s.service_key) = @product) THEN 1 ELSE 0 END AS BIT) AS has_on,
                 CAST(CASE WHEN EXISTS (
                   SELECT 1 FROM core.tenant_services ts
                     JOIN core.services s ON s.service_id = ts.service_id
                    WHERE ts.tenant_id = t.tenant_id
                      AND LOWER(s.service_key) = @product) THEN 1 ELSE 0 END AS BIT) AS has_row
            FROM core.tenants t
           WHERE t.tenant_id IN (SELECT TRY_CAST([value] AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids))`);
      rows = r?.recordset;
      if (!Array.isArray(rows)) throw new Error("the platform database gave an answer this code does not understand");
      if (rows.length === 0) throw new Error(`the platform database knows none of the ${toRead.length} businesses asked about`);
    } catch (e) {
      out.undecided = true;
      out.error = `could not check which businesses have ${productName(key)}: ${e.message}`;
      log.error?.("[productOwnership]", `${out.error} — running for every business as before`);
      if (UNDECIDED_RUNS_AS_BEFORE) { out.owned = passed; return out; }
      out.off = passed.map((tenantId) => ({ tenantId, reason: "could not be checked" }));
      return out;
    }
    const toConfirm = [];
    for (const row of rows) {
      const id = norm(row.tenant_id);
      const kind = String(row.tenant_kind || "").trim().toLowerCase();
      let v;
      if (KEPT_KINDS.has(kind)) v = { on: true, reason: kind };
      else if (row.has_on === true || row.has_on === 1) v = { on: true, reason: "switched on" };
      else if (row.has_row === true || row.has_row === 1) v = { on: false, ended: true, reason: `${productName(key)} is switched off` };
      else v = { on: false, ended: false, reason: `${productName(key)} is not part of this business's plan` };
      if (!v.on && CONFIRM_WITH_PLATFORM.has(key)) { toConfirm.push([id, v]); continue; }
      verdict.set(id, v);
      _cache.set(`${serviceKey}:${id}`, { at: t, ...v });
    }
    // The row says off. Ask the answer the SPARK gate uses before stopping
    // anything. Only a decided "not owned" is off; anything else runs as before.
    if (toConfirm.length) {
      const getEnt = deps.getEntitlements || defaultGetEntitlements;
      await Promise.all(toConfirm.map(async ([id, v]) => {
        let payload = null;
        try { payload = await getEnt(id); } catch { payload = null; }
        const node = payload?.products?.[key] || null;
        if (!payload || payload.decided === false || !node || node.decided === false) {
          out.unconfirmed.push(id);
          return; // no verdict: kept below, never cached
        }
        const owns = typeof node.active === "boolean" ? node.active : node.owned === true;
        const final = owns ? { on: true, reason: "paid for in Stripe" } : v;
        if (owns) {
          log.error?.("[productOwnership]",
            `${productName(key)} is switched off on ${id}'s row but Stripe shows it paid for; ran for it. The entitlement sync should switch the row on.`);
        }
        verdict.set(id, final);
        _cache.set(`${serviceKey}:${id}`, { at: t, ...final });
      }));
      if (out.unconfirmed.length) {
        log.error?.("[productOwnership]",
          `could not confirm with platform-api that ${productName(key)} has ended for ${out.unconfirmed.length} business(es); ran for them as before: ${out.unconfirmed.join(", ")}`);
      }
    }
  }

  for (const original of passed) {
    const id = norm(original);
    const v = verdict.get(id);
    if (!v) {
      // Missing from core.tenants, not an id at all, or SPARK's off could not
      // be confirmed: we do not know, so we do not take it away.
      if (!out.unconfirmed.includes(id)) out.unknown.push(original);
      out.owned.push(original);
      continue;
    }
    if (v.on) out.owned.push(original);
    else out.off.push({ tenantId: original, reason: v.reason, ended: !!v.ended });
  }
  if (out.unknown.length) {
    log.error?.("[productOwnership]",
      `${out.unknown.length} business(es) not found in the platform database while checking ${productName(key)}; ran for them as before: ${out.unknown.join(", ")}`);
  }
  return holdUnlessApply(out, passed, { env, log });
}

/**
 * The runners' default: open the platform pool and ask. Never throws; a pool
 * that cannot be opened is "undecided" like any other failed read.
 *
 * @param {string} product
 * @param {Array<string>} tenantIds
 * @param {object} [deps] { getPlatformPool, log }
 */
export async function checkOwnership(product, tenantIds, deps = {}) {
  const log = deps.log || console;
  let pool;
  try {
    const get = deps.getPlatformPool || (await import("./platformPool.js")).getPlatformPool;
    pool = await get();
  } catch (e) {
    pool = null;
    log.error?.("[productOwnership]", `platform database unavailable: ${e.message}`);
  }
  const verdict = await filterOwned(pool, product, tenantIds, { log, getEntitlements: deps.getEntitlements, env: deps.env, ...(deps.mssql ? { mssql: deps.mssql } : {}) });
  if (verdict.off.length) {
    log.log?.("[productOwnership]",
      `${productName(product)} is off for ${verdict.off.length} business(es), so nothing was run for them: ${verdict.off.map((o) => `${o.tenantId} (${o.reason})`).join(", ")}`);
  }
  return verdict;
}

/**
 * For a timer that picks its rows with one SQL statement (TOP n ... ORDER BY):
 * the JSON list to bind as @owned, or null when no business is off.
 *
 *   AND (@owned IS NULL OR x.tenant_id IN (SELECT [value] FROM OPENJSON(@owned)))
 *
 * null leaves the statement exactly as it was (everyone on, or we could not
 * tell). Filtering in the statement, not after it, matters: rows of an ended
 * business that stay due would otherwise fill the TOP n every tick and starve
 * every paying business behind them.
 */
export function ownedJsonOrNull(verdict) {
  if (!verdict || !verdict.off || verdict.off.length === 0) return null;
  return JSON.stringify(verdict.owned.map((id) => String(id)));
}

/**
 * For a timer that already has its rows (sites, posts, businesses): keep the
 * rows of businesses that have `product`, leave out the rest UNTOUCHED.
 *
 * FEATURES rows 23-33 (audit 2026-10-11): every timer's list is filtered by the
 * product it serves. Uses checkOwnership (so apply mode, the agency path and
 * "unknown = runs as before" are the same everywhere).
 *
 *   holdWhenUndecided: false (default) — a check that could not be made keeps
 *     every row, as before (a background pull for the business's own data).
 *   holdWhenUndecided: true — for a SEND: when the check could not be made,
 *     NOTHING is kept; the rows stay queued and the next tick asks again.
 *
 * A row with no business id is kept (nothing to ask about; never deny on
 * "we don't know").
 *
 * @returns {Promise<{ kept: any[], leftOut: any[], held: boolean, verdict: object|null, summary: object|null }>}
 */
export async function keepRowsOfOwners(product, rows, opts = {}) {
  const {
    tenantOf = (r) => r?.tenant_id,
    ownership = null,
    did = "nothing was run for it",
    holdWhenUndecided = false,
    log = console,
  } = opts;
  const list = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(list.map(tenantOf).filter(Boolean).map(String))];
  if (!ids.length) return { kept: list.slice(), leftOut: [], held: false, verdict: null, summary: null };
  const ask = ownership || ((p, tenantIds) => checkOwnership(p, tenantIds, { log }));
  const verdict = await ask(product, ids);
  const summary = ownershipSummary(verdict, did);
  if (verdict.undecided && holdWhenUndecided) {
    log.warn?.("[productOwnership]",
      `could not check which businesses have ${productName(product)}, so nothing was sent this time; it is asked again next run`);
    return { kept: [], leftOut: list.slice(), held: true, verdict, summary };
  }
  const on = new Set((verdict.owned || []).map(norm));
  const kept = [];
  const leftOut = [];
  for (const row of list) {
    const id = tenantOf(row);
    if (!id || on.has(norm(id))) kept.push(row);
    else leftOut.push(row);
  }
  return { kept, leftOut, held: false, verdict, summary };
}

/**
 * What a runner's summary says about the check, in one object:
 *   { product, skipped: [{ tenantId, reason, ended, note }], undecided, error, unknown, unconfirmed }
 * `did` names what this runner did not do ("the Responder did not answer this
 * lead"), so the note says which job stopped and what brings it back.
 */
export function ownershipSummary(verdict, did) {
  return {
    product: verdict.product,
    mode: verdict.mode || "dry_run",
    skipped: verdict.off.map((o) => ({ tenantId: o.tenantId, reason: o.reason, ended: !!o.ended, note: skipSentence(verdict.product, !!o.ended, did) })),
    // Off, but run as before because the mode is not 'apply' yet.
    held: (verdict.held || []).map((o) => ({ tenantId: o.tenantId, reason: o.reason, ended: !!o.ended })),
    undecided: verdict.undecided,
    error: verdict.error,
    unknown: verdict.unknown,
    unconfirmed: verdict.unconfirmed || [],
  };
}

export default { filterOwned, checkOwnership, keepRowsOfOwners, timerStopsLive, ownershipSummary, skipSentence, clearOwnershipCache, productName, ownedJsonOrNull, serviceKeyFor, fetchEntitlements };
