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
// USAGE: DEVPW=<dev sa password> node --test test/market-monitor-batch.e2e.mjs
//
// With no DEVPW it reports SKIPPED — not passed, not failed. It used to
// process.exit(2), which turned "this machine has no dev SQL" into a red suite
// for everyone. A green tick for a test that never opened a connection would be
// the opposite and worse lie.

import test from "node:test";
import assert from "node:assert/strict";
import sql from "mssql";

import { mergePositionRows } from "../src/shared/marketMonitor.js";

const HOST = process.env.DEV_SQL_HOST || "localhost";
const PW = process.env.DEVPW || process.env.SQL_PASSWORD;

// SAFETY, not hygiene: this test DELETEs. A non-loopback host is never something
// we quietly skip past — it means someone is pointing a destructive test at a
// shared or production server. Fail loudly, always, even without a password.
if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(HOST)) {
  throw new Error(
    `REFUSING: DEV_SQL_HOST="${HOST}" is not loopback. This test writes and deletes rows.`
  );
}

// A missing password just means "no dev SQL on this machine" — that is a skip.
const skip = PW ? false : "no DEVPW / SQL_PASSWORD set — dev SQL Server not available here";

// Synthetic ids no real tenant uses, so cleanup can be surgical.
const T = "a0000001-0000-0000-0000-000000000001";
const S = "a0000001-0000-0000-0000-0000000000ff";

const row = (kwId, pos, comp = null) => ({
  tenantId: T, siteId: S, projectId: "2465230", engineId: "1",
  keywordId: String(kwId), keyword: "kw " + kwId,
  competitorDomain: comp, pos, recordedFor: new Date("2026-07-17"),
});

test("Market Monitor — batched position writer (real dev DB)", { skip }, async (t) => {
  const pool = await new sql.ConnectionPool({
    server: HOST, port: 1433, database: "iadm_services",
    user: "SA", password: PW,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();

  const who = (await pool.request().query("SELECT SUSER_NAME() u, DB_NAME() d")).recordset[0];
  assert.equal(String(who.u).toLowerCase(), "sa",
    `authenticated as "${who.u}", expected the dev sa login — refusing to write`);

  const clean = () => pool.request().input("s", sql.UniqueIdentifier, S)
    .query("DELETE FROM arion.se_ranking_position_history WHERE site_id=@s");
  const count = async (where = "") => (await pool.request().input("s", sql.UniqueIdentifier, S)
    .query(`SELECT COUNT(*) n, MAX(position) p FROM arion.se_ranking_position_history WHERE site_id=@s ${where}`)).recordset[0];

  try {
    await clean();

    // 1 own-site + 4 competitors x 500 keywords = 2,500. IA's real daily run is
    // 241 keywords x 11 series = 2,651, so this is life-sized.
    const many = [];
    for (let i = 0; i < 500; i++) many.push(row(i, (i % 100) + 1));
    for (const c of ["a.com", "b.com", "c.com", "d.com"]) {
      for (let i = 0; i < 500; i++) many.push(row(i, (i % 100) + 1, c));
    }

    const t0 = Date.now();
    await mergePositionRows(pool, many);
    const elapsed = Date.now() - t0;

    await t.test(`a life-sized ${many.length}-row run writes every row (${elapsed}ms)`, async () => {
      const n = await count();
      assert.equal(n.n, many.length, `wrote ${n.n} of ${many.length}`);
    });

    await t.test("...and comfortably inside the 15s timeout that used to kill the run", () => {
      // Not a benchmark — a regression guard. If someone reverts to one
      // round-trip per row this blows past it immediately. ~1.2s observed;
      // 10s leaves headroom on a slow machine while still catching the revert.
      assert.ok(elapsed < 10_000, `took ${elapsed}ms — is this back to one round-trip per row?`);
    });

    await t.test("re-running is idempotent — MERGE updates, never duplicates", async () => {
      await mergePositionRows(pool, many);
      const n = await count();
      assert.equal(n.n, many.length, `rows grew to ${n.n} — the daily run would duplicate history`);
    });

    await t.test("a NULL competitor_domain (own site) updates in place, not duplicates", async () => {
      // The NULL-join trap: `tgt.competitor_domain = src.competitor_domain` is
      // never true for two NULLs, so a naive batch inserts a fresh own-site row
      // every day. Own-site rows are the ones the customer actually looks at.
      await mergePositionRows(pool, [row(999, 5)]);
      await mergePositionRows(pool, [row(999, 7)]);
      const own = await count("AND keyword_id='999' AND competitor_domain IS NULL");
      assert.equal(own.n, 1, "two NULLs did not match — own-site rows would duplicate every day");
      assert.equal(own.p, 7, "the update did not take");
    });

    await t.test("duplicate join keys in one chunk de-duplicate, last-write-wins", async () => {
      // Duplicate keys in one MERGE source fail the WHOLE chunk with "attempted
      // to UPDATE or DELETE the same row of the target table more than once".
      // last-write-wins matches the per-row behaviour this replaced.
      await mergePositionRows(pool, [row(1234, 1), row(1234, 2), row(1234, 3)]);
      const dup = await count("AND keyword_id='1234'");
      assert.equal(dup.n, 1, "duplicate source rows were not collapsed");
      assert.equal(dup.p, 3, "expected last-write-wins");
    });

    await t.test("an empty batch is a no-op, not an error", async () => {
      await mergePositionRows(pool, []);
    });
  } finally {
    await clean().catch(() => {});
    await pool.close();
  }
});
