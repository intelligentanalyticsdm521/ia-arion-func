// src/shared/agency.js — THE one place in arion-func that holds the founder /
// agency tenant id.
//
// Seams audit §4 / §0 item 9. Pack 4b put this GUID behind one module in
// LUMEN (src/lib/agency.js), oliver (lib/agency.js), arion-api
// (lib/agency.js), platform-api (lib/platformTenant.js), the Portal and the
// customer app. arion-func was the one backend that had no copy of the GUID
// AND no module — so when the October pull-forward needed "who is the agency"
// here, the choice was to paste a tenth literal or to add the module. This is
// the module.
//
// TWO ENV NAMES, ONE FACT — kept byte-identical to oliver/lib/agency.js on
// purpose: oliver's lib/stripeConnect.js read PLATFORM_OWNER_TENANT_ID while
// everything else read FOUNDER_TENANT_ID, the SEAM-11 shape where setting one
// of two names configures half the code. FOUNDER_TENANT_ID is canonical; the
// other is accepted here, and only here.
//
// WHY THE LITERAL IS STILL THE DEFAULT: FOUNDER_TENANT_ID is not set in
// production app settings (checked on this pass, as pack 4b checked it on
// 09-06), so the default is what actually runs. Removing it would not force
// the config to be right; it would take the weekly digest's sender name down
// on the next deploy.

export const FOUNDER_TENANT_ID_DEFAULT = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";

/** The founder / agency tenant, UPPERCASE. Read as a function so a late-set
 *  env var (or a test) is honoured rather than frozen at import. */
export function founderTenantId(env = process.env) {
  return String(
    env?.FOUNDER_TENANT_ID || env?.PLATFORM_OWNER_TENANT_ID || FOUNDER_TENANT_ID_DEFAULT
  ).trim().toUpperCase();
}

/** Case-insensitive comparison against the founder tenant. */
export function isFounderTenantId(value, env = process.env) {
  const v = String(value || "").trim().toUpperCase();
  return !!v && v === founderTenantId(env);
}

export default { founderTenantId, isFounderTenantId, FOUNDER_TENANT_ID_DEFAULT };
