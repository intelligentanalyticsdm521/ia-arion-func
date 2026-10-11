// leadgenColdReverify — F-163 (defect #234, task #234).
//
// V1.2 Pro+ cold-lead RE-VERIFY resurfacing.
//
// After N days (LEADGEN_COLD_REVERIFY_AGE_DAYS, default 14) leads whose
// composite_score sits in the borderline band 40–70 (both inclusive) get
// re-verified against F-162 SMTP probe + free liveness signals, and
// re-scored. The intent is to catch:
//   - borderline leads whose site now 4xx's         → decay
//   - borderline leads whose MX went dark           → decay
//   - borderline leads whose email now bounces      → decay
//   - borderline leads that were "unknown" and now resolve cleanly → boost
//
// This timer does NOT run the SMTP probe itself. The SMTP probe
// (LUMEN-API/src/services/leadgen/enrichment/smtpProbe.js) is a CommonJS
// module bound to LUMEN-API's mssql pool + process, and the actual
// re-scoring runs inside LUMEN-API's rescoreWorker.js
// (runQuarterlyLivenessProbe) which selects rows where
// `last_verified_at IS NULL OR older than 90 days`.
//
// The minimal-scope enqueue mechanism for F-163 is therefore:
//   → find borderline stale leads
//   → NULL out platform.lead_cache.last_verified_at
//   → LUMEN-API's existing rescoreWorker picks them up on its next run
//     (which is also the mechanism used by the quarterly probe today).
//
// This keeps the timer inside arion-func (matches convention, matches how
// leadgenScheduledRuns.js dispatches to LUMEN-API via DB row) without
// requiring a new queue table or an HTTP call into LUMEN-API.
//
// Pro+ gating: candidate leads must have at least one
// platform.lead_cache_assignment.tenant_id that owns a search_profile with
// tier IN ('pro','scale','business'). Essentials-tier leads are skipped —
// per SCOPE_WORKING.md F-LG.15/F-163 "re-verify cold leads is a separate
// Pro+ feature".
//
// Schedule: 0 47 5 * * *  (05:47 UTC)
//   Off-peak prime-minute per convention_timer_schedules. Free slot —
//   siteBlockDraftCleanup uses :47 at hour 4, and the 5-o'clock hour
//   currently uses :13/:17/:31/:37/:41/:43/:55 but NOT :47.
//
// DRY_RUN default: TRUE. Flip LEADGEN_COLD_REVERIFY_DRY_RUN=0 after two
// clean dry-run nights so Brandon can eyeball candidate counts first.
//
// Env overrides:
//   LEADGEN_COLD_REVERIFY_DISABLED=true       kill switch
//   LEADGEN_COLD_REVERIFY_DRY_RUN=0           actually flip last_verified_at
//   LEADGEN_COLD_REVERIFY_AGE_DAYS=14         staleness threshold
//   LEADGEN_COLD_REVERIFY_SCORE_MIN=40        borderline band lower bound
//   LEADGEN_COLD_REVERIFY_SCORE_MAX=70        borderline band upper bound
//   LEADGEN_COLD_REVERIFY_MAX_PER_TICK=1000   cap per run

import { app } from "@azure/functions";
import { getPlatformPool } from "../shared/platformPool.js";
import { getServicesPool } from "../shared/servicesPool.js";
import { keepRowsOfOwners } from "../shared/productOwnership.js";

const DEFAULT_AGE_DAYS = 14;
const DEFAULT_SCORE_MIN = 40;
const DEFAULT_SCORE_MAX = 70;
const DEFAULT_MAX_PER_TICK = 1000;

app.timer("leadgenColdReverify", {
  schedule: "0 47 5 * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (process.env.LEADGEN_COLD_REVERIFY_DISABLED === "true") {
      context.log("[leadgen-cold-reverify] disabled via LEADGEN_COLD_REVERIFY_DISABLED");
      return;
    }
    context.log("[leadgen-cold-reverify] starting", { scheduleStatus: timer.scheduleStatus });

    const dryRun = (process.env.LEADGEN_COLD_REVERIFY_DRY_RUN ?? "1") !== "0";
    const ageDays = parseInt(process.env.LEADGEN_COLD_REVERIFY_AGE_DAYS ?? "", 10) || DEFAULT_AGE_DAYS;
    const scoreMin = parseInt(process.env.LEADGEN_COLD_REVERIFY_SCORE_MIN ?? "", 10) || DEFAULT_SCORE_MIN;
    const scoreMax = parseInt(process.env.LEADGEN_COLD_REVERIFY_SCORE_MAX ?? "", 10) || DEFAULT_SCORE_MAX;
    const maxPerTick = parseInt(process.env.LEADGEN_COLD_REVERIFY_MAX_PER_TICK ?? "", 10) || DEFAULT_MAX_PER_TICK;

    try {
      const summary = await enqueueColdReverify(
        { dryRun, ageDays, scoreMin, scoreMax, maxPerTick },
        (m) => context.log(`[leadgen-cold-reverify] ${m}`),
      );
      context.log("[leadgen-cold-reverify] done", summary);
    } catch (err) {
      context.log.error(`[leadgen-cold-reverify] FAILED: ${err.message}`);
    }
  },
});

