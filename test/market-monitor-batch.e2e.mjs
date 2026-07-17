// test/market-monitor-batch.e2e.mjs
//
// Integration test for the batched position writer, against the DEV database.
// Needs a real SQL Server because the things that can go wrong here — the
// NULL-join trap, the multi-row MERGE duplicate-key error, the 2,100-parameter
// ceiling, and the actual round-trip cost — are all properties of the engine, not
// of JavaScript. A mock would prove none of them.
//
// DEV SPACE ONLY: refuses any non-loopback target and re-verifies the sa login.
//
// WHAT IT PINS
// ------------
// runMovesCapture used to issue ONE MERGE round-trip per keyword per competitor —
// ~2,651 sequential statements per run — against mssql's 15s default
// requestTimeout. arion.market_monitor_job_log recorded the result:
// "Timeout: Request failed to complete in 15000ms" on 2026-07-05 and 07-06, the
// visible prelude to the outage that began on 07-10.
//
// Batching turns ~2,651 round-trips into ~14. Measured here: 2,500 rows in ~1.2s.
//
// USAGE: DEVPW=<dev sa password> node test/market-monitor-batch.e2e.mjs

import sql from "mssql";
import assert from "node:assert/strict";
import { mergePositionRows } from "../src/shared/marketMonitor.js";

const HOST = process.env.DEV_SQL_HOST || "localhost";
const PW = process.env.DEVPW || process.env.SQL_PASSWORD;

if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(HOST)) {
  console.error(`\n🔴 REFUSING: "${HOST}" is not loopback. This test writes and deletes.`);
  process.exit(2);
}
if (!PW) {
  console.error("\n🔴 No DEVPW / SQL_PASSWORD set.");
  process.exit(2);
}

const pool = await new sql.ConnectionPool({
  server: HOST, port: 1433, database: "iadm_services",
  user: "SA", password: PW,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();

const who = (await pool.request().query("SELECT SUSER_NAME() u, DB_NAME() d")).recordset[0];
if (String(who.u).toLowerCase() !== "sa") {
  console.error(`\n🔴 REFUSING: authenticated as "${who.u}", expected the dev sa login.`);
  process.exit(2);
}

// A synthetic site id that no real tenant uses, so cleanup can be surgical.
const T = "a0000001-0000-0000-0000-000000000001";
const S = "a0000001-0000-0000-0000-0000000000ff";

const results = [];
const check = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); console.log(`  ✅ ${name}`); }
  catch (e) { results.push({ name, ok: false, error: e.message }); console.log(`  ❌ ${name}\n       ${String(e.message).split("\n")[0]}`); }
};
const clean = () => pool.request().input("s", sql.UniqueIdentifier, S)
  .query("DELETE FROM arion.se_ranking_position_history WHERE site_id=@s");
const count = async (where = "") => (await pool.request().input("s", sql.UniqueIdentifier, S)
  .query(`SELECT COUNT(*) n, MAX(position) p FROM arion.se_ranking_position_history WHERE site_id=@s ${where}`)).recordset[0];

const row = (kwId, pos, comp = null) => ({
  tenantId: T, siteId: S, projectId: "2465230", engineId: "1",
  keywordId: String(kwId), keyword: "kw " + kwId,
  competitorDomain: comp, pos, recordedFor: new Date("2026-07-17"),
});

console.log("\n══════════════════════════════════════════════════════════════");
console.log(" Market Monitor — batched position writer (DEV ONLY)");
console.log(`══════════════════════════════════════════════════════════════`);
console.log(`  ${who.u}@${who.d}\n`);

await clean();

// 1 own-site + 4 competitors x 500 keywords = 2,500 — a realistic run.
const many = [];
for (let i = 0; i < 500; i++) many.push(row(i, (i % 100) + 1));
for (const c of ["a.com", "b.com", "c.com", "d.com"]) {
  for (let i = 0; i < 500; i++) many.push(row(i, (i % 100) + 1, c));
}

const t0 = Date.now();
await mergePositionRows(pool, many);
const elapsed = Date.now() - t0;
let n = await count();
check(`a realistic ${many.length}-row run writes every row (${elapsed}ms)`, () => {
  assert.equal(n.n, many.length, `wrote ${n.n} of ${many.length}`);
});
check(`...and comfortably inside the 15s timeout that used to kill it`, () => {
  // Not a benchmark — a regression guard. If someone reverts to per-row
  // round-trips this blows past it immediately. ~1.2s observed; 10s leaves
  // generous headroom for a slow machine while still catching the regression.
  assert.ok(elapsed < 10_000, `took ${elapsed}ms — is this back to one round-trip per row?`);
});

await mergePositionRows(pool, many);
n = await count();
check("re-running is idempotent — MERGE updates, never duplicates", () => {
  assert.equal(n.n, many.length, `rows grew to ${n.n} — the daily run would duplicate history`);
});

// The NULL-join trap: `tgt.competitor_domain = src.competitor_domain` is NEVER
// true for two NULLs, so a naive batch would insert a fresh own-site row daily.
await mergePositionRows(pool, [row(999, 5)]);
await mergePositionRows(pool, [row(999, 7)]);
const own = await count("AND keyword_id='999' AND competitor_domain IS NULL");
check("a NULL competitor_domain (own site) updates in place, not duplicates", () => {
  assert.equal(own.n, 1, "two NULLs did not match — own-site rows would duplicate every day");
  assert.equal(own.p, 7, "the update did not take");
});

// The multi-row MERGE gotcha: duplicate join keys in one source raise
// "attempted to UPDATE or DELETE the same row of the target table more than
// once" and fail the WHOLE chunk. The per-row version could never hit this.
await mergePositionRows(pool, [row(1234, 1), row(1234, 2), row(1234, 3)]);
const dup = await count("AND keyword_id='1234'");
check("duplicate join keys in one chunk are de-duplicated, last-write-wins", () => {
  assert.equal(dup.n, 1, "duplicate source rows were not collapsed");
  assert.equal(dup.p, 3, "expected last-write-wins, matching the per-row behaviour it replaces");
});

check("an empty batch is a no-op, not an error", () => { /* proven by the await below */ });
await mergePositionRows(pool, []);

await clean();
await pool.close();

const passed = results.filter((r) => r.ok).length;
console.log("\n══════════════════════════════════════════════════════════════");
console.log(`  ${passed}/${results.length} passed`);
if (passed !== results.length) { console.log("\n  RESULT: FAIL\n"); process.exit(1); }
console.log("\n  RESULT: PASS — batched writer is correct, idempotent and fast.\n");
