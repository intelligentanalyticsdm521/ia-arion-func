// test/product-ownership.test.mjs — scheduled lead-gen stops for a business
// whose SPARK has ended (scope SCOPE_ACCESS_FOLLOWS_SUBSCRIPTION_2026-10-07 §4.3).
//
// LOAD-BEARING ASSERTIONS:
//   * SPARK OFF → no lead search is queued for that business and no "your run
//     is in two days" notice is sent; the summary names it;
//   * SPARK ON  → the same pass still does the work (presence);
//   * UNREACHABLE → every business runs exactly as before;
//   * the dispatcher filters IN its TOP (@limit) statement, so an ended
//     business's schedules (which stay due) cannot starve paying businesses.
//     The fake evaluates the statement's own @owned predicate.
//
// src/shared/productOwnership.js is a declared copy of oliver-api's; the rule
// tests are the same. All fakes; nothing reaches a real pool.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SQL_SERVER = "";
process.env.SERVICES_SQL_SERVER = "";

const own = await import("../src/shared/productOwnership.js");
const { filterOwned, checkOwnership, clearOwnershipCache } = own;
const { runLeadgenScheduledTick, runPreRunNoticePass } = await import("../src/shared/leadgenScheduler.js");

const ON = "11111111-1111-4111-8111-111111111111";
const OFF = "22222222-2222-4222-8222-222222222222";
const NEVER = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const GHOST = "55555555-5555-4555-8555-555555555555";

const quietLog = () => {
  const lines = { error: [], log: [] };
  return { lines, error: (...a) => lines.error.push(a.join(" ")), log: (...a) => lines.log.push(a.join(" ")), warn() {} };
};

function fakePlatform({ rows = {}, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query(text) {
          calls.push({ text, inputs: { ...inputs } });
          if (fail) throw new Error(fail);
          if (!/FROM core\.tenants t/.test(text)) return { recordset: [] }; // owner lookups etc.
          assert.match(text, /ts\.is_enabled = 1 AND s\.is_active = 1/);
          const ids = JSON.parse(inputs.ids);
          return {
            recordset: ids.filter((id) => rows[id]).map((id) => ({
              tenant_id: id.toLowerCase(), tenant_kind: rows[id].kind || "direct",
              has_on: Boolean(rows[id].on), has_row: Boolean(rows[id].row || rows[id].on),
            })),
          };
        },
      };
      return req;
    },
  };
}
const STANDARD_ROWS = { [ON]: { on: true }, [OFF]: { row: true }, [NEVER]: {}, [OWNER]: { kind: "platform_owner" } };
/** platform-api's entitlement payload: `paid` ids have SPARK in Stripe; `down` = unreachable; else decided, not owned. */
function fakeEntitlements({ paid = [], down = false } = {}) {
  const asked = [];
  const fn = async (id) => {
    asked.push(String(id).toUpperCase());
    if (down) return null;
    const owned = paid.map((x) => x.toUpperCase()).includes(String(id).toUpperCase());
    return { decided: true, products: { spark: { owned, decided: true } } };
  };
  fn.asked = asked;
  return fn;
}
const DECIDED_OFF = fakeEntitlements();
const ownershipOver = (platform, log, getEntitlements = DECIDED_OFF) => (product, ids) =>
  checkOwnership(product, ids, { getPlatformPool: async () => platform, log, getEntitlements });
const ownershipUnreachable = (log) => (product, ids) =>
  checkOwnership(product, ids, { getPlatformPool: async () => { throw new Error("connect ETIMEDOUT"); }, log });

const OWNED_PREDICATE = /\(@owned IS NULL OR tenant_id IN \(SELECT \[value\] FROM OPENJSON\(@owned\)\)\)/;
function fakeServices(answers) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = arguments.length === 2 ? _t : v; return req; },
        async query(text) {
          calls.push({ text, inputs: { ...inputs } });
          for (const [re, rows] of answers) {
            if (re.test(text)) {
              const out = typeof rows === "function" ? rows(inputs, text) : rows;
              return { recordset: out.map((r) => ({ ...r })), rowsAffected: [out.length] };
            }
          }
          return { recordset: [], rowsAffected: [0] };
        },
      };
      return req;
    },
  };
}
const whereOwned = (rows) => (inputs, text) => {
  if (!OWNED_PREDICATE.test(text) || inputs.owned == null) return rows;
  const owned = new Set(JSON.parse(inputs.owned).map((s) => String(s).toLowerCase()));
  return rows.filter((r) => owned.has(String(r.tenant_id).toLowerCase()));
};

