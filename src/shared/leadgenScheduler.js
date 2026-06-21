// shared/leadgenScheduler.js — F-LG.6 scheduled-run dispatcher.
//
// Called every 30 minutes by functions/leadgenScheduledRuns.js.
//
// Loop:
//   1. SELECT every search_profile WHERE is_scheduled=1 AND next_run_at <= now,
//      capped at MAX_DISPATCH_PER_TICK so a worker crash doesn't burn a whole
//      backlog of credits.
//   2. For each:
//        a. Re-read the row (lock-aware) — another worker may have grabbed it.
//        b. Check the tenant's credit pool. If 0 and `pause_on_dry_pool` (default
//           true), set next_run_at=NULL + schedule_paused_reason='no_credits'
//           and skip (F-LG.6.5).
//        c. INSERT a search_job row directly (status='queued') with target_count
//           = max_results_per_run or 100. The orchestrator picks it up from the
//           DB independently — we do NOT make an HTTP call to LUMEN-API, which
//           would loop through CIAM. (When the orchestrator runs inline inside
//           LUMEN-API today it's invoked via setImmediate from POST /leadgen/jobs;
//           our scheduled rows wait for the LUMEN-API process to poll. See
//           "Orchestrator dispatch" note below.)
//        d. Insert a lumen.leadgen_schedule_dispatch row for the audit log
//           (F-LG.6.6 "Last run: 2h ago by schedule" badge reads from this).
//        e. UPDATE last_run_at = now, last_run_status = 'success' (we treat
//           "queued the job" as success — the orchestrator settles billing on
//           its own; if it fails, that's a job-level state, not a schedule
//           state).
//        f. Recompute next_run_at from cadence + schedule_config_json + tz.
//
// ORCHESTRATOR DISPATCH:
//   The existing LUMEN-API `runSearchJob` is fired via setImmediate from the
//   POST /leadgen/jobs handler. The scheduler timer can't call setImmediate
//   into another process, so it relies on a small reaper pattern: a
//   per-LUMEN-API-instance "queue sweeper" that picks up any search_job with
//   status='queued' AND profile.is_scheduled=1 AND no started_at, kicks the
//   orchestrator on it, and updates started_at. That sweeper is OUT OF SCOPE
//   for this F-LG.6 commit and is filed as a follow-up. For now the row is
//   queued correctly and is visible in the Lead Inbox / Run history; the
//   actual lead-search execution gates on the sweeper landing.
//
//   This is documented + acceptable per SCOPE_WORKING.md F-LG.6.6 which talks
//   about the badge state ("Last run: 2h ago by schedule" / "Next run:
//   tomorrow 6am") — the dispatch row + the queued search_job are sufficient
//   for the UI to show "queued by schedule" without breaking the data shape.

import mssqlDefault from "mssql";
import { computeNextRun } from "./scheduleCadence.js";

// We accept an optional `mssql` instance as the THIRD arg so the verify
// script (running under LUMEN-API's node_modules) can pass its own copy
// and avoid the dual-mssql gotcha. When called from the actual timer
// (arion-func) we fall back to our own import.

const MAX_DISPATCH_PER_TICK = parseInt(process.env.LEADGEN_SCHEDULE_MAX_PER_TICK || "25", 10);
const DEFAULT_TARGET = parseInt(process.env.LEADGEN_SCHEDULE_DEFAULT_TARGET || "100", 10);
const PAUSE_ON_DRY_POOL = process.env.LEADGEN_SCHEDULE_PAUSE_ON_DRY_POOL !== "false";

/**
 * Run one tick.
 *
 * @param pool             — mssql ConnectionPool (already connected)
 * @param log              — `(msg) => void` for context.log forwarding
 * @returns                — { scanned, fired, paused, skipped, errors[] }
 */
