import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";

/**
 * AI Website Builder — nightly TTL purge for arion.site_block_draft.
 *
 * Context (per batch 12 agent 2):
 *   "Discarded drafts stay in arion.site_block_draft; cleanup script can
 *    prune later."
 *
 * The block-emitter pipeline (lib/websiteBuilder/callEmitter.js in arion-api)
 * writes one row per generated block. The Portal lets the founder accept
 * (accepted=1, then the assembler injects it into Elementor) or discard
 * (accepted stays 0). Discarded rows accumulate forever unless we prune.
 *
 * Two-bucket retention so we don't surprise the founder:
 *
 *   1. UNACCEPTED drafts (accepted=0) — kept 30 days then deleted. Gives
 *      the founder a window to recover a discarded block they want back.
 *      Tunable via SITE_BLOCK_DRAFT_DISCARD_TTL_DAYS.
 *
 *   2. ACCEPTED drafts (accepted=1) — kept 90 days then deleted. Once a
 *      draft is accepted, the elementor_json was already merged into the
 *      live WP page (lib/websiteBuilder/wpInjector.js); the draft row is
 *      pure audit history at that point. 90 days is plenty for "what did
 *      we ship to this site last quarter?" reviews.
 *      Tunable via SITE_BLOCK_DRAFT_ACCEPTED_TTL_DAYS.
 *
 * Both predicates seek IX_site_block_draft_tenant_created
 * (migration 024) — created_at is the leading sort, so a date-range scan
 * is the natural plan even though the WHERE filters on accepted too.
 *
 * Schedule: "0 47 4 * * *" → 04:47 UTC daily.
 *   Off-peak (overnight US per convention_timer_schedules), prime-minute
 *   :47 sits past the existing nightly cluster (pluginSnapshot :15,
 *   marketMonitor :17/:29/:43, monthlyPageSpeed :13, domainCheckCache
 *   :23) — no stampede.
 *
 * Env overrides:
 *   SITE_BLOCK_DRAFT_CLEANUP_DISABLED=true → no-op (kill switch).
 *   SITE_BLOCK_DRAFT_CLEANUP_DRY_RUN=1     → runs full logic, COUNT only
 *                                            (no DELETE). Logs the
 *                                            would-delete counts so the
 *                                            founder can preview blast
 *                                            radius before going live.
 *   SITE_BLOCK_DRAFT_DISCARD_TTL_DAYS      → unaccepted retention (days).
 *                                            Default 30.
 *   SITE_BLOCK_DRAFT_ACCEPTED_TTL_DAYS     → accepted retention (days).
 *                                            Default 90.
 *
 * Returns / logs summary:
 *   { dryRun, discardTtlDays, acceptedTtlDays, unacceptedDeleted,
 *     acceptedDeleted, totalDeleted, durationMs }
 */
app.timer("siteBlockDraftCleanup", {
  schedule: "0 47 4 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.SITE_BLOCK_DRAFT_CLEANUP_DISABLED === "true") {
      context.log("[site-block-draft-cleanup] disabled via SITE_BLOCK_DRAFT_CLEANUP_DISABLED");
      return;
    }
    context.log("[site-block-draft-cleanup] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    const summary = await runSiteBlockDraftCleanup(pool, (m) => context.log(`[site-block-draft-cleanup] ${m}`));
    context.log("[site-block-draft-cleanup] done", summary);
  },
});

/**
 * Exported for the verifier script + future reuse. Pure function over a
 * connection pool: deletes (or counts) draft rows past their TTL and
 * returns a summary.
 *
 * @param {import("mssql").ConnectionPool} pool
 * @param {(msg: string) => void} [log]
 * @returns {Promise<{
 *   dryRun: boolean,
 *   discardTtlDays: number,
 *   acceptedTtlDays: number,
 *   unacceptedDeleted: number,
 *   acceptedDeleted: number,
 *   totalDeleted: number,
 *   durationMs: number,
 * }>}
 */
export async function runSiteBlockDraftCleanup(pool, log = () => {}) {
  const dryRun = process.env.SITE_BLOCK_DRAFT_CLEANUP_DRY_RUN === "1";
  const discardTtlDays = readPositiveInt(
    process.env.SITE_BLOCK_DRAFT_DISCARD_TTL_DAYS,
    30,
  );
  const acceptedTtlDays = readPositiveInt(
    process.env.SITE_BLOCK_DRAFT_ACCEPTED_TTL_DAYS,
    90,
  );
  const started = Date.now();

  // 1. Prune unaccepted (discarded) drafts older than the discard TTL.
  //    Founder had `discardTtlDays` days to recover them; past that they go.
  let unacceptedDeleted = 0;
  {
    const req = pool.request();
    req.input("days", discardTtlDays);
    const verb = dryRun
      ? "SELECT COUNT(*) AS n FROM arion.site_block_draft WHERE accepted = 0 AND created_at < DATEADD(DAY, -@days, SYSUTCDATETIME())"
      : "DELETE FROM arion.site_block_draft WHERE accepted = 0 AND created_at < DATEADD(DAY, -@days, SYSUTCDATETIME())";
    const result = await req.query(verb);
    unacceptedDeleted = dryRun ? (result.recordset?.[0]?.n ?? 0) : (result.rowsAffected?.[0] ?? 0);
    log(`${dryRun ? "would-delete" : "deleted"} ${unacceptedDeleted} unaccepted draft(s) older than ${discardTtlDays}d`);
  }

  // 2. Prune accepted drafts older than the accepted TTL. Their content was
  //    already injected into WP (wpInjector.js), so the row is audit-only.
  let acceptedDeleted = 0;
  {
    const req = pool.request();
    req.input("days", acceptedTtlDays);
    const verb = dryRun
      ? "SELECT COUNT(*) AS n FROM arion.site_block_draft WHERE accepted = 1 AND created_at < DATEADD(DAY, -@days, SYSUTCDATETIME())"
      : "DELETE FROM arion.site_block_draft WHERE accepted = 1 AND created_at < DATEADD(DAY, -@days, SYSUTCDATETIME())";
    const result = await req.query(verb);
    acceptedDeleted = dryRun ? (result.recordset?.[0]?.n ?? 0) : (result.rowsAffected?.[0] ?? 0);
    log(`${dryRun ? "would-delete" : "deleted"} ${acceptedDeleted} accepted draft(s) older than ${acceptedTtlDays}d`);
  }

  const summary = {
    dryRun,
    discardTtlDays,
    acceptedTtlDays,
    unacceptedDeleted,
    acceptedDeleted,
    totalDeleted: unacceptedDeleted + acceptedDeleted,
    durationMs: Date.now() - started,
  };
  return summary;
}

/**
 * Parse env-var as a positive integer; fall back to default if missing,
 * non-numeric, or <= 0. Keeps malformed config from silently nuking everything
 * (e.g. SITE_BLOCK_DRAFT_DISCARD_TTL_DAYS="" would otherwise become 0 days =
 * "delete every unaccepted row right now").
 */
function readPositiveInt(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