test.beforeEach(() => clearOwnershipCache());

/* ── the rule (same cases as oliver-api's copy) ─────────────────────────── */

test("filterOwned: on, switched off, never bought, platform owner, missing", async () => {
  const log = quietLog();
  const v = await filterOwned(fakePlatform({ rows: STANDARD_ROWS }), "spark", [ON, OFF, NEVER, OWNER, GHOST], { log, getEntitlements: DECIDED_OFF });
  assert.deepEqual(v.owned, [ON, OWNER, GHOST]);
  assert.deepEqual(v.off.map((o) => o.tenantId), [OFF, NEVER]);
  assert.equal(v.off[0].reason, "SPARK is switched off");
  assert.ok(log.lines.error.some((l) => l.includes(GHOST)));
});

test("filterOwned: an agency is kept; a failed or empty read keeps everyone", async () => {
  assert.deepEqual((await filterOwned(fakePlatform({ rows: { [OFF]: { kind: "agency", row: true } } }), "spark", [OFF], { log: quietLog() })).owned, [OFF]);
  for (const p of [fakePlatform({ fail: "Login failed" }), fakePlatform({ rows: {} }), null]) {
    clearOwnershipCache();
    const v = await filterOwned(p, "spark", [ON, OFF], { log: quietLog() });
    assert.equal(v.undecided, true);
    assert.deepEqual(v.owned, [ON, OFF]);
  }
});

/* ── PASS 1: dispatch ───────────────────────────────────────────────────── */

const PROFILES = [
  { id: 101, tenant_id: ON, profile_name: "a", schedule_cadence: "weekly", schedule_config_json: null, schedule_timezone: "UTC", max_results_per_run: 10, next_run_at: "2026-10-01T00:00:00Z" },
  { id: 202, tenant_id: OFF, profile_name: "b", schedule_cadence: "weekly", schedule_config_json: null, schedule_timezone: "UTC", max_results_per_run: 10, next_run_at: "2026-10-01T00:00:00Z" },
];
const DISTINCT = /SELECT DISTINCT tenant_id FROM lumen\.search_profile/;
const MAIN = /SELECT TOP \(@limit\)\s+id, tenant_id, profile_name,\s+schedule_cadence/;
const REREAD = /WITH \(UPDLOCK, ROWLOCK\)/;

// dispatchOne opens a transaction; this stand-in for the mssql module routes
// every transaction request back to the fake pool (the third argument is the
// dispatcher's own seam for a foreign mssql copy).
const type = () => "type";
const fakeMssql = {
  Int: type, NVarChar: type, MAX: "max", DateTimeOffset: type,
  Transaction: class { constructor(pool) { this.pool = pool; } async begin() {} async commit() {} async rollback() {} },
  Request: function (tx) { return tx.pool.request(); },
};

async function dispatch(ownership) {
  const pool = fakeServices([[DISTINCT, PROFILES.map((p) => ({ tenant_id: p.tenant_id }))], [MAIN, whereOwned(PROFILES)]]);
  const logs = [];
  const summary = await runLeadgenScheduledTick(pool, (m) => logs.push(m), fakeMssql, { ownership });
  const reread = pool.calls.filter((c) => REREAD.test(c.text)).map((c) => c.inputs.id);
  return { summary, pool, reread, logs };
}

test("dispatch: SPARK off → no lead search queued for that business, filtered in the statement", async () => {
  const { summary, pool, reread, logs } = await dispatch(ownershipOver(fakePlatform({ rows: STANDARD_ROWS }), quietLog()));
  const main = pool.calls.find((c) => MAIN.test(c.text));
  assert.match(main.text, OWNED_PREDICATE);
  assert.deepEqual(JSON.parse(main.inputs.owned), [ON]);
  assert.equal(summary.scanned, 1);
  assert.deepEqual(reread, [101], "only the paying business's schedule goes on to dispatch");
  assert.deepEqual(summary.productOff.skipped.map((s) => s.tenantId), [OFF]);
  assert.ok(logs.some((m) => m.includes(OFF) && m.includes("SPARK has ended for this business, so no scheduled lead search was started. It starts again after a re-subscribe.")));
});

