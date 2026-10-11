// shared/weeklyDigestSender.js — F-LG.6.4 Mon-morning digest run.
//
// Top-level loop:
//   1. Compute the prior-week window (Mon 00:00 UTC … +7d).
//   2. listDigestEligibleTenants(pool, weekStart) — tenants with ≥1 schedule
//      enabled AND ≥1 dispatch row in window.
//   3. For each:
//        a. buildWeeklyDigestForTenant
//        b. Skip if leads_total === 0 AND runs_skipped_count === 0
//           (no signal at all — don't spam).
//        c. Resolve tenant name + owner email via core.tenants
//           (primary_contact_email).
//        d. Suppression check: read lumen.email_suppression (master list) and
//           lumen.contact.email_unsubscribed + notification_preferences_json
//           for the `marketing` category. Skip if opted out.
//        e. Render HTML+text via renderWeeklyDigestHtml.
//        f. POST to iadm-webhooks /api/acs/email/send with the rendered
//           payload + the platform tenant id header so any per-tenant
//           guardrails in the webhook still fire.
//
// Env vars:
//   LEADGEN_DIGEST_DRY_RUN=1     — log HTML, don't POST. (verification mode.)
//   WEBHOOKS_BASE_URL            — base URL for iadm-webhooks function app.
//   IADM_WEBHOOK_KEY             — shared secret header.
//   IADM_WEBHOOKS_EMAIL_SEND_PATH (optional, default /api/acs/email/send)
//   LEADGEN_DIGEST_FROM_EMAIL    — optional override; falls back to ACS default.
//   LEADGEN_DIGEST_FROM_NAME     — optional operator OVERRIDE for the sender
//                                  display name. Unset (every environment
//                                  today) the agency's own name is resolved
//                                  through platform-api's business identity;
//                                  see shared/agencyIdentity.js.
//
// The owner lookup, the suppression chain and the ACS send are EXPORTED: the
// 2-business-day pre-run notice (leadgenScheduler.js) is the same email to the
// same person under the same opt-out, and a second copy of any of it would be a
// second set of rules to keep in step.
//
// IMPORTANT — parameterized SQL only. No tenant-supplied strings in queries.

import { canSend, GateUnavailable } from "./notificationGate.js";
import { agencyDisplayName } from "./agencyIdentity.js";
import mssqlDefault from "mssql";
import {
  buildWeeklyDigestForTenant,
  listDigestEligibleTenants,
  priorWeekStartUtc,
} from "./weeklyDigest.js";
import { renderWeeklyDigestHtml } from "./weeklyDigestTemplate.js";
import { getPlatformPool } from "./platformPool.js";
import { businessDisplayName } from "./businessIdentity.js";
import { keepRowsOfOwners, fetchEntitlements } from "./productOwnership.js";

const EMAIL_PATH_DEFAULT = "/api/acs/email/send";
const MARKETING_CATEGORY = "marketing";

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Pull tenant business_name + primary_contact_email from iadm_platform.core.tenants.
 * Returns null if the tenant row is missing — caller logs + skips.
 */
