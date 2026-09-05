// shared/weeklyDigestTemplate.js — F-LG.6.4 HTML email template (ESM mirror).
//
// Mirrors LUMEN-API/src/services/leadgen/weeklyDigestTemplate.js for the
// arion-func ESM timer. Keep both in sync — any styling/text change here
// belongs in the CJS sibling too. The verify script in LUMEN-API drives the
// CJS one; this exists only so the timer doesn't have to cross the module-
// system boundary at runtime.

const SPARK_LEADS_URL = "https://app.intelligentanalyticsdm.com/app/services/spark_leads";
const BRAND_PRIMARY = "#FEC82C";
const BRAND_SLATE = "#1A3A4A";
const TEXT_MUTED = "#6b7280";

// THE one last resort, imported rather than re-typed. Byte-identical to
// platform-api's NEUTRAL_BUSINESS_NAME by construction, not by discipline.
import { NEUTRAL_BUSINESS_NAME } from "./businessIdentity.js";

function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      timeZone: "UTC",
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }) + " UTC";
  } catch { return String(iso); }
}

function fmtWindow(window) {
  if (!window?.from || !window?.to) return "the past week";
  try {
    const from = new Date(window.from);
    const to = new Date(window.to);
    const end = new Date(to.getTime() - 1);
    const opts = { timeZone: "UTC", month: "short", day: "numeric" };
    return `${from.toLocaleString("en-US", opts)} — ${end.toLocaleString("en-US", { ...opts, year: "numeric" })} UTC`;
  } catch { return "the past week"; }
}

function statusBadge(status) {
  if (status === "queued") return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#d1fae5;color:#065f46;font-size:11px;font-weight:600;">Ran</span>`;
  if (status === "skipped_no_credits") return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:600;">Paused — no credits</span>`;
  if (status === "error") return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#fee2e2;color:#991b1b;font-size:11px;font-weight:600;">Error</span>`;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#e5e7eb;color:#374151;font-size:11px;font-weight:600;">${esc(status)}</span>`;
}

