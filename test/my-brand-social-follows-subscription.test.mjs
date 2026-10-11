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
//   owned             -> as before; paid X reads only where the same payload's
//                        features say my_brand_social_connect_x is in the plan
//                        (allowed false -> none, with the plan named; allowed
//                        null or a missing key -> held, a spend)
import test from "node:test";
import assert from "node:assert/strict";

const { keepRowsByPayload, payloadState } = await import("../src/shared/productOwnership.js");
const fetcher = await import("../src/functions/socialAnalyticsFetcher.js");

const OWNED = "11111111-1111-4111-8111-111111111111";
const NONE = "22222222-2222-4222-8222-222222222222";
const UNSURE = "33333333-3333-4333-8333-333333333333";
const OWNED_NO_X = "44444444-4444-4444-8444-444444444444";
const OWNED_X_UNDECIDED = "55555555-5555-4555-8555-555555555555";
const OWNED_NO_KEY = "66666666-6666-4666-8666-666666666666";
const X = fetcher.X_READS_FEATURE;
const xEntry = (allowed, needs = null) => ({ allowed, reason: "test", needs, product: "my_brand", min_tier: "pro", addon: null, addon_min_tier: null, kind: "action", availability: "live" });
const myBrand = (features) => ({ decided: true, products: { arion: { owned: true, tier: "standard", decided: true }, spark: { owned: false, decided: true }, my_brand: { owned: true, tier: "business", decided: true } }, features, sources: { catalog: "ok" } });
const quiet = { log() {}, warn() {}, error() {} };

const payloads = {
  [OWNED]: { decided: true, products: { arion: { owned: false, decided: true }, spark: { owned: true, tier: "pro", decided: true }, my_brand: { owned: true, tier: "pro", decided: true } }, features: { [X]: xEntry(true) }, sources: { catalog: "ok" } },
  // The node says Business, but the catalog answer is the only thing that decides X reads.
  [OWNED_NO_X]: myBrand({ [X]: xEntry(false, "My Brand Pro") }),
  [OWNED_X_UNDECIDED]: myBrand({ [X]: xEntry(null) }),
  [OWNED_NO_KEY]: myBrand({}),
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
      { tenant_id: OWNED_NO_X, tier: "business", connections: [] },
      { tenant_id: OWNED_X_UNDECIDED, tier: "business", connections: [] },
      { tenant_id: OWNED_NO_KEY, tier: "business", connections: [] },
    ],
    getPool: async () => { poolOpened++; return {}; },
    processTenant: async (_pool, tenant, _log, opts) => {
      processed.push({ id: tenant.tenant_id, opts, xReads: fetcher.xReadsAllowed(opts) });
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
  assert.equal(totals.tenants, 6);
});

test("social analytics: undecided -> the free reads run, but no paid X read", async () => {
  const { processed } = await runFetcher();
  const unsure = processed.find((p) => p.id === UNSURE);
  assert.ok(unsure, "its own posts are still read");
  assert.equal(unsure.opts.spendAllowed, false);
  assert.equal(unsure.xReads, false, "no X spend on 'we do not know', even with a Business hint");
});

test("social analytics: owned and X in the plan -> runs as before, with paid X reads", async () => {
  const { processed, totals } = await runFetcher();
  const owned = processed.find((p) => p.id === OWNED);
  assert.equal(owned.opts.spendAllowed, true);
  assert.equal(owned.opts.xPlan, "run");
  assert.equal(owned.xReads, true);
  assert.equal(totals.inserted, 5);
});

test("social analytics: X not in the plan -> the free reads run, no paid X read, and the plan it needs is said", async () => {
  const lines = [];
  const seen = [];
  await fetcher.runSocialAnalyticsTick((m) => lines.push(m), {
    fetchTenants: async () => [{ tenant_id: OWNED_NO_X, tier: "business", connections: [] }],
    getPool: async () => ({}),
    processTenant: async (_p, t, _l, opts) => { seen.push({ opts, xReads: fetcher.xReadsAllowed(opts) }); return { inserted: 0, updated: 0, upsert_errors: 0 }; },
    getEntitlements,
  });
  assert.equal(seen.length, 1, "its own posts are still read");
  assert.equal(seen[0].opts.spendAllowed, true);
  assert.equal(seen[0].opts.xPlan, "refuse");
  assert.equal(seen[0].opts.xNeeds, "My Brand Pro");
  assert.equal(seen[0].xReads, false, "a Business tier on the node does not buy X reads; the catalog decides");
  assert.ok(lines.some((l) => /needs My Brand Pro/.test(l)), lines.join(" | "));
});

test("social analytics: X undecided, or the key missing from the answer -> paid X reads are held", async () => {
  const { processed } = await runFetcher();
  for (const id of [OWNED_X_UNDECIDED, OWNED_NO_KEY]) {
    const p = processed.find((x) => x.id === id);
    assert.ok(p, "its own posts are still read");
    assert.equal(p.opts.spendAllowed, true);
    assert.equal(p.opts.xPlan, "hold");
    assert.equal(p.xReads, false);
  }
});

test("xReadsAllowed: My Brand confirmed AND the catalog says X is in the plan", () => {
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true, xPlan: "run" }), true);
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true, xPlan: "refuse" }), false);
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true, xPlan: "hold" }), false);
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: true }), false, "no catalog answer is no spend");
  assert.equal(fetcher.xReadsAllowed({ spendAllowed: false, xPlan: "run" }), false);
  assert.equal(fetcher.xReadsPlan(null).action, "hold");
  assert.equal(fetcher.xReadsPlan({ features: { [X]: xEntry(true) }, sources: { catalog: "unreadable" } }).action, "hold", "an unreadable catalog is undecided");
  assert.equal(fetcher.xReadsPlan(myBrand({ [X]: xEntry(true) })).action, "run");
});

test("no tier list for X reads is left in the fetcher (replace means delete)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/functions/socialAnalyticsFetcher.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /X_READ_TIERS/);
  assert.doesNotMatch(src, /new Set\(\[\s*"pro"/, "no set of tier words decides X reads");
});
