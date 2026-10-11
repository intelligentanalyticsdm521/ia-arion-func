// test/market-monitor-observability.test.js
//
// Regression tests for the Market Monitor silent outage.
//
// WHAT HAPPENED
// -------------
// arion.se_ranking_position_history was written ~2,651 rows/day and stopped dead
// on 2026-07-10T03:17. Seven days of SEO rank history lost — and rank history
// cannot be backfilled.
//
// The timer was NOT stuck. Its status blob on iadmwebhooksprodstg read
// {"Last":"2026-07-16T03:17","Next":"2026-07-17T03:17"} — it fired every single
// morning. But arion.market_monitor_job_log's last 'moves' row is ALSO
// 2026-07-10T03:16, so the run died BEFORE logJobStart could insert anything and
// left no trace anywhere except an App Insights exception.
//
// The reason it could fail invisibly for a week:
//   marketMonitorMoves.js  awaited getServicesPool() and runMovesCapture() with
//                          NO try/catch.
//   marketMonitor.js:80    listAuthoritySites() outside any try.
//   marketMonitor.js:86    logJobStart() outside the per-site try — so the call
//                          that RECORDS a failure was itself unprotected.
//
// A daily job that can fail silently for a week is an observability defect
// first and a bug second. These tests pin the observability, not the (still
// UNVERIFIED) root cause — which is the part that let the outage run for seven
// days regardless of what actually threw.

import test from "node:test";
import assert from "node:assert/strict";

import { runMovesCapture } from "../src/shared/marketMonitor.js";

/** Pool stub whose behaviour per statement is scriptable. */
function makePool({ sites = [], failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) {
          inputs[name] = arguments.length >= 3 ? v : _t;
          return req;
        },
        async query(sqlText) {
          const s = String(sqlText);
          if (/FROM arion\.site/i.test(s)) {
            calls.push("listAuthoritySites");
            if (failOn === "listAuthoritySites") throw new Error("Timeout: Request failed to complete in 15000ms");
            return { recordset: sites };
          }
          if (/INSERT INTO\s+arion\.market_monitor_job_log/i.test(s)) {
            calls.push("logJobStart");
            if (failOn === "logJobStart") throw new Error("Timeout: Request failed to complete in 15000ms");
            return { recordset: [{ log_id: 1 }] };
          }
          if (/UPDATE arion\.market_monitor_job_log/i.test(s)) {
            calls.push("logJobComplete");
            if (failOn === "logJobComplete") throw new Error("db is down");
            return { recordset: [], rowsAffected: [1] };
          }
          calls.push("other");
          return { recordset: [], rowsAffected: [0] };
        },
      };
      return req;
    },
  };
}

const SITE = {
  site_id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "22222222-2222-2222-2222-222222222222",
  domain: "example.com",
  se_ranking_project_id: 2465230,
  seo_addon_tier: "authority",
};

test("listAuthoritySites failing THROWS with an attributed message (was: silent death)", async () => {
  const pool = makePool({ sites: [SITE], failOn: "listAuthoritySites" });
  await assert.rejects(
    () => runMovesCapture(pool, () => {}),
    (err) => {
      // The message must say WHERE it died. Previously this threw a bare
      // "Timeout: Request failed to complete in 15000ms" out of an unprotected
      // await, with no job_log row and no attribution — indistinguishable from
      // any other failure in the run.
      // The stage was renamed listInsightsSites on 2026-07-25 (8dbafb1: own-site
      // positions now capture for every project site).
      assert.match(err.message, /listInsightsSites failed/, "error is not attributed to its stage");
      assert.match(err.message, /before any job_log row/, "does not explain why nothing was recorded");
      return true;
    }
  );
});

test("logJobStart failing is a RECORDED per-site error, not an unhandled throw", async () => {
  const pool = makePool({ sites: [SITE], failOn: "logJobStart" });

  // Previously logJobStart sat outside the try, so this threw out of the whole
  // run — killing every remaining site AND losing the reason.
  const res = await runMovesCapture(pool, () => {});

  assert.equal(res.errors.length, 1, "the failure was not recorded");
  assert.equal(res.errors[0].stage, "logJobStart", "the failing stage is not identified");
  assert.match(res.errors[0].message, /Timeout/);
  assert.equal(res.rowsWritten, 0);
});

test("a DB that cannot even record the error does not take the run down", async () => {
  // logJobComplete writes to the same DB that may BE the failure. An exception
  // thrown from inside a catch block is unhandled and would destroy the
  // diagnosis we are mid-way through capturing.
  const pool = makePool({ sites: [SITE], failOn: "logJobComplete" });
  const res = await runMovesCapture(pool, () => {});
  assert.ok(Array.isArray(res.errors), "run collapsed instead of returning its errors");
  assert.equal(res.rowsWritten, 0);
});

test("zero Authority-tier sites is NORMAL, not the outage", async () => {
  // se_ranking_position_history being 100% iadm is BY DESIGN: listAuthoritySites
  // filters seo_addon_tier='authority' and IA owns the only Authority site (the
  // three clients are growth/essentials). This was mis-reported as "per-client
  // history never persists" — the model is not starving, the tier gate is doing
  // its job. Verified against prod 2026-07-16.
  const pool = makePool({ sites: [] });
  const messages = [];
  const res = await runMovesCapture(pool, (m) => messages.push(m));

  assert.equal(res.sitesProcessed, 0);
  assert.equal(res.rowsWritten, 0);
  assert.equal(res.errors.length, 0, "an empty site list must not be reported as an error");
  assert.ok(
    messages.some((m) => /normal/i.test(m)),
    "an empty run should say it is normal, so it is not mistaken for the outage"
  );
});
