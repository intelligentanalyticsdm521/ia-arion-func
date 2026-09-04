// leadgenMonthlyRescore — L16, the 1st-of-the-month lead re-score tick.
//
// Wired here from the handoff file the L16 session parked in LUMEN-API
// (docs/handoff/arion-func-monthly-rescore.js) because that session did not
// own arion-func. Same schedule, same endpoint, same kill switches; the only
// changes are this repo's conventions: the internal service token comes from
// shared/secrets.js (app setting first, Key Vault second — never a literal),
// and the HTTP call is a named export so a unit test can drive it without a
// Functions host.
//
// All the work lives in LUMEN-API (services/leadgen/monthlyRescoreRun.js).
// This timer only rings the bell, exactly the way leadgenScheduledRuns and
// leadgenWeeklyDigest do — no scoring logic in arion-func, one implementation
// of the decay table, and the founder's admin button hits the same code path.
//
// Schedule: "0 29 3 1 * *" — 03:29 UTC on the 1st of every month
//   (≈ 22:29 America/Chicago on the last day of the prior month). Overnight
//   per the locked decision, and an off-peak prime minute per
//   convention_timer_schedules: hour 3 currently holds only :17
//   (marketMonitorMoves), and the monthly slot at 05:13 is monthlyPageSpeed's.
//
// The whole portfolio can take a while, so the call has a 20-minute timeout and
// LUMEN's own per-tenant lock (a unique index filtered on status='running')
// means a retry or an overlapping manual run can never double-score anyone.
//
// Settings (app settings on func-iadm-arion-prod; KV names in brackets):
//   LUMEN_API_BASE_URL                      e.g. https://app-lumen-api-prod…
//   LUMEN_INTERNAL_SERVICE_TOKEN            [LUMEN-INTERNAL-SERVICE-TOKEN]
//   LUMEN_WALKTHROUGH_SEED_TOKEN            [WALKTHROUGH-SEED-INTERNAL-TOKEN]
//                                           (routes/internal.js accepts either)
//   LEADGEN_MONTHLY_RESCORE_DISABLED=true   kill switch
//   LEADGEN_MONTHLY_RESCORE_SEND=0          re-score but send no report email

import { app } from "@azure/functions";
import { getSecret } from "../shared/secrets.js";

/** Pinned by test/leadgen-monthly-rescore.test.mjs — the handoff's contract. */
export const MONTHLY_RESCORE_SCHEDULE = "0 29 3 1 * *";
export const MONTHLY_RESCORE_PATH = "/api/v1/internal/leadgen/rescore/monthly";
export const MONTHLY_RESCORE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The shared secret routes/internal.js accepts. App setting first (getSecret
 * short-circuits to process.env), Key Vault second. No literal anywhere.
 */
export async function resolveInternalToken() {
  return (
    (await getSecret("LUMEN_INTERNAL_SERVICE_TOKEN", "LUMEN-INTERNAL-SERVICE-TOKEN")) ||
    (await getSecret("LUMEN_WALKTHROUGH_SEED_TOKEN", "WALKTHROUGH-SEED-INTERNAL-TOKEN")) ||
    (await getSecret("WALKTHROUGH_SEED_INTERNAL_TOKEN", "WALKTHROUGH-SEED-INTERNAL-TOKEN")) ||
    null
  );
}

/**
 * POST the monthly tick to LUMEN and report what came back.
 *
 * Returns { ok, ... } and never throws, so the timer logs one line either way.
 * A missing setting, a non-2xx, and a timeout are all reported as ok:false and
 * logged at error level — a failed tick must never read as a quiet success.
 */
export async function runMonthlyRescore({
  log = () => {},
  logError = () => {},
  fetchImpl = fetch,
  baseUrl = process.env.LUMEN_API_BASE_URL,
  token,
} = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const secret = token !== undefined ? token : await resolveInternalToken();
  if (!base || !secret) {
    logError(
      "[leadgen-monthly-rescore] LUMEN_API_BASE_URL and an internal service token are required"
    );
    return { ok: false, error: "not_configured" };
  }

  const send = process.env.LEADGEN_MONTHLY_RESCORE_SEND !== "0";
  let res;
  try {
    res = await fetchImpl(`${base}${MONTHLY_RESCORE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": secret },
      body: JSON.stringify({ send }),
      signal: AbortSignal.timeout(MONTHLY_RESCORE_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : err?.message;
    logError(`[leadgen-monthly-rescore] call failed: ${reason}`);
    return { ok: false, error: reason || "fetch_error" };
  }

  const body = await res.text();
  if (!res.ok) {
    // Loud, not swallowed: a failed tick must not read as a quiet success.
    logError(`[leadgen-monthly-rescore] HTTP ${res.status}: ${body.slice(0, 500)}`);
    return { ok: false, status: res.status, error: body.slice(0, 500) };
  }
  log(`[leadgen-monthly-rescore] done ${body.slice(0, 500)}`);
  return { ok: true, status: res.status, body: body.slice(0, 500) };
}

app.timer("leadgenMonthlyRescore", {
  schedule: MONTHLY_RESCORE_SCHEDULE,
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.LEADGEN_MONTHLY_RESCORE_DISABLED === "true") {
      context.log("[leadgen-monthly-rescore] disabled via LEADGEN_MONTHLY_RESCORE_DISABLED");
      return;
    }
    context.log("[leadgen-monthly-rescore] starting", { scheduleStatus: timer.scheduleStatus });
    await runMonthlyRescore({
      log: (m) => context.log(m),
      logError: (m) => context.log.error(m),
    });
  },
});
