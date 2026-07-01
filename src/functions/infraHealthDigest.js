// infraHealthDigest — nightly digest email of infra state.
// G5-S10 (INFRA-MON-001 digest phase). DRY_RUN=1 default.
// Schedule: 0 31 5 * * * (5:31 UTC).
//
// Flow:
//   1. GET oliver-api /admin/infra-health/summary using INTERNAL_SERVICE_TOKEN.
//   2. Render compact HTML digest (DB size / CPU / tenant count /
//      SPARK 24h+7d / warnings).
//   3. If DRY_RUN=1 (default) → context.log the HTML and return.
//   4. If DRY_RUN=0 → POST to iadm-webhooks /api/acs/email/send with
//      category='transactional' (no List-Unsubscribe headers per D2).
//
// Env:
//   DRY_RUN                        — "1" (default) or "0".
//   OLIVER_API_BASE_URL            — e.g. https://app-oliver-api-prod-cus.azurewebsites.net
//   INTERNAL_SERVICE_TOKEN         — bearer token oliver-api accepts for
//                                    founder-equivalent internal callers.
//   INFRA_DIGEST_RECIPIENT         — recipient email (default:
//                                    intelligentanalyticsdm@gmail.com).
//   WEBHOOKS_BASE_URL              — iadm-webhooks base URL (send path).
//   IADM_WEBHOOK_KEY               — iadm-webhooks x-iadm-webhook-key.
//   IADM_WEBHOOKS_EMAIL_SEND_PATH  — optional override
//                                    (default /api/acs/email/send).

import { app } from "@azure/functions";

const REQUEST_TIMEOUT_MS = 15_000;
const EMAIL_PATH_DEFAULT = "/api/acs/email/send";
const DEFAULT_RECIPIENT = "intelligentanalyticsdm@gmail.com";

