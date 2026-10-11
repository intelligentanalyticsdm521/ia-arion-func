// test/my-brand-social-follows-subscription.test.mjs — social posting and
// social analytics are My Brand, and follow the business's subscription
// (Brandon, 11 Oct 2026: "They only get the features for subscriptions they
// are signed up for").
//
// platform-api answers products.my_brand as owned when the business owns
// ARION OR SPARK (the 2026-08-21 ruling that a SPARK business never loses My
// Brand; LUMEN's gate reads the same node). The social analytics fetcher had no
// check at all, so it read every connected business's posts and made paid X
// reads for businesses with neither product.
//
// Runs the REAL fetcher run (runSocialAnalyticsTick) and the REAL helper with
// LUMEN, the database and platform-api stubbed:
//   neither product   -> left out: nothing read, nothing paid, nothing written
//   undecided         -> the free reads run as before; no paid X read
//   owned             -> as before, with the tier from the same payload
import test from "node:test";
import assert from "node:assert/strict";

const { keepRowsByPayload, payloadState } = await import("../src/shared/productOwnership.js");
const fetcher = await import("../src/functions/socialAnalyticsFetcher.js");

const OWNED = "11111111-1111-4111-8111-111111111111";
const NONE = "22222222-2222-4222-8222-222222222222";
const UNSURE = "33333333-3333-4333-8333-333333333333";
const quiet = { log() {}, warn() {}, error() {} };

const payloads = {
  [OWNED]: { decided: true, products: { arion: { owned: false, decided: true }, spark: { owned: true, tier: "pro", decided: true }, my_brand: { owned: true, tier: "pro", decided: true } } },
  [NONE]: { decided: true, products: { arion: { owned: false, decided: true }, spark: { owned: false, decided: true }, my_brand: { owned: false, tier: null, decided: true } } },
  [UNSURE]: null, // platform-api did not answer
};
const getEntitlements = async (id) => payloads[id];

test("payloadState / keepRowsByPayload: owned kept, not owned left out, undecided kept or held", async () => {
  assert.equal(payloadState(payloads[OWNED], "my_brand"), "owned");
  assert.equal(payloadState(payloads[NONE], "my_brand"), "not_owned");
  assert.equal(payloadState(null, "my_brand"), "undecided");
  assert.equal(payloadState({ products: { my_brand: { owned: true, decided: false } } }, "my_brand"), "undecided");
  const rows = [{ tenant_id: OWNED }, { tenant_id: NONE }, { tenant_id: UNSURE }, { tenant_id: null }];
  const pull = await keepRowsByPayload("my_brand", rows, { getEntitlements, log: quiet });
  assert.deepEqual(pull.kept.map((r) => r.tenant_id), [OWNED, UNSURE, null], "a background pull keeps what it cannot confirm");
  assert.deepEqual(pull.notOwned.map((r) => r.tenant_id), [NONE]);
  const send = await keepRowsByPayload("my_brand", rows, { getEntitlements, holdWhenUndecided: true, log: quiet });
  assert.deepEqual(send.kept.map((r) => r.tenant_id), [OWNED]);
  assert.deepEqual(send.held.map((r) => r.tenant_id), [UNSURE, null], "a send holds what it cannot confirm");
});

async function runFetcher() {
  const processed = [];
  let poolOpened = 0;
  const totals = await fetcher.runSocialAnalyticsTick(() => {}, {
    fetchTenants: async () => [
      { tenant_id: OWNED, tier: "standard", connections: [] },
      { tenant_id: NONE, tier: "business", connections: [] },
      { tenant_id: UNSURE, tier: "business", connections: [] },
    ],
    getPool: async () => { poolOpened++; return {}; },
    processTenant: async (_pool, tenant, _log, opts) => {
      processed.push({ id: tenant.tenant_id, opts, xReads: fetcher.xReadsAllowed(opts, tenant.tier) });
      return { inserted: 1, updated: 0, upsert_errors: 0 };
    },
    getEntitlements,
  });
  return { totals, processed, poolOpened };
}

test("social analytics: a business with neither ARION nor SPARK is left out (nothing read, nothing paid)", async () => {
  const { totals, processed } = await runFetcher();
  assert.ok(!processed.some((p) => p.id === NONE));
  assert.equal(totals.leftOut, 1);
  assert.equal(totals.tenants, 3);
});

test("social analytics: undecided -> the free reads run, but no paid X read", async () => {
  const { processed } = await runFetcher();
  const unsure = processed.find((p) => p.id === UNSURE);
  assert.ok(unsure, "its own posts are still read");
  assert.equal(unsure.opts.spendAllowed, false);
  assert.equal(unsure.xReads, false, "no X spend on 'we do not know', even with a Business hint");
});

test("social analytics: owned -> runs as before, the tier from the subscription", async () => {
  const { processed, totals } = await runFetcher();
  const owned = processed.find((p) => p.id === OWNED);
  assert.equal(owned.opts.spendAllowed, true);
  assert.equal(owned.opts.tier, "pro", "the payload's tier, not LUMEN's 'standard' hint");
  assert.equal(owned.xReads, true);
  assert.equal(totals.inserted, 2);
});

test("xReadsAllowed: confirmed only, and the tier must include X reads", () => {
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true, tier: "pro" }), true);
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true, tier: "standard" }), false);
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true }, "lite"), false);
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true }), true, "unknown tier on a confirmed business: allowed, the budget cap still applies");
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: false, tier: "business" }), false);
  assert.equal(fetcher.xReadsAllowed({}, "business"), false);
});
