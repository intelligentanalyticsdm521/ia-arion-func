// shared/onboardingRunner.js — drives stuck arion.site rows through the
// post-checkout phase machine that the Portal-side OnboardingRunner
// (Portal/src/lib/onboardingRunner/) polls.
//
// Why this exists
// -----------------------------------------------------------------------------
// Today the Portal Runner POSTs `/onboarding/runner/plugin-stack-swap` (etc.)
// to arion-api. Those endpoints write `arion.site.status_phase` to the
// "queued" phase (e.g. `installing_plugins`), fire an `arion.onboarding.*`
// platform event, and return. Nothing consumes those events — the row sits
// at `installing_plugins` forever and the Portal UI shows
// "Installing your tools" with no end in sight.
//
// This worker is that missing subscriber. Every 30s the timer in
// `functions/onboardingRunnerWorker.js` calls `runOnboardingTick(pool, ...)`.
// We scan for rows whose `status_phase` is one of the in-progress phases AND
// whose `updated_at` (proxy for last_phase_updated) is < 30 min old so the
// worker doesn't keep retrying ancient stuck rows the founder has to look at
// by hand anyway.
//
// Phase machine implemented here:
//
//   installing_plugins           → calls arion-api /internal/runner/advance/plugin-stack
//                                  → on success advances to creating_editor_user
//                                  → on failure marks failed (retryable)
//
//   creating_editor_user         → calls arion-api /internal/runner/advance/create-wp-user
//                                  → on success advances to configuring_seo (if SEO add-on)
//                                    or directly to connecting_google
//                                  → on failure marks failed (retryable)
//
//   configuring_seo              → calls arion-api /internal/runner/advance/configure-seo
//                                  → on success advances to connecting_google
//                                  → on failure marks failed (retryable)
//
//   connecting_google            → marks pending_user_google_oauth — this step
//                                  REQUIRES user interaction (OAuth popup).
//                                  Runner UI then shows the "Connect Google"
//                                  button. When the OAuth callback succeeds,
//                                  /onboarding/google-oauth/* writes
//                                  arion.site.gsc_connected = 1 and bumps the
//                                  phase forward; this worker re-picks it up
//                                  to advance to connecting_bing.
//
//   pending_user_google_oauth    → polled by the worker; once gsc_connected
//                                  flips to 1, advance to connecting_bing.
//                                  Idempotent — the worker re-checks each tick
//                                  and only advances when the condition lands.
//
//   connecting_bing              → marks pending_user_bing_oauth (or attempts
//                                  the IA-master auto-connect when
//                                  bing_setup_mode is 'ia_managed' / 'auto_ia').
//
//   pending_user_bing_oauth      → polled like the Google one; once the Bing
//                                  integration row reports active, advance to
//                                  ready and flip arion.site.status to 'active'.
//
// Idempotency
// -----------------------------------------------------------------------------
// EVERY phase advancement is one UPDATE statement gated on the row's CURRENT
// status_phase, e.g.
//
//   UPDATE arion.site
//      SET status_phase = @next, updated_at = SYSDATETIMEOFFSET()
//    WHERE site_id = @sid AND status_phase = @expected
//
// `rowsAffected[0]` tells us whether we won the race. If it's 0, another
// worker (or the Portal callback) already moved the row — we silently skip
// the side-effect for this tick. The same gate protects against the timer
// double-firing on a slow tick.
//
// Failure handling
// -----------------------------------------------------------------------------
// On any side-effect error we set status_phase = 'failed' and persist
// `provisioning_details_json.error_json = { phase, message, retryable }` so
// the Portal Runner UI can render a Retry button. The error_json shape is
// kept stable for the Portal's `failed` step handler.
//
// Future deferred endpoints
// -----------------------------------------------------------------------------
// The /internal/runner/advance/* endpoints this worker calls do not yet exist
// in arion-api at the time this worker landed. The worker treats a 404 as a
// "deferred — leave the row as-is, try again next tick" so deploying this
// worker BEFORE the endpoints land doesn't blow up the runner. Once the
// endpoints land the worker advances rows automatically.

import sql from "mssql";

const ARION_API_BASE = (process.env.ARION_API_BASE
  || "https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net").replace(/\/$/, "");
const ARION_INGEST_KEY = process.env.ARION_INGEST_KEY || "";

