#!/usr/bin/env node
/**
 * Verifier — AI Website Builder nightly draft purge.
 *
 * Inserts 5 sentinel arion.site_block_draft rows with old created_at (mix
 * of unaccepted + accepted, all past their respective TTLs), runs
 * runSiteBlockDraftCleanup(), and asserts all 5 were deleted. Cleans up
 * stragglers on exit even when assertions fail.
 *
 * Sentinel rows are tagged via a process-unique tenant_id so we never
 * touch a real tenant's drafts.
 *
 * Usage:
 *   node scripts/verify-site-block-draft-cleanup.mjs
 *
 * Env (same conventions as the timer):
 *   SERVICES_SQL_SERVER   (or SQL_SERVER)
 *   SERVICES_SQL_DATABASE (default "iadm_services")
 *   AUTH_MODE             default "LOCAL_DEV" → DefaultAzureCredential
 *
 * Returns exit code 0 on pass, 1 on any assertion failure or thrown error.
 */
import "dotenv/config";
import crypto from "node:crypto";
import { getServicesPool } from "../src/shared/servicesPool.js";
import { runSiteBlockDraftCleanup } from "../src/functions/siteBlockDraftCleanup.js";

// Process-unique sentinel tenant — every row written by this verifier uses
// this exact tenant_id, so the final cleanup is a single tenant_id = ? sweep.
// Random UUIDv4 ensures no collision with any real tenant.
const SENTINEL_TENANT = crypto.randomUUID();
const SENTINEL_SITE = crypto.randomUUID();

// 3 unaccepted (older than 30d) + 2 accepted (older than 90d) = 5 total
const FAKE_ROWS = [
  { kind: "hero",         accepted: 0, daysOld: 31  },
  { kind: "services",     accepted: 0, daysOld: 45  },
  { kind: "testimonials", accepted: 0, daysOld: 60  },
  { kind: "hero",         accepted: 1, daysOld: 91  },
  { kind: "services",     accepted: 1, daysOld: 120 },
];

function log(msg) {
  console.log(`[verify] ${msg}`);
}

async function cleanupSentinels(pool) {
  const req = pool.request();
  req.input("tenant", SENTINEL_TENANT);
  const r = await req.query("DELETE FROM arion.site_block_draft WHERE tenant_id = @tenant");
  return r.rowsAffected?.[0] ?? 0;
}

async function main() {
  if (process.env.SITE_BLOCK_DRAFT_CLEANUP_DRY_RUN === "1") {
    throw new Error("verifier must NOT run with SITE_BLOCK_DRAFT_CLEANUP_DRY_RUN=1 — it asserts real deletes");
  }

  log(`connecting to SQL (${process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER} / ${process.env.SERVICES_SQL_DATABASE || "iadm_services"})`);
  const pool = await getServicesPool();

  // Defensive: if a previous verifier crashed, wipe anything matching our
  // sentinel tenant (won't collide because tenant_id is freshly generated).
  await cleanupSentinels(pool);

  log(`inserting ${FAKE_ROWS.length} sentinel rows (tenant=${SENTINEL_TENANT}, site=${SENTINEL_SITE})`);
  for (const row of FAKE_ROWS) {
    const req = pool.request();
    req.input("tenant",       SENTINEL_TENANT);
    req.input("site",         SENTINEL_SITE);
    req.input("kind",         row.kind);
    req.input("generated",    JSON.stringify({ verify: true, kind: row.kind }));
    req.input("accepted",     row.accepted);
    req.input("daysOld",      row.daysOld);
    await req.query(`
      INSERT INTO arion.site_block_draft
        (tenant_id, site_id, kind, generated_json, accepted, created_at)
      VALUES
        (@tenant, @site, @kind, @generated, @accepted,
         DATEADD(DAY, -@daysOld, SYSUTCDATETIME()))
    `);
  }

  // Confirm they landed.
  {
    const req = pool.request();
    req.input("tenant", SENTINEL_TENANT);
    const r = await req.query("SELECT COUNT(*) AS n FROM arion.site_block_draft WHERE tenant_id = @tenant");
    const seeded = r.recordset?.[0]?.n ?? 0;
    if (seeded !== FAKE_ROWS.length) {
      throw new Error(`seed assertion failed: expected ${FAKE_ROWS.length} rows, found ${seeded}`);
    }
    log(`seeded OK — ${seeded} rows present`);
  }

  // Run the cleanup function (real mode).
  delete process.env.SITE_BLOCK_DRAFT_CLEANUP_DRY_RUN;
  log("running runSiteBlockDraftCleanup()...");
  const summary = await runSiteBlockDraftCleanup(pool, (m) => log(`  cleanup: ${m}`));
  log(`cleanup summary: ${JSON.stringify(summary)}`);

  // Assert our 5 rows are gone. We don't assert summary.totalDeleted === 5
  // because the prod table likely has other expired rows from real builder
  // runs — we only need to confirm OUR rows were swept.
  const req = pool.request();
  req.input("tenant", SENTINEL_TENANT);
  const r = await req.query("SELECT COUNT(*) AS n FROM arion.site_block_draft WHERE tenant_id = @tenant");
  const remaining = r.recordset?.[0]?.n ?? 0;
  if (remaining !== 0) {
    throw new Error(`cleanup assertion failed: expected 0 sentinel rows remaining, found ${remaining}`);
  }
  log(`PASS — all ${FAKE_ROWS.length} sentinel rows deleted (totalDeleted in run: ${summary.totalDeleted})`);

  // Belt+suspenders cleanup of anything we might have missed.
  await cleanupSentinels(pool);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  console.error("[verify] FAIL:", err?.message || err);
  if (err?.stack) console.error(err.stack);
  exitCode = 1;
  // Best-effort cleanup so a failed verifier doesn't leak rows.
  try {
    const pool = await getServicesPool();
    const removed = await (async () => {
      const req = pool.request();
      req.input("tenant", SENTINEL_TENANT);
      const r = await req.query("DELETE FROM arion.site_block_draft WHERE tenant_id = @tenant");
      return r.rowsAffected?.[0] ?? 0;
    })();
    console.error(`[verify] post-fail cleanup removed ${removed} sentinel rows`);
  } catch (cleanupErr) {
    console.error("[verify] post-fail cleanup also failed:", cleanupErr?.message || cleanupErr);
  }
} finally {
  process.exit(exitCode);
}
