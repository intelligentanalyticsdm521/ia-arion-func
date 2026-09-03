// shared/leadgenNoticeTemplate.js — render a system email template from the DB.
//
// The pre-run notice's wording lives in lumen.email_template
// ('leadgen.pre_run_notice', seeded by LUMEN migration 144), exactly like every
// other customer-facing email, so Brandon can edit it in Template Studio
// without a deploy and a tenant can override it with its own row.
//
// LUMEN-API renders these through lib/emailSender.sendByTemplateKey. The timer
// cannot call that (different process, different module system), so this is the
// smallest possible renderer: the SAME precedence (tenant row beats the system
// row) and the SAME {{dot.path}} interpolation, and nothing else — no campaign
// row, no send pipeline. The send itself goes through the digest's proven ACS
// helper.

/** {{a.b.c}} → ctx.a.b.c, and an unknown tag renders as an empty string. */
export function interpolate(template, ctx) {
  if (!template) return template;
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const val = key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), ctx);
    return val == null ? "" : String(val);
  });
}

/**
 * Fetch + render one template.
 *
 * @returns {Promise<{subject:string, html:string, text:string}|null>} null when
 *          neither a tenant row nor a system row exists — the caller logs and
 *          sends nothing rather than inventing wording of its own.
 */
export async function renderTemplate(servicesPool, tenantId, templateKey, ctx, mssql) {
  const r = await servicesPool.request()
    .input("tenantId", mssql.NVarChar, tenantId)
    .input("key", mssql.NVarChar, templateKey)
    .query(`
      SELECT TOP 1 subject, body_html, body_text
        FROM lumen.email_template
       WHERE template_key = @key
         AND is_active = 1
         AND (tenant_id = @tenantId OR is_system = 1)
       ORDER BY CASE WHEN tenant_id = @tenantId THEN 0 ELSE 1 END`);
  const tpl = r.recordset[0];
  if (!tpl) return null;
  return {
    subject: interpolate(tpl.subject, ctx),
    html: interpolate(tpl.body_html, ctx),
    text: interpolate(tpl.body_text, ctx),
  };
}
