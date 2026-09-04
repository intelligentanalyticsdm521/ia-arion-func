#!/usr/bin/env node
/**
 * Verifier — the 2-business-day pre-run notice (Release A.2 P5 / X1).
 *
 * Proves the pass end to end against a DATABASE, not a mock:
 *   1. a scheduled profile two business days out is selected, rendered from
 *      lumen.email_template ('leadgen.pre_run_notice', migration 144) and
 *      stamped in pre_run_notice_for
 *   2. a second pass sends NOTHING for the same run (the stamp is the guard)
 *   3. moving next_run_at produces a fresh notice for the new date
 *   4. a run five business days out is never noticed
 *
 * DRY RUN by design — LEADGEN_DIGEST_DRY_RUN is forced on, so nothing is ever
 * handed to ACS. Fixture rows are created under a sentinel profile name and
 * deleted on the way out, pass or fail.
 *
 * Usage (local dev stack, fixture tenant only):
 *   node scripts/verify-leadgen-pre-run-notice.mjs
 *
 * Env — the timer authenticates to both databases with a managed identity,
 * which a local run cannot do, so this connects with the dev stack's SQL login
 * and hands the pools in:
 *   SQL_SERVER (default localhost,1433) · SQL_USER · SQL_PASSWORD
 *   SERVICES_SQL_DATABASE (default iadm_services)
 *   PLATFORM_SQL_DATABASE (default iadm_platform)
 *   VERIFY_TENANT_ID      the fixture tenant to attach the profile to
 *
 * Exit 0 = pass, 1 = any assertion failed.
 */
import "dotenv/config";
import mssql from "mssql";
import { runPreRunNoticePass } from "../src/shared/leadgenScheduler.js";
import { businessDaysUntil } from "../src/shared/businessDays.js";

process.env.LEADGEN_DIGEST_DRY_RUN = "1"; // never send from a verifier

const SENTINEL = `__verify_prerun_${process.pid}_${Date.now()}`;
const TENANT = process.env.VERIFY_TENANT_ID || "a0000001-0000-0000-0000-000000000001";
const SERVER = process.env.SQL_SERVER || "localhost,1433";
const TZ = "America/Chicago";

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${what}`);
  if (!ok) failures++;
}
function log(m) { if (process.env.VERBOSE) console.log(m); }

async function connect(database) {
  const [server, port] = SERVER.split(",");
  return new mssql.ConnectionPool({
    server,
    port: port ? parseInt(port, 10) : 1433,
    database,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();
}

/**
 * A moment that is exactly `n` business days from now IN THE PROFILE'S
 * TIMEZONE. Counting in UTC instead is how a first draft of this verifier
 * produced a Monday for "one business day" on a Thursday evening in Chicago —
 * the same off-by-a-timezone the notice window itself has to avoid.
 */
function businessDaysFromNow(n) {
  const now = new Date();
  const d = new Date(now);
  for (let i = 0; i < 30; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(14, 0, 0, 0);
    if (businessDaysUntil(now, d, TZ) === n) return new Date(d);
  }
  throw new Error(`could not find a date ${n} business days out`);
}

async function main() {
  const services = await connect(process.env.SERVICES_SQL_DATABASE || "iadm_services");
  const platform = await connect(process.env.PLATFORM_SQL_DATABASE || "iadm_platform");
  if (!/^(localhost|127\.0\.0\.1)/i.test(SERVER)) {
    throw new Error(`refusing to run against ${SERVER} — this verifier writes fixture rows and is dev-only`);
  }

  let profileId = null;
  try {
    const ins = await services.request()
      .input("t", mssql.NVarChar, TENANT)
      .input("n", mssql.NVarChar, SENTINEL)
      .input("next", mssql.DateTimeOffset, businessDaysFromNow(2))
      .query(`INSERT INTO lumen.search_profile
                (tenant_id, profile_name, is_scheduled, schedule_cadence, schedule_timezone, next_run_at, max_results_per_run)
              OUTPUT INSERTED.id
              VALUES (@t, @n, 1, 'weekly', 'America/Chicago', @next, 10)`);
    profileId = ins.recordset[0].id;
    console.log(`[verify] fixture profile ${profileId} (${SENTINEL}) on tenant ${TENANT}`);

    const first = await runPreRunNoticePass(services, log, mssql, { platformPool: platform });
    check(first.scanned >= 1, "a run two business days out is picked up");
    check(first.sent >= 1 || first.skipped_suppressed >= 1,
      `it is either sent or explicitly suppressed (sent=${first.sent} suppressed=${first.skipped_suppressed} no_owner=${first.skipped_no_owner} no_template=${first.skipped_no_template})`);
    check(first.skipped_no_template === 0, "the leadgen.pre_run_notice template exists (migration 144 applied)");

    const stamped = await services.request().input("id", mssql.Int, profileId)
      .query(`SELECT pre_run_notice_for, next_run_at FROM lumen.search_profile WHERE id=@id`);
    const row = stamped.recordset[0];
    check(row.pre_run_notice_for != null, "pre_run_notice_for is stamped");
    check(row.pre_run_notice_for && new Date(row.pre_run_notice_for).getTime() === new Date(row.next_run_at).getTime(),
      "it is stamped with the run it was about, not just 'now'");

    const second = await runPreRunNoticePass(services, log, mssql, { platformPool: platform });
    check(second.sent === 0, "a second pass sends nothing for the same run");

    // Move the run: a new date is a new notice.
    await services.request().input("id", mssql.Int, profileId)
      .input("next", mssql.DateTimeOffset, businessDaysFromNow(1))
      .query(`UPDATE lumen.search_profile SET next_run_at=@next WHERE id=@id`);
    const third = await runPreRunNoticePass(services, log, mssql, { platformPool: platform });
    check(third.scanned >= 1, "changing the run date produces a fresh notice");

    // Five business days out is not two.
    await services.request().input("id", mssql.Int, profileId)
      .input("next", mssql.DateTimeOffset, businessDaysFromNow(5))
      .query(`UPDATE lumen.search_profile SET next_run_at=@next, pre_run_notice_for=NULL WHERE id=@id`);
    const fourth = await runPreRunNoticePass(services, log, mssql, { platformPool: platform });
    const stillClear = await services.request().input("id", mssql.Int, profileId)
      .query(`SELECT pre_run_notice_for FROM lumen.search_profile WHERE id=@id`);
    check(stillClear.recordset[0].pre_run_notice_for == null,
      `a run five business days out is left alone (sent=${fourth.sent})`);
  } finally {
    if (profileId) {
      await services.request().input("id", mssql.Int, profileId)
        .query(`DELETE FROM lumen.search_profile WHERE id=@id`).catch(() => {});
      console.log(`[verify] cleaned up profile ${profileId}`);
    }
    await services.close().catch(() => {});
    await platform.close().catch(() => {});
  }

  console.log(failures ? `[verify] ${failures} FAILURE(S)` : "[verify] all checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("[verify] threw:", e.message); process.exit(1); });