test("dispatch: platform database unreachable → every schedule dispatched as before", async () => {
  const log = quietLog();
  const { summary, pool, reread } = await dispatch(ownershipUnreachable(log));
  assert.equal(pool.calls.find((c) => MAIN.test(c.text)).inputs.owned, null);
  assert.equal(summary.scanned, 2);
  assert.deepEqual(reread.sort(), [101, 202]);
  assert.equal(summary.productOff.undecided, true);
  assert.ok(log.lines.error.length >= 1);
});

/* ── PASS 2: the two-day notice ─────────────────────────────────────────── */

const NOW = "2026-10-07T12:00:00Z"; // a Wednesday
const NOTICE_ROWS = [
  { id: 101, tenant_id: ON, profile_name: "a", next_run_at: new Date("2026-10-08T12:00:00Z"), schedule_timezone: "UTC", pre_run_notice_for: null },
  { id: 202, tenant_id: OFF, profile_name: "b", next_run_at: new Date("2026-10-08T12:00:00Z"), schedule_timezone: "UTC", pre_run_notice_for: null },
];

async function notice(ownership) {
  const pool = fakeServices([[/pre_run_notice_for IS NULL OR pre_run_notice_for <> next_run_at/, NOTICE_ROWS]]);
  const out = await runPreRunNoticePass(pool, () => {}, undefined, { now: NOW, platformPool: fakePlatform({}), ownership });
  return out;
}

test("notice: SPARK off → that business is not told a run is coming", async () => {
  const out = await notice(ownershipOver(fakePlatform({ rows: STANDARD_ROWS }), quietLog()));
  assert.equal(out.scanned, 1, "only the paying business is considered for a notice");
  assert.deepEqual(out.productOff.skipped.map((s) => s.tenantId), [OFF]);
});

test("F1: row off but Stripe shows SPARK paid for → the scheduled search still runs (the SPARK gate lets it in)", async () => {
  const ent = fakeEntitlements({ paid: [OFF] });
  const { summary, reread } = await dispatch(ownershipOver(fakePlatform({ rows: STANDARD_ROWS }), quietLog(), ent));
  assert.deepEqual(reread.sort(), [101, 202], "both schedules dispatch");
  assert.deepEqual(summary.productOff.skipped, []);
  assert.deepEqual(ent.asked, [OFF], "only the business whose row says off is asked");
});

test("F1: platform-api unreachable → the business whose row says off runs as before, logged", async () => {
  const log = quietLog();
  const v = await filterOwned(fakePlatform({ rows: { [OFF]: { row: true } } }), "spark", [OFF], { log, getEntitlements: fakeEntitlements({ down: true }) });
  assert.deepEqual(v.owned, [OFF]);
  assert.deepEqual(v.unconfirmed, [OFF]);
  assert.ok(log.lines.error.some((l) => /could not confirm/.test(l)));
});

test("F1: fetchEntitlements asks /internal/entitlements/:id with the token, and is null when not configured or failing", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, token: init.headers["x-internal-token"] }); return { ok: true, json: async () => ({ decided: true }) }; };
  const env = { PLATFORM_API_URL: "http://platform.test/", PLATFORM_INTERNAL_TOKEN: "t0k" };
  assert.deepEqual(await own.fetchEntitlements(OFF, { env, fetchImpl }), { decided: true });
  assert.equal(seen[0].url, `http://platform.test/internal/entitlements/${OFF}`);
  assert.equal(seen[0].token, "t0k");
  assert.equal(await own.fetchEntitlements(OFF, { env: {}, fetchImpl }), null);
  assert.equal(await own.fetchEntitlements(OFF, { env, fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await own.fetchEntitlements(OFF, { env, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }), null);
});

test("notice: platform database unreachable → every business considered as before", async () => {
  const out = await notice(ownershipUnreachable(quietLog()));
  assert.equal(out.scanned, 2);
  assert.equal(out.productOff.undecided, true);
});

test("both passes default to the real check (no stub on the seam)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/shared/leadgenScheduler.js", import.meta.url), "utf8");
  assert.match(src, /opts\.ownership \|\| \(\(product, ids\) => checkOwnership\(product, ids, \{ mssql \}\)\)/);
  assert.match(src, /opts\.ownership\s+\|\| \(\(product, ids\) => checkOwnership\(product, ids, \{ getPlatformPool: async \(\) => platformPool, mssql \}\)\)/);
  const lib = readFileSync(new URL("../src/shared/productOwnership.js", import.meta.url), "utf8");
  assert.match(lib, /import\("\.\/platformPool\.js"\)\)\.getPlatformPool/);
});
