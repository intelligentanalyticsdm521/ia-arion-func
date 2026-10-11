// test/onboarding-worker-follows-arion.test.mjs — the 30-second onboarding
// worker advances a website's set-up only for a business that owns ARION
// (Brandon, 11 Oct 2026: "If they don't have the subscription you don't get
// any features").
//
// Each phase it advances starts ARION work, some of it paid for by us (the
// plugin stack, a WordPress editor user, a billable SE Ranking project).
//
// Runs the REAL runOnboardingTick and the REAL checkOwnership over a fake
// platform database in apply mode (as production is now), with the services
// database and the arion-api advance calls stubbed:
//   ARION ended   -> the site is left exactly where it is: no advance call, no
//                    phase change, nothing marked failed
//   undecided     -> every site is held the same way (these steps spend)
//   ARION owned   -> advanced as before
import test from "node:test";
import assert from "node:assert/strict";

process.env.ARION_API_BASE = "https://arion.example.test";
process.env.ARION_INGEST_KEY = "ingest";
delete process.env.ONBOARDING_RUNNER_WORKER_DISABLED;

const { runOnboardingTick } = await import("../src/shared/onboardingRunner.js");
const { checkOwnership, clearOwnershipCache } = await import("../src/shared/productOwnership.js");

const ON = "11111111-1111-4111-8111-111111111111";
const OFF = "22222222-2222-4222-8222-222222222222";
const SITE_ON = "aaaaaaaa-0000-4000-8000-000000000001";
const SITE_OFF = "aaaaaaaa-0000-4000-8000-000000000002";
const quiet = { error() {}, log() {}, warn() {} };

function fakePlatform(rows, { fail = null } = {}) {
  return {
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query() {
          if (fail) throw new Error(fail);
          const ids = JSON.parse(inputs.ids);
          return { recordset: ids.filter((id) => id in rows).map((id) => ({ tenant_id: id.toLowerCase(), tenant_kind: "direct", has_on: rows[id], has_row: true })) };
        },
      };
      return req;
    },
  };
}
const ownershipOver = (platform) => (product, ids) => {
  clearOwnershipCache();
  return checkOwnership(product, ids, { getPlatformPool: async () => platform, log: quiet, env: { ENTITLEMENT_SYNC_MODE: "apply" } });
};

function servicesPool() {
  const writes = [];
  return {
    writes,
    request() {
      const inputs = {};
      const req = {
        input(name, a, b) { inputs[name] = arguments.length >= 3 ? b : a; return req; },
        async query(text) {
          const s = String(text);
          if (/FROM arion\.site s\s+WHERE/.test(s)) {
            return { recordset: [
              { site_id: SITE_ON, tenant_id: ON, domain: "owned.example.test", status_phase: "installing_plugins", provisioning_details_json: "{}" },
              { site_id: SITE_OFF, tenant_id: OFF, domain: "ended.example.test", status_phase: "installing_plugins", provisioning_details_json: "{}" },
            ] };
          }
          writes.push({ text: s, inputs: { ...inputs } });
          return { recordset: [], rowsAffected: [1] };
        },
      };
      return req;
    },
  };
}

async function tick(ownership) {
  const pool = servicesPool();
  const calls = [];
  const summary = await runOnboardingTick(pool, {
    log: () => {},
    ownership,
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); },
  });
  const touched = (siteId) => pool.writes.some((w) => Object.values(w.inputs).some((v) => String(v).toLowerCase() === siteId));
  return { summary, calls, touched };
}

test("onboarding worker: an ended ARION leaves the site where it is; the owned business advances as before", async () => {
  const { summary, calls, touched } = await tick(ownershipOver(fakePlatform({ [ON]: true, [OFF]: false })));
  assert.deepEqual(calls.map((c) => c.body.site_id), [SITE_ON], "only the owned business's set-up is advanced");
  assert.equal(touched(SITE_OFF), false, "nothing written for the ended business's site (not advanced, not marked failed)");
  assert.equal(touched(SITE_ON), true);
  assert.equal(summary.leftOut, 1);
  assert.equal(summary.advanced, 1);
});

test("onboarding worker: ownership cannot be checked -> every site is held, nothing started", async () => {
  const { summary, calls, touched } = await tick(ownershipOver(fakePlatform({}, { fail: "connect ETIMEDOUT" })));
  assert.equal(calls.length, 0);
  assert.equal(touched(SITE_ON), false);
  assert.equal(touched(SITE_OFF), false);
  assert.equal(summary.held, 2);
});

test("onboarding worker: both businesses own ARION -> both advance, as before", async () => {
  const { calls, summary } = await tick(ownershipOver(fakePlatform({ [ON]: true, [OFF]: true })));
  assert.deepEqual(calls.map((c) => c.body.site_id).sort(), [SITE_ON, SITE_OFF].sort());
  assert.equal(summary.advanced, 2);
});