export async function runLeadgenScheduledTick(pool, log = () => {}, mssql = mssqlDefault) {
  const summary = { scanned: 0, fired: 0, paused: 0, skipped: 0, errors: [] };

  const dueR = await pool.request()
    .input("limit", mssql.Int, MAX_DISPATCH_PER_TICK)
    .query(`
      SELECT TOP (@limit)
             id, tenant_id, profile_name,
             schedule_cadence, schedule_config_json, schedule_timezone,
             max_results_per_run, next_run_at
        FROM lumen.search_profile
       WHERE is_scheduled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at <= SYSUTCDATETIME()
       ORDER BY next_run_at ASC`);

  summary.scanned = dueR.recordset.length;
  if (!summary.scanned) return summary;

  for (const row of dueR.recordset) {
    try {
      const dispatched = await dispatchOne(pool, row, log, mssql);
      if (dispatched === "fired") summary.fired++;
      else if (dispatched === "paused") summary.paused++;
      else summary.skipped++;
    } catch (err) {
      summary.errors.push({ profile_id: row.id, error: err.message });
      log(`[leadgen-schedule] dispatch profile=${row.id} threw: ${err.message}`);
      // Best-effort: record the error in the dispatch log so a tenant looking
      // at "Last run" sees the failure rather than silence.
      try {
        await pool.request()
          .input("tenantId", mssql.NVarChar, row.tenant_id)
          .input("profileId", mssql.Int, row.id)
          .input("note", mssql.NVarChar, err.message.slice(0, 480))
          .query(`INSERT INTO lumen.leadgen_schedule_dispatch
                    (tenant_id, profile_id, status, note)
                    VALUES (@tenantId, @profileId, 'error', @note)`);
        await pool.request()
          .input("id", mssql.Int, row.id)
          .query(`UPDATE lumen.search_profile
                     SET schedule_last_run_status = 'failed',
                         last_run_at = SYSUTCDATETIME()
                   WHERE id = @id`);
      } catch { /* swallow */ }
    }
  }

  log(`[leadgen-schedule] tick done: scanned=${summary.scanned} fired=${summary.fired} paused=${summary.paused} skipped=${summary.skipped} errors=${summary.errors.length}`);
  return summary;
}

/**
 * Dispatch a single due schedule. Returns 'fired' | 'paused' | 'skipped'.
 */