// In-progress phases the worker actively scans. Terminal phases (`ready`,
// `failed`, `consulting_migration_queued`) and user-blocking phases that
// don't need worker action (`questionnaire_saved`, `awaiting_*`) are not
// listed — the worker would have nothing to do on them.
//
// `pending_user_google_oauth` / `pending_user_bing_oauth` ARE listed so the
// worker can poll for the user's OAuth callback landing and then move
// forward to the next phase automatically.
const PHASES_THE_WORKER_HANDLES = [
  "installing_plugins",
  "creating_editor_user",
  "configuring_seo",
  "connecting_google",
  "pending_user_google_oauth",
  "connecting_bing",
  "pending_user_bing_oauth",
];

// Sites whose status_phase has been stuck for longer than this are left for
// human inspection — the worker would just keep banging on whatever underlying
// failure caused the stall. Founder dashboard ("every site stuck mid-onboarding")
// surfaces these.
const STUCK_HORIZON_MIN = Number(process.env.RUNNER_STUCK_HORIZON_MIN || "30");

// Cap rows processed per tick to keep timer execution under ~30s even if
// dozens of sites are mid-flight after a multi-tenant launch.
const MAX_ROWS_PER_TICK = Number(process.env.RUNNER_MAX_ROWS_PER_TICK || "10");

export async function runOnboardingTick(pool, { log = () => {}, fetchImpl = globalThis.fetch } = {}) {
  if (process.env.ONBOARDING_RUNNER_WORKER_DISABLED === "true") {
    log("disabled via ONBOARDING_RUNNER_WORKER_DISABLED");
    return { scanned: 0, advanced: 0, failed: 0, deferred: 0, skipped: 0 };
  }

  const rows = await loadStuckRows(pool);
  const summary = { scanned: rows.length, advanced: 0, failed: 0, deferred: 0, skipped: 0 };
  if (rows.length === 0) return summary;

  log(`scanning ${rows.length} stuck site(s)`);
  for (const row of rows) {
    try {
      const outcome = await advanceRow(pool, row, { log, fetchImpl });
      summary[outcome] = (summary[outcome] || 0) + 1;
    } catch (err) {
      // Defensive — advanceRow shouldn't throw, but if it does we don't want
      // to torpedo the whole tick.
      log(`unexpected error advancing site_id=${row.site_id}: ${err.message}`);
      summary.failed += 1;
      await markFailed(pool, row.site_id, row.status_phase, err, { retryable: true }).catch(() => {});
    }
  }
  return summary;
}

async function loadStuckRows(pool) {
  // The filtered index (IX_arion_site_status_phase_stuck) covers this exact
  // predicate so the query stays cheap even as arion.site grows.
  const phaseList = PHASES_THE_WORKER_HANDLES.map((p) => `'${p}'`).join(",");
  const r = await pool.request()
    .input("horizonMin", sql.Int, STUCK_HORIZON_MIN)
    .input("maxRows", sql.Int, MAX_ROWS_PER_TICK)
    .query(`
      SELECT TOP (@maxRows)
        s.site_id,
        s.tenant_id,
        s.domain,
        s.status_phase,
        s.status,
        s.provisioning_state,
        s.tier,
        s.arion_tier,
        s.feature_addons_json,
        s.gsc_connected,
        s.gbp_connected,
        s.google_setup_mode,
        s.bing_setup_mode,
        s.bing_ownership_transferred_at,
        s.updated_at,
        ISNULL(s.provisioning_details_json, '{}') AS provisioning_details_json
      FROM arion.site s
      WHERE s.status_phase IN (${phaseList})
        AND s.updated_at > DATEADD(MINUTE, -@horizonMin, SYSUTCDATETIME())
      ORDER BY s.updated_at ASC
    `);
  return r.recordset;
}

async function advanceRow(pool, row, { log, fetchImpl }) {
  const phase = row.status_phase;
  log(`advancing site_id=${row.site_id} domain=${row.domain || "?"} phase=${phase}`);

  switch (phase) {
    case "installing_plugins":
      return advanceInstallingPlugins(pool, row, { log, fetchImpl });
    case "creating_editor_user":
      return advanceCreatingEditorUser(pool, row, { log, fetchImpl });
    case "configuring_seo":
      return advanceConfiguringSeo(pool, row, { log, fetchImpl });
    case "connecting_google":
      return advanceConnectingGoogle(pool, row, { log });
    case "pending_user_google_oauth":
      return advancePendingGoogleOauth(pool, row, { log });
    case "connecting_bing":
      return advanceConnectingBing(pool, row, { log, fetchImpl });
    case "pending_user_bing_oauth":
      return advancePendingBingOauth(pool, row, { log });
    default:
      log(`no handler for phase=${phase} site_id=${row.site_id}`);
      return "skipped";
  }
}

