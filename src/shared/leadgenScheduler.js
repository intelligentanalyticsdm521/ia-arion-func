// shared/leadgenScheduler.js — F-LG.6 scheduled-run dispatcher + the
// 2-business-day pre-run notice (Release A.2 P5 / X1).
//
// Called every 30 minutes by functions/leadgenScheduledRuns.js. TWO passes per
// tick, in this order:
//
//   PASS 1 — dispatch: queue the runs that are due.
//   PASS 2 — notice:   email the owner about runs that are two business days
//                      out, while the settings can still be changed.
//
// Dispatch loop:
//   1. SELECT every search_profile WHERE is_scheduled=1 AND next_run_at <= now,
//      capped at MAX_DISPATCH_PER_TICK so a worker crash doesn't burn a whole
//      backlog of runs.
//   2. For each:
//        a. Re-read the row (lock-aware) — another worker may have grabbed it.
//        b. (2026-09-04, G-5) NOTHING is checked against
//           lumen.tenant_leadgen_credits any more — see the long note at the
//           former credit block. The Stripe-derived allotment is resolved by
//           LUMEN's settlement.ensureReserved when the sweeper claims the job,
//           which clamps or skips it and marks the schedule paused.
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
// P5 / X1 — the 2-business-day pre-run notice rides this same tick (no new
// timer, no new Function App: POC rule + convention_timer_schedules).
import { isWithinBusinessDays, formatRunDate } from "./businessDays.js";
import { previewMessage, strainFromSummary } from "./leadgenRunMessages.js";
import { renderTemplate } from "./leadgenNoticeTemplate.js";
import { resolveTenantOwner, isEmailAllowed, sendViaWebhook } from "./weeklyDigestSender.js";
import { getPlatformPool } from "./platformPool.js";

// We accept an optional `mssql` instance as the THIRD arg so the verify
// script (running under LUMEN-API's node_modules) can pass its own copy
// and avoid the dual-mssql gotcha. When called from the actual timer
// (arion-func) we fall back to our own import.

const MAX_DISPATCH_PER_TICK = parseInt(process.env.LEADGEN_SCHEDULE_MAX_PER_TICK || "25", 10);
const DEFAULT_TARGET = parseInt(process.env.LEADGEN_SCHEDULE_DEFAULT_TARGET || "100", 10);
const NOTICE_BUSINESS_DAYS = parseInt(process.env.LEADGEN_PRE_RUN_NOTICE_DAYS || "2", 10);
const NOTICE_TEMPLATE_KEY = "leadgen.pre_run_notice";
const PORTAL_BASE = (process.env.PUBLIC_PORTAL_URL || "https://portal.intelligentanalyticsdm.com").replace(/\/+$/, "");

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
 * PASS 2 — the 2-business-day pre-run notice (X1, LOCKED).
 *
 * Scheduled runs used to happen TO the customer: nothing between "scheduled"
 * and "fired", so a search running with the wrong location or a category that
 * has stopped producing was only discovered afterwards, on the invoice. This
 * gives two working days to change it.
 *
 * Selection:
 *   * the profile is scheduled and has a next_run_at in the future
 *   * that run is at most NOTICE_BUSINESS_DAYS business days away, counted in
 *     the profile's OWN timezone (Mon-Fri, no holiday table)
 *   * we have not already given notice for this exact run
 *     (pre_run_notice_for <> next_run_at) — so a second tick the same day sends
 *     nothing, and changing the cadence produces a fresh notice for the new date
 *
 * The soft warning rides along when the profile's LAST completed run strained
 * (summary_json.pool_strain) — a real forecast with no extra API call and no
 * pool count, per X1.
 *
 * Errors never bubble: a broken notice must not stop runs from being queued.
 *
 * @returns { scanned, sent, skipped_suppressed, skipped_no_owner, skipped_no_template, errors[] }
 */