/**
 * Select borderline stale leads assigned to a Pro+ tenant and enqueue them
 * for LUMEN-API's rescoreWorker.runQuarterlyLivenessProbe pass by clearing
 * last_verified_at.
 *
 * platform.lead_cache lives on the platform DB; lumen.search_profile lives
 * on the services DB — so we do a two-hop lookup instead of a cross-DB
 * JOIN.
 *
 * SPARK ONLY (FEATURES row 33, 11 Oct 2026): the Pro+ business list is
 * filtered by SPARK ownership (checkOwnership, apply mode live). A business
 * whose SPARK has ended is left out, so none of the leads assigned only to it
 * are touched; undecided runs as before.
 *
 * @param {object} [deps] { getServicesPool, getPlatformPool, ownership } test seams
 */
export async function enqueueColdReverify(
  { dryRun, ageDays, scoreMin, scoreMax, maxPerTick },
  log = () => {},
  deps = {},
) {
  const started = Date.now();
  const servicesPool = await (deps.getServicesPool || getServicesPool)();
  const platformPool = await (deps.getPlatformPool || getPlatformPool)();

  // 1. Which tenants are Pro+? Read tier from lumen.search_profile — any
  //    tenant with at least one profile at pro/scale/business tier qualifies
  //    for F-163 re-verify. "essentials" tier is excluded per spec.
  const proTenantsResult = await servicesPool.request().query(`
    SELECT DISTINCT tenant_id
      FROM lumen.search_profile
     WHERE tier IN ('pro','scale','business')
  `);
  const proListed = proTenantsResult.recordset.map((r) => r.tenant_id).filter(Boolean);
  const owners = await keepRowsOfOwners("spark", proListed, {
    tenantOf: (id) => id, ownership: deps.ownership, did: "its cold leads were not re-checked",
  });
  for (const s of owners.summary?.skipped || []) log(`business ${s.tenantId}: skipped — ${s.note}`);
  const proTenantIds = owners.kept;
  log(`pro-plus tenant count: ${proTenantIds.length}${owners.leftOut.length ? ` (${owners.leftOut.length} left out: SPARK not in the subscription)` : ""}`);

  if (proTenantIds.length === 0) {
    return { dryRun, ageDays, scoreMin, scoreMax, candidates: 0, enqueued: 0, durationMs: Date.now() - started };
  }

  // 2. Find borderline stale lead_cache rows assigned to a Pro+ tenant.
  //    - score in [scoreMin, scoreMax]
  //    - last_verified_at NULL OR older than ageDays
  //    - is_expired = 0 (don't re-verify tombstoned rows)
  //    - assigned to at least one Pro+ tenant
  //
  //    Build the tenant-id IN-list as parameterised inputs to stay safe
  //    against injection even though tenant IDs are already validated
  //    upstream. mssql accepts one input per placeholder, so we generate
  //    @t0, @t1, ...
  const tenantParams = proTenantIds.map((_, i) => `@t${i}`).join(",");
  const request = platformPool.request()
    .input("size", maxPerTick)
    .input("ageDays", ageDays)
    .input("scoreMin", scoreMin)
    .input("scoreMax", scoreMax);
  proTenantIds.forEach((tid, i) => request.input(`t${i}`, tid));

  const candidateSql = `
    SELECT TOP (@size) lc.id, lc.domain, lc.composite_score, lc.last_verified_at
      FROM platform.lead_cache lc
     WHERE lc.is_expired = 0
       AND lc.composite_score BETWEEN @scoreMin AND @scoreMax
       AND (lc.last_verified_at IS NULL
            OR DATEDIFF(DAY, lc.last_verified_at, SYSUTCDATETIME()) >= @ageDays)
       AND EXISTS (
         SELECT 1
           FROM platform.lead_cache_assignment lca
          WHERE lca.cache_id = lc.id
            AND lca.tenant_id IN (${tenantParams})
       )
     ORDER BY lc.last_verified_at ASC
  `;
  const candidatesResult = await request.query(candidateSql);
  const candidates = candidatesResult.recordset;
  log(`borderline stale candidates: ${candidates.length}`);

  if (dryRun) {
    return {
      dryRun,
      ageDays,
      scoreMin,
      scoreMax,
      candidates: candidates.length,
      enqueued: 0,
      durationMs: Date.now() - started,
    };
  }

  // 3. Enqueue by clearing last_verified_at. LUMEN-API rescoreWorker's
  //    runQuarterlyLivenessProbe picks up rows where
  //    `last_verified_at IS NULL OR > 90 days`. We flip to NULL so they
  //    surface on that worker's next pass regardless of the 90-day
  //    threshold. If Brandon later wants a dedicated queue table, that
  //    lands in a separate migration + swap out this UPDATE.
  if (candidates.length === 0) {
    return { dryRun, ageDays, scoreMin, scoreMax, candidates: 0, enqueued: 0, durationMs: Date.now() - started };
  }

  const idList = candidates.map((r) => r.id).join(",");
  const upd = await platformPool.request().query(`
    UPDATE platform.lead_cache
       SET last_verified_at = NULL,
           updated_at = SYSUTCDATETIME()
     WHERE id IN (${idList})
  `);
  const enqueued = upd.rowsAffected?.[0] ?? 0;
  log(`enqueued ${enqueued} rows for re-verify`);

  return {
    dryRun,
    ageDays,
    scoreMin,
    scoreMax,
    candidates: candidates.length,
    enqueued,
    durationMs: Date.now() - started,
  };
}