/* -------------------------------------------------------------------------
 * Phase handlers
 * ------------------------------------------------------------------------- */

async function advanceInstallingPlugins(pool, row, { log, fetchImpl }) {
  const resp = await callArionAdvance(fetchImpl, "plugin-stack", {
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    domain: row.domain,
  });
  if (resp.deferred) {
    log(`installing_plugins deferred for site_id=${row.site_id} — endpoint not deployed yet`);
    return "deferred";
  }
  if (!resp.ok) {
    await markFailed(pool, row.site_id, "installing_plugins", resp.error, { retryable: resp.retryable });
    return "failed";
  }
  const won = await transitionPhase(pool, row.site_id, "installing_plugins", "creating_editor_user");
  if (won) log(`advanced site_id=${row.site_id} installing_plugins → creating_editor_user`);
  return won ? "advanced" : "skipped";
}

async function advanceCreatingEditorUser(pool, row, { log, fetchImpl }) {
  const resp = await callArionAdvance(fetchImpl, "create-wp-user", {
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    domain: row.domain,
  });
  if (resp.deferred) return "deferred";
  if (!resp.ok) {
    await markFailed(pool, row.site_id, "creating_editor_user", resp.error, { retryable: resp.retryable });
    return "failed";
  }
  // Branch on SEO add-on. arion-api/lib/seoOnboarding.configureForTier is
  // gated on the tier supporting SEO at all (essentials+). We compute the
  // gate here from arion.site.tier + feature_addons_json so the worker
  // doesn't have to import the tier matrix.
  const nextPhase = sitePicksSeoOnboarding(row) ? "configuring_seo" : "connecting_google";
  const won = await transitionPhase(pool, row.site_id, "creating_editor_user", nextPhase);
  if (won) log(`advanced site_id=${row.site_id} creating_editor_user → ${nextPhase}`);
  return won ? "advanced" : "skipped";
}

async function advanceConfiguringSeo(pool, row, { log, fetchImpl }) {
  const resp = await callArionAdvance(fetchImpl, "configure-seo", {
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    domain: row.domain,
  });
  if (resp.deferred) return "deferred";
  if (!resp.ok) {
    await markFailed(pool, row.site_id, "configuring_seo", resp.error, { retryable: resp.retryable });
    return "failed";
  }
  const won = await transitionPhase(pool, row.site_id, "configuring_seo", "connecting_google");
  if (won) log(`advanced site_id=${row.site_id} configuring_seo → connecting_google`);
  return won ? "advanced" : "skipped";
}

async function advanceConnectingGoogle(pool, row, { log }) {
  // Google connect REQUIRES user-side OAuth (we can't auto-provision GA4 /
  // GSC / GBP without it unless the site is on the ia_managed path, which
  // the dedicated google-oauth route handles separately). Mark the row as
  // waiting for the user — the Portal Runner's pending_user_oauth UI then
  // renders the Connect button.
  const isIaManaged = row.google_setup_mode === "ia_managed" || row.google_setup_mode === "auto_ia";
  const next = isIaManaged ? "pending_user_google_oauth" : "pending_user_google_oauth";
  // (ia_managed path also still surfaces a Connect step in the Runner because
  // the customer still needs to accept the GBP ownership-transfer invite;
  // we keep the same phase to avoid forking the Portal-side waitFor list.)
  const won = await transitionPhase(pool, row.site_id, "connecting_google", next);
  if (won) log(`advanced site_id=${row.site_id} connecting_google → ${next}`);
  return won ? "advanced" : "skipped";
}