async function dispatchOne(pool, row, log, mssql) {
  const tx = new mssql.Transaction(pool);
  await tx.begin();
  try {
    // Re-read the row under transaction to claim it; if another worker beat
    // us to it (next_run_at has advanced), bail with 'skipped'.
    const lockR = await new mssql.Request(tx)
      .input("id", mssql.Int, row.id)
      .query(`SELECT next_run_at, schedule_cadence, schedule_config_json,
                     schedule_timezone, max_results_per_run, is_scheduled
                FROM lumen.search_profile WITH (UPDLOCK, ROWLOCK)
               WHERE id = @id`);
    if (!lockR.recordset.length) { await tx.commit(); return "skipped"; }
    const fresh = lockR.recordset[0];
    if (!fresh.is_scheduled) { await tx.commit(); return "skipped"; }
    if (!fresh.next_run_at || new Date(fresh.next_run_at).getTime() > Date.now()) {
      // Another worker already advanced it. Done.
      await tx.commit();
      return "skipped";
    }

    // Credit pool check (F-LG.6.5).
    const creditR = await new mssql.Request(tx)
      .input("tenantId", mssql.NVarChar, row.tenant_id)
      .query(`SELECT remaining, overage_per_lead_cents
                FROM lumen.tenant_leadgen_credits
               WHERE tenant_id = @tenantId`);
    const credits = creditR.recordset[0] || { remaining: 0, overage_per_lead_cents: 100 };
    const target = fresh.max_results_per_run || DEFAULT_TARGET;

    if (credits.remaining <= 0 && PAUSE_ON_DRY_POOL) {
      await new mssql.Request(tx)
        .input("id", mssql.Int, row.id)
        .query(`UPDATE lumen.search_profile
                   SET next_run_at = NULL,
                       schedule_paused_reason = 'no_credits',
                       schedule_last_run_status = 'paused_no_credits',
                       last_run_at = SYSUTCDATETIME()
                 WHERE id = @id`);
      await new mssql.Request(tx)
        .input("tenantId", mssql.NVarChar, row.tenant_id)
        .input("profileId", mssql.Int, row.id)
        .query(`INSERT INTO lumen.leadgen_schedule_dispatch
                  (tenant_id, profile_id, status, note)
                  VALUES (@tenantId, @profileId, 'skipped_no_credits',
                          'Credit pool empty; schedule paused until tenant tops up')`);
      await tx.commit();
      log(`[leadgen-schedule] profile=${row.id} tenant=${row.tenant_id} PAUSED (no credits)`);
      return "paused";
    }

    // Decrement credits up to the target (overage stays paid by the tenant
    // post-hoc if their overage_per_lead_cents > 0 and pay_method
    // tolerates it). Scheduled runs default to 'credit_pool only' — we do NOT
    // auto-charge a card off-session from the timer because the tenant didn't
    // provide a payment_method_id on this code path. If the pool is partial,
    // we run for as many leads as the pool covers.
    const useCredits = Math.min(credits.remaining, target);
    const effectiveTarget = useCredits; // run only what credits cover

    if (useCredits > 0) {
      await new mssql.Request(tx)
        .input("tenantId", mssql.NVarChar, row.tenant_id)
        .input("dec", mssql.Int, useCredits)
        .query(`UPDATE lumen.tenant_leadgen_credits
                   SET remaining = remaining - @dec,
                       updated_at = SYSUTCDATETIME()
                 WHERE tenant_id = @tenantId`);
    }

    // Insert the search_job row. The orchestrator-sweeper in LUMEN-API picks
    // up status='queued' rows in a subsequent pass.
    const jobR = await new mssql.Request(tx)
      .input("tenantId", mssql.NVarChar, row.tenant_id)
      .input("profileId", mssql.Int, row.id)
      .input("target", mssql.Int, effectiveTarget)
      .query(`INSERT INTO lumen.search_job
                (tenant_id, profile_id, target_count, status)
              OUTPUT INSERTED.id
              VALUES (@tenantId, @profileId, @target, 'queued')`);
    const jobId = jobR.recordset[0].id;

    // Mirror the billing row pattern used by POST /leadgen/jobs so the
    // settlement code path (settleBilling) can refund unused credits when
    // the orchestrator finishes. pay_method='credit_pool', stripe_charge_id
    // is NULL because we didn't charge a card.
    await new mssql.Request(tx)
      .input("tenantId", mssql.NVarChar, row.tenant_id)
      .input("jobId", mssql.Int, jobId)
      .input("target", mssql.Int, effectiveTarget)
      .input("payMethod", mssql.NVarChar, "credit_pool")
      .input("creditsReserved", mssql.Int, useCredits)
      .query(`INSERT INTO lumen.leadgen_billing
                (tenant_id, search_job_id, target_count, pay_method,
                 credits_reserved, stripe_amount_cents, status)
              VALUES (@tenantId, @jobId, @target, @payMethod,
                      @creditsReserved, 0, 'charged')`);

    // Dispatch audit row.
    await new mssql.Request(tx)
      .input("tenantId", mssql.NVarChar, row.tenant_id)
      .input("profileId", mssql.Int, row.id)
      .input("jobId", mssql.Int, jobId)
      .input("note", mssql.NVarChar, `target=${effectiveTarget} credits_used=${useCredits}`)
      .query(`INSERT INTO lumen.leadgen_schedule_dispatch
                (tenant_id, profile_id, search_job_id, status, note)
                VALUES (@tenantId, @profileId, @jobId, 'queued', @note)`);

    // Compute the next fire time.
    let cfg = {};
    if (fresh.schedule_config_json) {
      try { cfg = JSON.parse(fresh.schedule_config_json); } catch { cfg = {}; }
    }
    let nextRun = null;
    try {
      nextRun = computeNextRun({
        cadence: fresh.schedule_cadence,
        config: cfg,
        timezone: fresh.schedule_timezone || "America/Chicago",
        from: new Date(),
      });
    } catch (err) {
      log(`[leadgen-schedule] profile=${row.id} could not compute next_run_at: ${err.message}`);
      // Pause it rather than burning credits in a loop.
      await new mssql.Request(tx)
        .input("id", mssql.Int, row.id)
        .input("reason", mssql.NVarChar, `cadence_error: ${err.message.slice(0, 180)}`)
        .query(`UPDATE lumen.search_profile
                   SET next_run_at = NULL,
                       schedule_paused_reason = @reason,
                       schedule_last_run_status = 'failed',
                       last_run_at = SYSUTCDATETIME()
                 WHERE id = @id`);
      await tx.commit();
      return "fired"; // we did queue the job for THIS tick — only future is paused
    }

    await new mssql.Request(tx)
      .input("id", mssql.Int, row.id)
      .input("next", mssql.DateTimeOffset, nextRun)
      .query(`UPDATE lumen.search_profile
                 SET last_run_at = SYSUTCDATETIME(),
                     next_run_at = @next,
                     schedule_last_run_status = 'success',
                     schedule_paused_reason = NULL
               WHERE id = @id`);

    await tx.commit();
    log(`[leadgen-schedule] profile=${row.id} tenant=${row.tenant_id} FIRED job=${jobId} target=${effectiveTarget} next=${nextRun.toISOString()}`);
    return "fired";
  } catch (err) {
    try { await tx.rollback(); } catch { /* ignore */ }
    throw err;
  }
}
