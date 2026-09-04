// src/shared/platformEnv.js — ONE name for platform-api's address, ONE name for
// the token we send it.
//
// SEAM-11 (seams audit §11). Five spellings were live at once for two values:
//
//   address : PLATFORM_API_URL · PLATFORM_API_BASE_URL · PLATFORM_API_BASE
//   token   : PLATFORM_INTERNAL_TOKEN · PLATFORM_INTERNAL_SERVICE_TOKEN ·
//             LUMEN_INTERNAL_SERVICE_TOKEN
//
// and files in this repo disagreed about the ORDER, so the same App Service
// settings produced different answers depending on which module asked. The
// canonical names are `PLATFORM_API_URL` and `PLATFORM_INTERNAL_TOKEN`. The
// legacy names still work for one more release and warn once at startup.
//
// SCOPE — read before adding a caller. This file is about the token a service
// sends when it calls PLATFORM-API's /internal/*, and platform-api's address.
// It is NOT about:
//   · LUMEN_INTERNAL_SERVICE_TOKEN in src/functions/leadgenMonthlyRescore.js
//     and sparkCampaignAgentWeekly.js — that is LUMEN's secret, sent to LUMEN;
//     or
//   · INTERNAL_SERVICE_TOKEN in src/functions/infraHealthDigest.js, which is
//     oliver-api's.
// A different service's secret does not belong in a function called
// `platformInternalToken`.
//
// FOUR NEAR-IDENTICAL COPIES, DELIBERATELY. The same three functions exist as
// LUMEN src/lib/platformEnv.js, iadm-webhooks src/shared/platform-env.js and
// arion-func src/shared/platformEnv.js. Four runtimes (Express CommonJS, two
// Azure Functions apps, one of them ESM) share no runtime package, and adding
// one for eleven lines would be a bigger seam than the one being closed. This
// is declared the way this codebase declares its other deliberate copies —
// scripts/_tools.mjs says the same thing — and each repo's seam-11 test asserts
// the preference order matches.
//
// NEVER LOGS A VALUE. The warning names the two env vars and the file that
// still reads the legacy one. That is all anybody needs to fix it.

export const URL_NAMES = ["PLATFORM_API_URL", "PLATFORM_API_BASE_URL", "PLATFORM_API_BASE"];
export const TOKEN_NAMES = ["PLATFORM_INTERNAL_TOKEN", "PLATFORM_INTERNAL_SERVICE_TOKEN", "LUMEN_INTERNAL_SERVICE_TOKEN"];

const SHIM_PATH = "arion-func/src/shared/platformEnv.js";

/** platform-api's base URL, trailing slashes stripped. "" when unset. */
export function platformApiUrl(env = process.env) {
  for (const name of URL_NAMES) {
    const raw = String(env[name] || "").trim();
    if (raw) return raw.replace(/\/+$/, "");
  }
  return "";
}

/** The token platform-api's /internal/* accepts. "" when unset. */
export function platformInternalToken(env = process.env) {
  for (const name of TOKEN_NAMES) {
    const raw = String(env[name] || "").trim();
    if (raw) return raw;
  }
  return "";
}

function warningFor(canonical, legacy) {
  return (
    "[config] `" + legacy + "` is a legacy name for `" + canonical + "` and will be removed " +
    "after the next release. Set `" + canonical + "` in this service's configuration " +
    "(.env locally / local.settings.json / App Service application settings in Azure). " +
    "Compatibility shim: " + SHIM_PATH
  );
}

/**
 * Which legacy names is this process relying on? One warning per name, and
 * only when the canonical name is absent — a config that sets both is already
 * migrated and has nothing to fix.
 */
export function aliasWarnings(env = process.env) {
  const out = [];
  for (const names of [URL_NAMES, TOKEN_NAMES]) {
    const [canonical, ...legacy] = names;
    if (String(env[canonical] || "").trim()) continue;
    for (const name of legacy) {
      if (String(env[name] || "").trim()) out.push(warningFor(canonical, name));
    }
  }
  return out;
}

let _warned = new Set();

/** Emit each warning at most once per process. */
export function warnOnAliases(env = process.env, log = console.warn) {
  for (const w of aliasWarnings(env)) {
    if (_warned.has(w)) continue;
    _warned.add(w);
    log(w);
  }
}

/** Test seam. */
export function resetAliasWarnings() { _warned = new Set(); }