async function advancePendingGoogleOauth(pool, row, { log }) {
  // Wait for the user to complete the OAuth popup. The Google OAuth callback
  // (routes/onboarding/google-oauth.js) sets gsc_connected = 1 on the
  // arion.site row once tokens are stored.
  if (!row.gsc_connected) return "skipped";
  const won = await transitionPhase(pool, row.site_id, "pending_user_google_oauth", "connecting_bing");
  if (won) log(`advanced site_id=${row.site_id} pending_user_google_oauth → connecting_bing (oauth landed)`);
  return won ? "advanced" : "skipped";
}

async function advanceConnectingBing(pool, row, { log, fetchImpl }) {
  // Bing has two paths:
  //   - byo / auto_byo  → user OAuth required, same pattern as Google
  //   - ia_managed / auto_ia → IA master account auto-connects via Bing's
  //                            AddSite API and then invites the customer.
  //                            Triggered by POSTing to the existing
  //                            arion-api auto-connect endpoint.
  const mode = (row.bing_setup_mode || "").toLowerCase();
  const isIaManaged = mode === "ia_managed" || mode === "auto_ia";
  if (isIaManaged) {
    const resp = await callArionAdvance(fetchImpl, "bing-auto-connect", {
      tenant_id: row.tenant_id,
      site_id: row.site_id,
      domain: row.domain,
    });
    if (resp.deferred) return "deferred";
    if (!resp.ok) {
      await markFailed(pool, row.site_id, "connecting_bing", resp.error, { retryable: resp.retryable });
      return "failed";
    }
    // ia_managed still needs the customer to accept the ownership-transfer
    // invitation, so we park at pending_user_bing_oauth (the Runner UI
    // surfaces "accept invitation" copy on that phase).
  }
  const won = await transitionPhase(pool, row.site_id, "connecting_bing", "pending_user_bing_oauth");
  if (won) log(`advanced site_id=${row.site_id} connecting_bing → pending_user_bing_oauth`);
  return won ? "advanced" : "skipped";
}

async function advancePendingBingOauth(pool, row, { log }) {
  // Bing OAuth doesn't populate a top-level boolean on arion.site, so we
  // join through arion.site_integration_status. status='active' for the
  // 'bing' integration means the OAuth (or ia_managed transfer) landed.
  const r = await pool.request()
    .input("sid", sql.UniqueIdentifier, row.site_id)
    .query(`
      SELECT TOP 1 status FROM arion.site_integration_status
       WHERE site_id = @sid AND integration_key = 'bing'
       ORDER BY updated_at DESC, created_at DESC
    `);
  const bingStatus = r.recordset?.[0]?.status || null;
  const transferred = row.bing_ownership_transferred_at != null;
  if (bingStatus !== "active" && !transferred) return "skipped";
  // All connectors handled — flip to ready + mark the site active.
  const won = await transitionToReady(pool, row.site_id, "pending_user_bing_oauth");
  if (won) log(`advanced site_id=${row.site_id} pending_user_bing_oauth → ready`);
  return won ? "advanced" : "skipped";
}

/* -------------------------------------------------------------------------
 * DB helpers — every advance is one gated UPDATE for idempotency.
 * ------------------------------------------------------------------------- */

async function transitionPhase(pool, siteId, expectedPhase, nextPhase) {
  const r = await pool.request()
    .input("sid", sql.UniqueIdentifier, siteId)
    .input("expected", sql.NVarChar(60), expectedPhase)
    .input("next", sql.NVarChar(60), nextPhase)
    .query(`
      UPDATE arion.site
         SET status_phase = @next,
             updated_at = SYSDATETIMEOFFSET()
       WHERE site_id = @sid AND status_phase = @expected
    `);
  return (r.rowsAffected?.[0] || 0) > 0;
}

async function transitionToReady(pool, siteId, expectedPhase) {
  const r = await pool.request()
    .input("sid", sql.UniqueIdentifier, siteId)
    .input("expected", sql.NVarChar(60), expectedPhase)
    .query(`
      UPDATE arion.site
         SET status_phase = 'ready',
             status = 'active',
             provisioning_state = CASE WHEN provisioning_state = 'failed' THEN provisioning_state ELSE 'ready' END,
             provisioned_at = COALESCE(provisioned_at, SYSUTCDATETIME()),
             updated_at = SYSDATETIMEOFFSET()
       WHERE site_id = @sid AND status_phase = @expected
    `);
  return (r.rowsAffected?.[0] || 0) > 0;
}