function renderRunsTable(runs) {
  if (!runs?.length) return `<p style="color:${TEXT_MUTED};font-size:14px;margin:8px 0 0 0;">No scheduled runs in this window.</p>`;
  const rows = runs.map((r) => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:14px;color:${BRAND_SLATE};">${esc(r.profile_name)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:13px;color:${TEXT_MUTED};white-space:nowrap;">${esc(fmtDate(r.ran_at))}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;font-size:14px;color:${BRAND_SLATE};text-align:right;font-variant-numeric:tabular-nums;">${esc(String(r.leads_found))}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #f3f4f6;text-align:right;">${statusBadge(r.status)}</td>
    </tr>`).join("");
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:8px;">
      <thead>
        <tr>
          <th align="left" style="padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${TEXT_MUTED};border-bottom:1px solid #e5e7eb;">Search profile</th>
          <th align="left" style="padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${TEXT_MUTED};border-bottom:1px solid #e5e7eb;">Ran</th>
          <th align="right" style="padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${TEXT_MUTED};border-bottom:1px solid #e5e7eb;">Leads</th>
          <th align="right" style="padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${TEXT_MUTED};border-bottom:1px solid #e5e7eb;">Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function statCard(label, value, tone = "default") {
  const valueColor = tone === "muted" ? TEXT_MUTED : BRAND_SLATE;
  return `
    <td valign="top" style="padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;width:33%;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${TEXT_MUTED};margin-bottom:6px;">${esc(label)}</div>
      <div style="font-size:28px;font-weight:700;color:${valueColor};line-height:1;">${esc(String(value))}</div>
    </td>`;
}

export function renderWeeklyDigestHtml(digest, tenantName, agencyName) {
  // October pull-forward, 2026-09-07 — TWO literals left in this file after
  // pack 4b fixed the caller, and both of them reached a client's inbox:
  //
  //   · `tenantName?.trim() || "Lead Gen"` — pack 4b's note says the
  //     "Lead Gen" fallback is gone. It is gone from the SENDER, which now
  //     resolves the business name properly; this copy of it survived here,
  //     one function call away, and would have addressed a business by our
  //     internal product name the moment the resolver returned an empty
  //     string.
  //   · the footer, which signed every digest "Intelligent Analytics" in
  //     hard-typed text.
  //
  // Both are arguments now. The last resorts are the platform's ONE neutral
  // name, so an unresolvable name reads as generic rather than as somebody
  // else's brand — and neither of them is a product codename.
  const safeTenant = tenantName?.trim() || NEUTRAL_BUSINESS_NAME;
  const safeAgency = agencyName?.trim() || NEUTRAL_BUSINESS_NAME;
  const windowLabel = fmtWindow(digest?.window);
  const runsCount = digest?.runs_count || 0;
  const skipped = digest?.runs_skipped_count || 0;
  const leadsTotal = digest?.leads_total || 0;
  const promoted = digest?.leads_promoted || 0;
  const suppressed = digest?.leads_suppressed || 0;
  const topProfile = digest?.top_search_profile_name;

  const subject = leadsTotal > 0
    ? `${safeTenant} — ${leadsTotal} new lead${leadsTotal === 1 ? "" : "s"} from ${runsCount} run${runsCount === 1 ? "" : "s"} last week`
    : `${safeTenant} — Lead Gen weekly digest`;

  const skippedBanner = skipped > 0 ? `
    <div style="margin:16px 0;padding:12px 14px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#78350f;font-size:13px;line-height:1.5;">
      <strong>${esc(String(skipped))} scheduled run${skipped === 1 ? " was" : "s were"} paused</strong> because your credit pool was empty.
      Top up to resume automated runs.
    </div>` : "";

  const topProfileLine = topProfile ? `
    <p style="margin:12px 0 0 0;font-size:14px;color:${TEXT_MUTED};">
      Top search profile this week: <strong style="color:${BRAND_SLATE};">${esc(topProfile)}</strong>.
    </p>` : "";

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND_SLATE};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <tr><td style="padding:20px 28px;background:${BRAND_SLATE};color:#ffffff;">
          <div style="font-size:11px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.8;">Weekly Digest · ${esc(windowLabel)}</div>
          <div style="font-size:22px;font-weight:700;margin-top:4px;">${esc(safeTenant)} Lead Gen</div>
        </td></tr>
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 6px 0;font-size:15px;line-height:1.5;">
            Here's a summary of the scheduled lead-gen runs that fired last week.
          </p>
          ${topProfileLine}
          ${skippedBanner}

          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:20px;border-collapse:separate;border-spacing:8px 0;">
            <tr>
              ${statCard("Runs", runsCount)}
              ${statCard("New leads", leadsTotal)}
              ${statCard("Promoted", promoted)}
            </tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:8px;border-collapse:separate;border-spacing:8px 0;">
            <tr>
              ${statCard("Suppressed", suppressed, "muted")}
              ${statCard("Paused (no credits)", skipped, skipped > 0 ? "default" : "muted")}
              <td style="width:33%;"></td>
            </tr>
          </table>

          <h3 style="margin:28px 0 0 0;font-size:14px;font-weight:600;color:${BRAND_SLATE};text-transform:uppercase;letter-spacing:0.04em;">Run detail</h3>
          ${renderRunsTable(digest?.runs || [])}

          <div style="margin-top:32px;text-align:center;">
            <a href="${SPARK_LEADS_URL}" style="display:inline-block;background:${BRAND_PRIMARY};color:${BRAND_SLATE};font-weight:700;text-decoration:none;padding:14px 28px;border-radius:6px;font-size:15px;">View leads →</a>
          </div>

          <p style="margin:24px 0 0 0;font-size:12px;color:${TEXT_MUTED};line-height:1.5;">
            You're receiving this because automated lead-gen schedules are enabled in your account.
            Adjust schedules from
            <a href="${SPARK_LEADS_URL}" style="color:${BRAND_SLATE};text-decoration:underline;">SPARK → Lead Inbox</a>.
          </p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0 0;font-size:11px;color:${TEXT_MUTED};">${esc(safeAgency)} · ${esc(new Date().getUTCFullYear())}</p>
    </td></tr>
  </table>
</body></html>`;

  const text = [
    `${safeTenant} — Lead Gen weekly digest`,
    `Window: ${windowLabel}`,
    "",
    `Runs:        ${runsCount}`,
    `New leads:   ${leadsTotal}`,
    `Promoted:    ${promoted}`,
    `Suppressed:  ${suppressed}`,
    `Paused (no credits): ${skipped}`,
    topProfile ? `Top profile: ${topProfile}` : null,
    "",
    "Run detail:",
    ...(digest?.runs || []).map((r) =>
      `  ${r.profile_name}  ·  ${fmtDate(r.ran_at)}  ·  leads=${r.leads_found}  ·  ${r.status}`),
    "",
    `View leads: ${SPARK_LEADS_URL}`,
  ].filter((x) => x !== null).join("\n");

  return { subject, html, text };
}

export { SPARK_LEADS_URL };