export async function resolveTenantOwner(platformPool, tenantId, mssql) {
  // core.tenants.tenant_id is UniqueIdentifier; callers pass a string UUID.
  // We try UniqueIdentifier first; fall back to NVarChar for any legacy tenants
  // whose id doesn't parse as a GUID (shouldn't happen in prod but keeps the
  // verify path robust if someone hand-rolled a tenant_id).
  let r;
  try {
    r = await platformPool.request()
      .input("tid", mssql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 business_name, primary_contact_email
                FROM core.tenants
               WHERE tenant_id = @tid`);
  } catch {
    r = await platformPool.request()
      .input("tid", mssql.NVarChar, tenantId)
      .query(`SELECT TOP 1 business_name, primary_contact_email
                FROM core.tenants
               WHERE CONVERT(NVARCHAR(50), tenant_id) = @tid`);
  }
  const row = r.recordset[0];
  if (!row) return null;
  return {
    business_name: (row.business_name || "").trim() || null,
    email: (row.primary_contact_email || "").trim().toLowerCase() || null,
  };
}

/**
 * May we email this recipient?
 *
 * 🔴 2026-09-06, seams audit §2. What used to be written out here was copy FIVE
 * of six of the same three-stage chain, and like the other four it never read
 * `marketing_optin`: a client who pressed "one click stops all marketing email"
 * kept receiving the weekly digest and the pre-run notice. It asks the ONE gate
 * now — platform-api lib/notificationGate.js over
 * POST /internal/notify/can-send — with the same `marketing` category as before.
 *
 * `servicesPool` and `mssql` are kept in the signature and ignored: both
 * callers pass them, and a Function App is not the place to be changing four
 * call sites to prove a point.
 *
 * THE FAIL DIRECTION CHANGED, DELIBERATELY. This used to fall through to
 * "allowed" when it could not read. It now returns
 * { allowed: false, reason: "gate_unavailable" }: the tenant is skipped for
 * THIS run, the summary counts it, and next Monday asks again. A digest that is
 * late is recoverable; a digest sent to somebody who unsubscribed is not.
 *
 * → { allowed: bool, reason?: string }
 */
export async function isEmailAllowed(_servicesPool, tenantId, email, _mssql) {
  if (!email) return { allowed: false, reason: "no_email_on_file" };
  try {
    const verdict = await canSend({
      tenantId, channel: "email", to: email, categoryKey: MARKETING_CATEGORY,
    });
    return { allowed: verdict.allowed, reason: verdict.reason || undefined };
  } catch (e) {
    if (!(e instanceof GateUnavailable)) throw e;
    console.warn("[leadgen-digest] gate could not decide:", e.reason);
    return { allowed: false, reason: "gate_unavailable" };
  }
}

/**
 * POST the rendered email to iadm-webhooks ACS sender.
 * Throws on non-2xx.
 */
export async function sendViaWebhook({ to, subject, html, text, tenantId, log, source = "leadgen-weekly-digest" }) {
  const base = (process.env.WEBHOOKS_BASE_URL || process.env.WEBHOOK_BASE_URL || "").trim();
  const key = (process.env.IADM_WEBHOOK_KEY || "").trim();
  if (!base || !key) throw new Error("WEBHOOKS_BASE_URL and IADM_WEBHOOK_KEY must be set");
  const path = (process.env.IADM_WEBHOOKS_EMAIL_SEND_PATH || EMAIL_PATH_DEFAULT).trim();
  const url = `${base.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`.replace(/\/\/api\//, "/api/");
  const fromEmail = (process.env.LEADGEN_DIGEST_FROM_EMAIL || "").trim() || undefined;
  // October pull-forward, 2026-09-07 — the AGENCY's name, resolved, not typed.
  //
  // This was `LEADGEN_DIGEST_FROM_NAME || "Intelligent Analytics"`. The
  // direction was right (a digest about a client's leads is sent BY the agency
  // TO the client) but the name was a literal, so a second agency running this
  // platform would sign its own clients' mail with OUR company name. Same
  // defect pack 4b removed from eleven client name chains, one step up.
  //
  // LEADGEN_DIGEST_FROM_NAME still wins when it is set: it is an operator
  // override for a specific campaign, not a fallback chain. When it is not
  // set — which is every environment today — the name comes from the one
  // business-identity resolver, for the agency's own tenant.
  const fromName = (process.env.LEADGEN_DIGEST_FROM_NAME || "").trim()
    || (await agencyDisplayName());
  const tenantHeader = (process.env.TENANT_ID_HEADER || "x-tenant-id").trim();

  const body = {
    to: [to],
    subject,
    html,
    text,
    fromEmail,
    fromName,
    source,
    correlationId: `${source}-${tenantId}-${Date.now()}`,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iadm-webhook-key": key,
      [tenantHeader]: tenantId,
    },
    body: JSON.stringify(body),
  });

  const respText = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`webhook HTTP ${res.status}: ${respText.slice(0, 200)}`);
  }
  let parsed = null;
  try { parsed = JSON.parse(respText); } catch { /* may not be JSON */ }
  log(`[${source}] sent tenant=${tenantId} messageId=${parsed?.messageId || "?"}`);
  return parsed;
}

/**
 * Is SPARK in this business's subscription, read live from the platform-api
 * payload right before a send? 'owned' | 'not_owned' | 'undecided'.
 */
export function sparkStateOf(payload) {
  const node = payload?.products?.spark || null;
  if (!payload || !node || node.decided === false) return "undecided";
  return node.owned === true ? "owned" : "not_owned";
}

/**
 * Main driver — runs one weekly tick.
 *
 * SPARK ONLY (FEATURES row 32, 11 Oct 2026): the business list is filtered by
 * SPARK ownership (checkOwnership; held entirely when it cannot be checked,
 * because this is a send), and each business is checked again LIVE on the
 * platform-api payload right before its email: decided owned sends, decided not
 * owned is skipped, undecided is held (nothing sent; next Monday asks again).
 *
 * @param servicesPool — connected mssql pool to iadm_services
 * @param log          — context.log forwarding
 * @param opts.now     — override current time (testing)
 * @param opts.mssql   — override mssql type (testing)
 * @param opts.ownership / getEntitlements / getPlatformPool / send — test
 *        seams (default: the real ones)
 * @returns summary { window, eligible, sent, skipped_empty, skipped_suppressed, skipped_no_owner, skipped_not_owned, held_undecided, dry_run, errors[] }
 */
export async function runWeeklyDigestTick(servicesPool, log = () => {}, opts = {}) {
  const mssql = opts.mssql || mssqlDefault;
  const dryRun = process.env.LEADGEN_DIGEST_DRY_RUN === "1";
  const weekStart = priorWeekStartUtc(opts.now || new Date());
  const getEnt = opts.getEntitlements || fetchEntitlements;
  const send = opts.send || sendViaWebhook;
  const summary = {
    window: { from: weekStart.toISOString(), to: new Date(weekStart.getTime() + 7 * 86400000).toISOString() },
    eligible: 0, sent: 0, skipped_empty: 0, skipped_suppressed: 0, skipped_no_owner: 0,
    skipped_not_owned: 0, held_undecided: 0, productOff: null,
    dry_run: dryRun, errors: [],
  };

  const listed = await listDigestEligibleTenants(servicesPool, weekStart, mssql);
  summary.eligible = listed.length;
  if (!listed.length) {
    log(`[leadgen-digest] no eligible tenants for window ${weekStart.toISOString()}`);
    return summary;
  }

  // SPARK businesses only. Held entirely when ownership cannot be checked.
  const owners = await keepRowsOfOwners("spark", listed, {
    ownership: opts.ownership, holdWhenUndecided: true, did: "no weekly lead digest was sent",
  });
  summary.productOff = owners.summary;
  if (owners.held) summary.held_undecided += owners.leftOut.length;
  else summary.skipped_not_owned += owners.leftOut.length;
  for (const s of owners.summary?.skipped || []) log(`[leadgen-digest] tenant=${s.tenantId} skipped — ${s.note}`);
  const tenants = owners.kept;

  let platformPool = null;
  try { platformPool = await (opts.getPlatformPool || getPlatformPool)(); }
  catch (e) {
    log(`[leadgen-digest] platform DB unreachable: ${e.message} — owner lookups will fail and tenants will be skipped`);
  }

  for (const t of tenants) {
    try {
      const digest = await buildWeeklyDigestForTenant(servicesPool, t.tenant_id, weekStart, mssql);
      if (!digest) { summary.skipped_empty++; continue; }

      // No signal — no email (anti-spam rule).
      if ((digest.leads_total || 0) === 0 && (digest.runs_skipped_count || 0) === 0) {
        summary.skipped_empty++;
        log(`[leadgen-digest] tenant=${t.tenant_id} skipped (no leads, no pauses)`);
        continue;
      }

      // Owner resolution.
      let owner = null;
      if (platformPool) {
        try { owner = await resolveTenantOwner(platformPool, t.tenant_id, mssql); }
        catch (e) { log(`[leadgen-digest] tenant=${t.tenant_id} owner lookup error: ${e.message}`); }
      }
      if (!owner?.email) {
        summary.skipped_no_owner++;
        log(`[leadgen-digest] tenant=${t.tenant_id} skipped (no primary_contact_email)`);
        continue;
      }

      // Suppression.
      const sup = await isEmailAllowed(servicesPool, t.tenant_id, owner.email, mssql);
      if (!sup.allowed) {
        summary.skipped_suppressed++;
        log(`[leadgen-digest] tenant=${t.tenant_id} skipped (${sup.reason})`);
        continue;
      }

      // SEAM-10 (seams pack 4b) — the ONE resolver. This fell back to the
      // literal "Lead Gen": a business whose name was not recorded got a
      // weekly digest addressed to OUR INTERNAL PRODUCT NAME. Same class of
      // failure as the "Intelligent Analytics" fallback pack 1 removed from
      // LUMEN, and in a client-facing email either way.
      const tenantName = await businessDisplayName(t.tenant_id);
      // The footer signs the email as the AGENCY, the heading names the
      // CLIENT. Both were literals in the template until 2026-09-07; both are
      // resolved now, and both are cached for the whole run (one call each).
      const agencyName = await agencyDisplayName();
      const rendered = renderWeeklyDigestHtml(digest, tenantName, agencyName);

      // LIVE SPARK check, right before the send (the list check above may be
      // a minute old, and a SEND never goes out on "we do not know").
      let payload = null;
      try { payload = await getEnt(t.tenant_id); } catch { payload = null; }
      const spark = sparkStateOf(payload);
      if (spark === "not_owned") {
        summary.skipped_not_owned++;
        log(`[leadgen-digest] tenant=${t.tenant_id} skipped — SPARK is not in this business's subscription`);
        continue;
      }
      if (spark === "undecided") {
        summary.held_undecided++;
        console.warn(`[leadgen-digest] tenant=${t.tenant_id} held — could not confirm the SPARK subscription, so nothing was sent; next run asks again`);
        continue;
      }

      if (dryRun) {
        log(`[leadgen-digest] DRY-RUN tenant=${t.tenant_id} to=${owner.email} subject="${rendered.subject}" htmlBytes=${rendered.html.length}`);
        summary.sent++; // count as sent-equivalent for dry-run visibility
        continue;
      }

      await send({
        to: owner.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tenantId: t.tenant_id,
        log,
      });
      summary.sent++;
    } catch (err) {
      summary.errors.push({ tenant_id: t.tenant_id, error: err.message });
      log(`[leadgen-digest] tenant=${t.tenant_id} send error: ${err.message}`);
    }
  }

  log(`[leadgen-digest] tick done ${JSON.stringify(summary)}`);
  return summary;
}