async function markFailed(pool, siteId, phase, error, { retryable = true } = {}) {
  const message = (error?.message || String(error || "Unknown error")).slice(0, 500);
  const errorJson = JSON.stringify({ phase, message, retryable });
  // Gated on the row currently being in the phase we think failed — prevents
  // overwriting a successful concurrent advance.
  await pool.request()
    .input("sid", sql.UniqueIdentifier, siteId)
    .input("phase", sql.NVarChar(60), phase)
    .input("errorJson", sql.NVarChar(sql.MAX), errorJson)
    .input("message", sql.NVarChar(500), message)
    .query(`
      UPDATE arion.site
         SET status_phase = 'failed',
             provisioning_details_json = JSON_MODIFY(
               JSON_MODIFY(
                 JSON_MODIFY(
                   COALESCE(provisioning_details_json, '{}'),
                   '$.error_json', JSON_QUERY(@errorJson)
                 ),
                 '$.current_phase', 'failed'
               ),
               '$.current_message', @message
             ),
             updated_at = SYSDATETIMEOFFSET()
       WHERE site_id = @sid AND status_phase = @phase
    `);
}

/* -------------------------------------------------------------------------
 * arion-api internal advance call.
 *
 * The companion arion-api endpoint contract:
 *   POST {ARION_API_BASE}/internal/runner/advance/{kind}
 *   Headers: x-arion-ingest-key: {ARION_INGEST_KEY}
 *   Body:    { tenant_id, site_id, domain }
 *   Response: 200 { ok: true } | 4xx { ok: false, error, retryable }
 *
 * We treat 404 as "deferred" so the worker can ship BEFORE the endpoints
 * land. Once the endpoints exist they take over the actual side-effect
 * work (wp-cli plugin install, wp-cli user create, seoOnboarding.configureForTier).
 * ------------------------------------------------------------------------- */

async function callArionAdvance(fetchImpl, kind, body) {
  if (!fetchImpl) return { ok: false, error: new Error("no fetch available"), retryable: true, deferred: false };
  const url = `${ARION_API_BASE}/internal/runner/advance/${kind}`;
  let resp;
  try {
    resp = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-arion-ingest-key": ARION_INGEST_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: err, retryable: true, deferred: false };
  }
  if (resp.status === 404) {
    // Endpoint not deployed yet — leave the row at its current phase and
    // try again next tick. The worker logs this so ops sees why advancement
    // hasn't started.
    return { ok: false, error: null, retryable: true, deferred: true };
  }
  let parsed = null;
  try { parsed = await resp.json(); } catch { /* non-JSON */ }
  if (!resp.ok) {
    const message = parsed?.error?.message || `arion-api advance/${kind} returned ${resp.status}`;
    const retryable = resp.status >= 500 || resp.status === 429;
    return { ok: false, error: new Error(message), retryable, deferred: false };
  }
  return { ok: true, data: parsed?.data || null, deferred: false };
}

/* -------------------------------------------------------------------------
 * SEO add-on detection — drives the creating_editor_user → configuring_seo
 * vs. → connecting_google branch.
 *
 * Tier matrix per `reference_pricing_tier_matrix` memory:
 *   starter        → no SEO baseline (still has connections)
 *   essentials     → SEO baseline (GA4/GSC/Bing); SE Ranking starts at growth
 *   growth/authority → full SEO including SE Ranking project + Market Monitor
 *
 * For the runner's purposes, "configuring_seo" means
 * lib/seoOnboarding.configureForTier — which creates the SE Ranking project,
 * seeds keywords, configures engines. That's growth+ only.
 *
 * feature_addons_json may carry an explicit `arion_seo` flag on essentials
 * tenants who bought the SEO add-on. Treat that as growth-equivalent.
 * ------------------------------------------------------------------------- */
function sitePicksSeoOnboarding(row) {
  const tier = String(row.tier || row.arion_tier || "lite").toLowerCase();
  if (tier === "growth" || tier === "authority") return true;
  if (!row.feature_addons_json) return false;
  try {
    const ad = JSON.parse(row.feature_addons_json);
    if (ad?.arion_seo || ad?.seo) return true;
  } catch { /* ignore parse */ }
  return false;
}

export const __test = {
  PHASES_THE_WORKER_HANDLES,
  sitePicksSeoOnboarding,
  loadStuckRows,
  transitionPhase,
  transitionToReady,
  markFailed,
};