export async function runPreRunNoticePass(pool, log = () => {}, mssql = mssqlDefault, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const out = { scanned: 0, sent: 0, skipped_suppressed: 0, skipped_no_owner: 0, skipped_no_template: 0, errors: [] };
  if (process.env.LEADGEN_PRE_RUN_NOTICE_DISABLED === "true") return out;

  // A generous SQL window (calendar days) narrowed to BUSINESS days in JS,
  // where the timezone lives. 5 calendar days always contains 2 business days.
  const dueR = await pool.request()
    .input("limit", mssql.Int, MAX_DISPATCH_PER_TICK)
    .query(`
      SELECT TOP (@limit)
             id, tenant_id, profile_name, next_run_at, schedule_timezone,
             pre_run_notice_for
        FROM lumen.search_profile
       WHERE is_scheduled = 1
         AND next_run_at IS NOT NULL
         AND next_run_at > SYSUTCDATETIME()
         AND next_run_at <= DATEADD(day, 5, SYSUTCDATETIME())
         AND (pre_run_notice_for IS NULL OR pre_run_notice_for <> next_run_at)
       ORDER BY next_run_at ASC`);

  if (!dueR.recordset.length) return out;

  let platformPool = null;
  try { platformPool = await getPlatformPool(); }
  catch (e) { log(`[leadgen-notice] platform DB unreachable: ${e.message} — no notices this tick`); return out; }

  for (const row of dueR.recordset) {
    const tz = row.schedule_timezone || "America/Chicago";
    if (!isWithinBusinessDays(now, row.next_run_at, NOTICE_BUSINESS_DAYS, tz)) continue;
    out.scanned++;
    try {
      const owner = await resolveTenantOwner(platformPool, row.tenant_id, mssql);
      if (!owner?.email) {
        out.skipped_no_owner++;
        log(`[leadgen-notice] profile=${row.id} skipped (no primary_contact_email)`);
        continue;
      }
      const allowed = await isEmailAllowed(pool, row.tenant_id, owner.email, mssql);
      if (!allowed.allowed) {
        // Opted out is final — stamp it so we stop reconsidering this run.
        await stampNoticed(pool, row, mssql);
        out.skipped_suppressed++;
        log(`[leadgen-notice] profile=${row.id} skipped (${allowed.reason})`);
        continue;
      }

      const band = await lastRunStrain(pool, row.tenant_id, row.id, mssql);
      const runDate = formatRunDate(row.next_run_at, tz);
      const ctx = {
        tenant: { name: owner.business_name || "your business" },
        run: {
          run_date: runDate,
          profile_name: row.profile_name || "your saved search",
          // The template already says "scheduled to run on <date> — check your
          // settings"; this is the soft warning that rides along when the last
          // run of this schedule strained. Empty on an ordinary schedule.
          recommendation: previewMessage(band) || "",
          settings_url: `${PORTAL_BASE}/app/spark/leadgen/saved`,
        },
      };
      const rendered = await renderTemplate(pool, row.tenant_id, NOTICE_TEMPLATE_KEY, ctx, mssql);
      if (!rendered) {
        out.skipped_no_template++;
        log(`[leadgen-notice] profile=${row.id} skipped — template ${NOTICE_TEMPLATE_KEY} missing (migration 144 not applied?)`);
        continue;
      }

      if (process.env.LEADGEN_DIGEST_DRY_RUN === "1") {
        log(`[leadgen-notice] DRY-RUN profile=${row.id} to=${owner.email} subject="${rendered.subject}"`);
      } else {
        await sendViaWebhook({
          to: owner.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          tenantId: row.tenant_id,
          log,
          source: "leadgen-pre-run-notice",
        });
      }
      // Stamp AFTER a successful send: a failed send is retried next tick
      // rather than silently skipped.
      await stampNoticed(pool, row, mssql);
      out.sent++;
      log(`[leadgen-notice] profile=${row.id} tenant=${row.tenant_id} notice sent for ${runDate} (strain=${band})`);
    } catch (err) {
      out.errors.push({ profile_id: row.id, error: err.message });
      log(`[leadgen-notice] profile=${row.id} error: ${err.message}`);
    }
  }

  log(`[leadgen-notice] pass done: ${JSON.stringify(out)}`);
  return out;
}

/** Remember which run we have already given notice for. */
async function stampNoticed(pool, row, mssql) {
  await pool.request()
    .input("id", mssql.Int, row.id)
    .input("forRun", mssql.DateTimeOffset, new Date(row.next_run_at))
    .query(`UPDATE lumen.search_profile SET pre_run_notice_for = @forRun WHERE id = @id`);
}

/**
 * The strain band of this profile's last completed run — a forecast built from
 * what actually happened, with no extra API call. Numbers stay in the DB; only
 * the band leaves this function.
 */
async function lastRunStrain(pool, tenantId, profileId, mssql) {
  try {
    const r = await pool.request()
      .input("tenantId", mssql.NVarChar, tenantId)
      .input("pid", mssql.Int, profileId)
      .query(`SELECT TOP 1 summary_json FROM lumen.search_job
               WHERE tenant_id = @tenantId AND profile_id = @pid AND status = 'completed'
               ORDER BY completed_at DESC`);
    return strainFromSummary(r.recordset[0]?.summary_json);
  } catch {
    return "none";
  }
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

    // 2026-09-04 (G-5) — THE CREDIT POOL IS NO LONGER CONSULTED HERE.
    //
    // This block used to read lumen.tenant_leadgen_credits, pause the schedule
    // when it hit zero, and decrement it. That table stopped being the truth
    // when Release A moved lead allotments to the Stripe Leads package
    // (services/leadgen/billing/leadsPackage.js): the timer paused schedules
    // for tenants who had plenty of included leads, and let others through on
    // stale credits. Two truths for one fact.
    //
    // Now the scheduler only asks "is this profile due?" and queues the job.
    // LUMEN's sweeper calls settlement.ensureReserved, which resolves the
    // Stripe-derived allotment, CLAMPS the target to what is actually
    // schedulable, and skips the run when there is nothing left — writing
    // schedule_last_run_status='paused_no_credits' so Saved Searches and the
    // weekly digest still show "paused". One truth, in the place that owns it.
    const target = fresh.max_results_per_run || DEFAULT_TARGET;
    const effectiveTarget = target;

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

    // NO billing row is written here any more. Writing one made
    // ensureReserved's "does this job already have a reservation?" check say
    // yes, so the clamp against the Stripe allotment never ran — the very
    // drift this change removes. The sweeper reserves the job when it claims it.

    // Dispatch audit row.
    await new mssql.Request(tx)
      .input("tenantId", mssql.NVarChar, row.tenant_id)
      .input("profileId", mssql.Int, row.id)
      .input("jobId", mssql.Int, jobId)
      .input("note", mssql.NVarChar, `target=${effectiveTarget}`)
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
