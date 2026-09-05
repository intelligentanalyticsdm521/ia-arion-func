// src/shared/agencyIdentity.js — "what is the AGENCY called?"
//
// October pull-forward, 2026-09-07. The weekly Lead Gen digest signed itself
// with a string literal:
//
//     process.env.LEADGEN_DIGEST_FROM_NAME || "Intelligent Analytics"
//
// and its footer with another one. The DIRECTION was right — a digest about a
// client's leads is sent BY the agency TO the client, so the sender is the
// agency and not the client — but the agency's name was typed into the code.
// That is the same defect pack 4b removed from eleven CLIENT name chains, one
// step up: this platform is an agency platform, and a second agency running it
// would sign its clients' mail with our company name.
//
// ── ONE ANSWER, NOT A TENTH CHAIN ───────────────────────────────────────────
// The name comes from platform-api's business-identity route, through
// src/shared/businessIdentity.js — the same resolver, the same chain
// (preferred_business_name → business_name → full_name → name → the neutral
// one), for the agency's own tenant instead of the client's. There is no `||`
// in this file and there must never be one.
//
// ── THE CACHE ───────────────────────────────────────────────────────────────
// There is deliberately NO second cache here. getBusinessIdentity already
// holds a 60-second per-tenant cache with last-known-good on failure, and this
// module always asks it for the SAME tenant, so a digest run over 40 client
// businesses makes ONE call to platform-api and 39 cache hits. A second TTL
// layered on top would be two clocks to reason about and two places to be
// wrong — the exact shape this pack exists to remove. The comment is here so
// the next person does not "fix" the missing cache.
//
// ── WHICH AGENCY ────────────────────────────────────────────────────────────
// The FOUNDER tenant, from src/shared/agency.js. Today that is the only agency
// on the platform, and migration 138's tenant_kind model is what will make
// "the agency serving THIS client" answerable per client (oliver's
// lib/agency.js resolveAgencyTenantId already does it, over core.tenants). The
// one-line change when a second agency exists is to take the client tenant id
// as an argument and resolve its provider first; the sender's name comes from
// this same call either way. Left deliberately un-built rather than
// half-built: arion-func has no agency resolver and adding one that no data
// exercises would be a second untested path through the same question.
//
// NEVER THROWS. The caller is about to send a client's weekly digest.

import { businessDisplayName, NEUTRAL_BUSINESS_NAME } from "./businessIdentity.js";
import { founderTenantId } from "./agency.js";

/**
 * The agency's display name, for a From: header or an email footer.
 *
 * @param {{fetchImpl?:Function, now?:Function, log?:object, env?:object}} [opts]
 * @returns {Promise<string>} never empty, never throws
 */
export async function agencyDisplayName(opts = {}) {
  const tenantId = founderTenantId(opts.env || process.env);
  const name = await businessDisplayName(tenantId, opts);
  // businessDisplayName already guarantees a non-empty string (the neutral one
  // when the platform has never answered). This is belt-and-braces for a
  // caller that injects a fetch: an empty From: name is a broken header, and a
  // broken header is worse than a generic one.
  return (typeof name === "string" && name.trim()) ? name.trim() : NEUTRAL_BUSINESS_NAME;
}

export { NEUTRAL_BUSINESS_NAME };
export default { agencyDisplayName, NEUTRAL_BUSINESS_NAME };
