#!/usr/bin/env node
/**
 * Verifier — F-LG.15 followup nightly purge.
 *
 * Inserts 5 fake lumen.domain_check_cache rows with old timestamps, runs
 * runDomainCacheCleanup(), and asserts all 5 were deleted. Cleans up any
 * stragglers on exit even when assertions fail.
 *
 * Usage:
 *   node scripts/verify-domain-cache-cleanup.mjs
 *
 * Env (same conventions as the timer):
 *   SERVICES_SQL_SERVER   (or SQL_SERVER)
 *   SERVICES_SQL_DATABASE (default "iadm_services")
 *   AUTH_MODE             default "LOCAL_DEV" → DefaultAzureCredential
 *
 * Returns exit code 0 on pass, 1 on any assertion failure or thrown error.
 */
import "dotenv/config";
import { getServicesPool } from "../src/shared/servicesPool.js";
import { runDomainCacheCleanup } from "../src/functions/domainCheckCacheCleanup.js";

// Unique sentinel prefix so we never touch a real cached domain.
const PREFIX = `__verify_dcc_${process.pid}_${Date.now()}_`;
const FAKE_DOMAINS = Array.from({ length: 5 }, (_, i) => `${PREFIX}${i}.test`);

function log(msg) {
  console.log(`[verify] ${msg}`);
}

async function cleanupSentinels(pool) {
  const req = pool.request();
  req.input("prefix", `${PREFIX}%`);
  const r = await req.query("DELETE FROM lumen.domain_check_cache WHERE domain LIKE @prefix");
  return r.rowsAffected?.[0] ?? 0;
}

async function main() {
  if (process.env.DOMAIN_CACHE_CLEANUP_DRY_RUN === "1") {
    throw new Error("verifier must NOT run with DOMAIN_CACHE_CLEANUP_DRY_RUN=1 — it asserts real deletes");
  }

  log(`connecting to SQL (${process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER} / ${process.env.SERVICES_SQL_DATABASE || "iadm_services"})`);
  const pool = await getServicesPool();

  // Defensive: if a previous verifier crashed, wipe anything matching our
  // process-unique prefix anyway (won't collide because PREFIX is fresh).
  await cleanupSentinels(pool);

  log(`inserting ${FAKE_DOMAINS.length} fake rows with checked_at = 31d ago, expires_at = 30d ago`);
  for (const domain of FAKE_DOMAINS) {
    const req = pool.request();
    req.input("domain", domain);
    req.input("fresh", 1);
    req.input("reason", "verifier seed");
    req.input("http_status", 200);
    req.input("body_bytes", 1234);
    await req.query(`
      INSERT INTO lumen.domain_check_cache
        (domain, fresh, reason, http_status, body_bytes, checked_at, expires_at)
      VALUES
        (@domain, @fresh, @reason, @http_status, @body_bytes,
         DATEADD(DAY, -31, SYSUTCDATETIME()),
         DATEADD(DAY, -30, SYSUTCDATETIME()))
    `);
  }

  // Confirm they landed.
  {
    const req = pool.request();
    req.input("prefix", `${PREFIX}%`);
    const r = await req.query("SELECT COUNT(*) AS n FROM lumen.domain_check_cache WHERE domain LIKE @prefix");
    const seeded = r.recordset?.[0]?.n ?? 0;
    if (seeded !== FAKE_DOMAINS.length) {
      throw new Error(`seed assertion failed: expected ${FAKE_DOMAINS.length} rows, found ${seeded}`);
    }
    log(`seeded OK — ${seeded} rows present`);
  }

  // Run the cleanup function (real mode).
  delete process.env.DOMAIN_CACHE_CLEANUP_DRY_RUN;
  log("running runDomainCacheCleanup()...");
  const summary = await runDomainCacheCleanup(pool, (m) => log(`  cleanup: ${m}`));
  log(`cleanup summary: ${JSON.stringify(summary)}`);

  // Assert our 5 rows are gone. We don't assert summary.totalDeleted === 5
  // because the prod table likely has other expired rows from real verifier
  // runs — we only need to confirm OUR rows were swept.
  const req = pool.request();
  req.input("prefix", `${PREFIX}%`);
  const r = await req.query("SELECT COUNT(*) AS n FROM lumen.domain_check_cache WHERE domain LIKE @prefix");
  const remaining = r.recordset?.[0]?.n ?? 0;
  if (remaining !== 0) {
    throw new Error(`cleanup assertion failed: expected 0 sentinel rows remaining, found ${remaining}`);
  }
  log(`PASS — all ${FAKE_DOMAINS.length} fake rows deleted (totalDeleted in run: ${summary.totalDeleted})`);

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
      req.input("prefix", `${PREFIX}%`);
      const r = await req.query("DELETE FROM lumen.domain_check_cache WHERE domain LIKE @prefix");
      return r.rowsAffected?.[0] ?? 0;
    })();
    console.error(`[verify] post-fail cleanup removed ${removed} sentinel rows`);
  } catch (cleanupErr) {
    console.error("[verify] post-fail cleanup also failed:", cleanupErr?.message || cleanupErr);
  }
} finally {
  process.exit(exitCode);
}