function isDryRun() {
  const v = (process.env.DRY_RUN ?? "1").trim();
  return v !== "0";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// TODO(auth): confirm the internal-service-token → founder identity path.
// Pattern mirrors LUMEN-API internal calls (x-internal-token header) but
// oliver-api /admin/* routes are documented as Bearer-authenticated for
// founder-equivalent internal callers; we send both headers so whichever
// oliver-api requires will match.
async function fetchInfraSummary(log) {
  const base = (process.env.OLIVER_API_BASE_URL || "").replace(/\/+$/, "");
  const token = (process.env.INTERNAL_SERVICE_TOKEN || "").trim();
  if (!base) {
    log("[infra-digest] OLIVER_API_BASE_URL not set — cannot fetch summary");
    return null;
  }
  if (!token) {
    log("[infra-digest] INTERNAL_SERVICE_TOKEN not set — cannot fetch summary");
    return null;
  }
  const url = `${base}/admin/infra-health/summary`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-internal-token": token,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`[infra-digest] summary HTTP ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const json = await res.json();
    return json?.data ?? json;
  } catch (err) {
    log(`[infra-digest] summary fetch failed: ${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function renderDigestHtml(summary, nowIso) {
  const s = summary || {};
  const dbSize = s.db_size_mb ?? s.dbSizeMb ?? s.db?.size_mb ?? "?";
  const dbCpu = s.db_cpu_pct ?? s.dbCpuPct ?? s.db?.cpu_pct ?? "?";
  const tenants = s.tenant_count ?? s.tenants ?? "?";
  const spark24h = s.spark_24h ?? s.spark?.last_24h ?? "?";
  const spark7d = s.spark_7d ?? s.spark?.last_7d ?? "?";
  const warnings = Array.isArray(s.warnings) ? s.warnings : [];

  const warningsHtml = warnings.length
    ? `<ul>${warnings.map((w) => `<li>${esc(typeof w === "string" ? w : w?.message || JSON.stringify(w))}</li>`).join("")}</ul>`
    : `<p style="color:#666">No warnings.</p>`;

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1A3A4A;max-width:640px;margin:0 auto;padding:16px">
  <h2 style="margin:0 0 12px">IA Infra Health Digest &mdash; ${esc(nowIso.slice(0, 10))}</h2>
  <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;margin-bottom:16px">
    <tr>
      <td style="border:1px solid #e5e7eb;background:#f9fafb"><strong>DB size</strong></td>
      <td style="border:1px solid #e5e7eb">${esc(dbSize)} MB</td>
    </tr>
    <tr>
      <td style="border:1px solid #e5e7eb;background:#f9fafb"><strong>DB CPU</strong></td>
      <td style="border:1px solid #e5e7eb">${esc(dbCpu)}%</td>
    </tr>
    <tr>
      <td style="border:1px solid #e5e7eb;background:#f9fafb"><strong>Tenants</strong></td>
      <td style="border:1px solid #e5e7eb">${esc(tenants)}</td>
    </tr>
    <tr>
      <td style="border:1px solid #e5e7eb;background:#f9fafb"><strong>SPARK sends (24h)</strong></td>
      <td style="border:1px solid #e5e7eb">${esc(spark24h)}</td>
    </tr>
    <tr>
      <td style="border:1px solid #e5e7eb;background:#f9fafb"><strong>SPARK sends (7d)</strong></td>
      <td style="border:1px solid #e5e7eb">${esc(spark7d)}</td>
    </tr>
  </table>
  <h3 style="margin:0 0 6px">Warnings</h3>
  ${warningsHtml}
  <p style="color:#999;font-size:12px;margin-top:16px">Generated by infraHealthDigest at ${esc(nowIso)}</p>
</body></html>`;
}

async function sendDigestEmail({ html, subject, log }) {
  const base = (process.env.WEBHOOKS_BASE_URL || process.env.WEBHOOK_BASE_URL || "").trim();
  const key = (process.env.IADM_WEBHOOK_KEY || "").trim();
  if (!base || !key) {
    log("[infra-digest] WEBHOOKS_BASE_URL and IADM_WEBHOOK_KEY must be set — skipping send");
    return { sent: false, reason: "missing_webhook_env" };
  }
  const path = (process.env.IADM_WEBHOOKS_EMAIL_SEND_PATH || EMAIL_PATH_DEFAULT).trim();
  const url = `${base.replace(/\/$/, "")}${path.startsWith("/") ? "" : "/"}${path}`.replace(/\/\/api\//, "/api/");
  const recipient = (process.env.INFRA_DIGEST_RECIPIENT || DEFAULT_RECIPIENT).trim();

  const body = {
    to: [recipient],
    subject,
    html,
    category: "transactional",
    source: "infra-health-digest",
    correlationId: `infra-digest-${Date.now()}`,
  };

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iadm-webhook-key": key,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const respText = await res.text().catch(() => "");
    if (!res.ok) {
      log(`[infra-digest] webhook HTTP ${res.status}: ${respText.slice(0, 200)}`);
      return { sent: false, status: res.status };
    }
    log(`[infra-digest] sent to ${recipient}`);
    return { sent: true };
  } catch (err) {
    log(`[infra-digest] send failed: ${err?.message || err}`);
    return { sent: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

app.timer("infraHealthDigest", {
  schedule: "0 31 5 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    const log = (m) => context.log(m);
    const dry = isDryRun();
    log(`[infra-digest] starting dryRun=${dry} scheduleStatus=${JSON.stringify(timer.scheduleStatus || {})}`);

    let summary = null;
    try {
      summary = await fetchInfraSummary(log);
    } catch (err) {
      log(`[infra-digest] unexpected fetch error: ${err?.message || err}`);
    }

    const nowIso = new Date().toISOString();
    const html = renderDigestHtml(summary, nowIso);
    const subject = `IA Infra Health Digest — ${nowIso.slice(0, 10)}`;

    if (dry) {
      log("[infra-digest] DRY_RUN=1 — not sending. HTML follows:");
      log(html);
      return;
    }

    try {
      const result = await sendDigestEmail({ html, subject, log });
      log(`[infra-digest] done ${JSON.stringify(result)}`);
    } catch (err) {
      log(`[infra-digest] unexpected send error: ${err?.message || err}`);
    }
  },
});
