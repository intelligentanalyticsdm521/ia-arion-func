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
//   LEADGEN_DIGEST_FROM_NAME     — optional display name.
//
// The owner lookup, the suppression chain and the ACS send are EXPORTED: the
// 2-business-day pre-run notice (leadgenScheduler.js) is the same email to the
// same person under the same opt-out, and a second copy of any of it would be a
// second set of rules to keep in step.
//
// IMPORTANT — parameterized SQL only. No tenant-supplied strings in queries.

import { canSend, GateUnavailable } from "./notificationGate.js";
import mssqlDefault from "mssql";
import {
  buildWeeklyDigestForTenant,
  listDigestEligibleTenants,
  priorWeekStartUtc,
} from "./weeklyDigest.js";
import { renderWeeklyDigestHtml } from "./weeklyDigestTemplate.js";
import { getPlatformPool } from "./platformPool.js";

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
  const fromName = (process.env.LEADGEN_DIGEST_FROM_NAME || "Intelligent Analytics").trim() || undefined;
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
 * Main driver — runs one weekly tick.
 *
 * @param servicesPool — connected mssql pool to iadm_services
 * @param log          — context.log forwarding
 * @param opts.now     — override current time (testing)
 * @param opts.mssql   — override mssql type (testing)
 * @returns summary { window, eligible, sent, skipped_empty, skipped_suppressed, skipped_no_owner, dry_run, errors[] }
 */
export async function runWeeklyDigestTick(servicesPool, log = () => {}, opts = {}) {
  const mssql = opts.mssql || mssqlDefault;
  const dryRun = process.env.LEADGEN_DIGEST_DRY_RUN === "1";
  const weekStart = priorWeekStartUtc(opts.now || new Date());
  const summary = {
    window: { from: weekStart.toISOString(), to: new Date(weekStart.getTime() + 7 * 86400000).toISOString() },
    eligible: 0, sent: 0, skipped_empty: 0, skipped_suppressed: 0, skipped_no_owner: 0,
    dry_run: dryRun, errors: [],
  };

  const tenants = await listDigestEligibleTenants(servicesPool, weekStart, mssql);
  summary.eligible = tenants.length;
  if (!tenants.length) {
    log(`[leadgen-digest] no eligible tenants for window ${weekStart.toISOString()}`);
    return summary;
  }

  let platformPool = null;
  try { platformPool = await getPlatformPool(); }
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

      const tenantName = owner.business_name || "Lead Gen";
      const rendered = renderWeeklyDigestHtml(digest, tenantName);

      if (dryRun) {
        log(`[leadgen-digest] DRY-RUN tenant=${t.tenant_id} to=${owner.email} subject="${rendered.subject}" htmlBytes=${rendered.html.length}`);
        summary.sent++; // count as sent-equivalent for dry-run visibility
        continue;
      }

      await sendViaWebhook({
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
