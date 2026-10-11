// test/timers-follow-subscription.test.mjs — every arion-func timer serves only
// the businesses that pay for its product (FEATURES rows 23-28, 32, 33 of the
// 2026-10-11 audit; Brandon: "They only get the features for
// subscriptions they are signed up for").
//
// Each runner below is the REAL code. The databases, platform-api, the sites,
// LUMEN, Google and SE Ranking are stubbed (global fetch is replaced, so nothing
// leaves this process). The ownership check is the real checkOwnership over a
// fake platform database in apply mode, as production is now.
//
// For each: product not in the subscription -> left out, nothing written or
// sent for it; undecided -> held where it is a send or a spend, as before where
// it is the business's own background data; in the subscription -> works as
// before.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SQL_SERVER = "";
process.env.SERVICES_SQL_SERVER = "";
process.env.LUMEN_API_BASE_URL = "https://lumen.example.test";
process.env.LUMEN_VOICE_INTERNAL_TOKEN = "voice-token";
process.env.LUMEN_SOCIAL_DISPATCH_TOKEN = "dispatch-token";
process.env.PLATFORM_API_URL = "https://platform.example.test";
process.env.PLATFORM_INTERNAL_TOKEN = "platform-token";
process.env.WEBHOOKS_BASE_URL = "https://webhooks.example.test";
process.env.IADM_WEBHOOK_KEY = "hook-key";
delete process.env.LEADGEN_DIGEST_DRY_RUN;

const own = await import("../src/shared/productOwnership.js");
const { checkOwnership, clearOwnershipCache, keepRowsOfOwners } = own;
const { runPluginSnapshot } = await import("../src/shared/pluginSnapshot.js");
const { runMonthlyPageSpeed } = await import("../src/shared/pagespeedRunner.js");
const { runMovesCapture, runBacklinkSnapshot, runPageChangeSweep } = await import("../src/shared/marketMonitor.js");
const { runPageVoiceScoreScan } = await import("../src/shared/pageVoiceScore.js");
const { runWeeklyDigestTick } = await import("../src/shared/weeklyDigestSender.js");
const { enqueueColdReverify } = await import("../src/functions/leadgenColdReverify.js");
const { runSocialDispatchTick } = await import("../src/shared/socialDispatcher.js");
const { maySpend, mayUseFeature } = await import("../src/shared/entitlementsRule.js");

const ON = "11111111-1111-4111-8111-111111111111";
const OFF = "22222222-2222-4222-8222-222222222222";
const SITE_ON = "aaaaaaaa-0000-4000-8000-000000000001";
const SITE_OFF = "aaaaaaaa-0000-4000-8000-000000000002";
const APPLY = { ENTITLEMENT_SYNC_MODE: "apply" };
const quiet = { error() {}, log() {}, warn() {} };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── fakes ─────────────────────────────────────────────────────────────── */

/** core.tenant_services as checkOwnership reads it. `rows` = { id: on? } */
function fakePlatform(rows, { fail = null } = {}) {
  return {
    request() {
      const inputs = {};
      const req = {
        input(name, _t, v) { inputs[name] = v; return req; },
        async query() {
          if (fail) throw new Error(fail);
          const ids = JSON.parse(inputs.ids);
          return {
            recordset: ids.filter((id) => id in rows).map((id) => ({
              tenant_id: id.toLowerCase(), tenant_kind: "direct", has_on: rows[id], has_row: true,
            })),
          };
        },
      };
      return req;
    },
  };
}
const offPlatform = () => fakePlatform({ [ON]: true, [OFF]: false });
const ownershipOver = (platform, getEntitlements) => (product, ids) => {
  clearOwnershipCache();
  return checkOwnership(product, ids, { getPlatformPool: async () => platform, log: quiet, env: APPLY, getEntitlements });
};
const ownershipUnreachable = () => ownershipOver(fakePlatform({}, { fail: "connect ETIMEDOUT" }));
// SPARK's "off" row is confirmed with platform-api before it stops anything.
const sparkDecidedOff = async () => ({ decided: true, products: { spark: { owned: false, decided: true } } });

/** A services pool that answers by regex and records every statement. */
function fakePool(answer = () => null) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, a, b) { inputs[name] = arguments.length >= 3 ? b : a; return req; },
        async query(text) {
          const s = String(text);
          calls.push({ text: s, inputs: { ...inputs } });
          return answer(s, inputs) || { recordset: [], rowsAffected: [1] };
        },
      };
      return req;
    },
  };
}
const named = (pool, value) => pool.calls.some((c) =>
  Object.values(c.inputs).some((v) => String(v).toLowerCase() === String(value).toLowerCase()) ||
  c.text.toLowerCase().includes(String(value).toLowerCase()));

/** Replace global fetch for one test; record every URL. */
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init = {}) => {
    urls.push({ url: String(url), init });
    const r = await handler(String(url), init);
    if (r) return r;
    return new Response(JSON.stringify({ error: "stubbed" }), { status: 503, headers: { "content-type": "application/json" } });
  };
  try { return await fn(urls); } finally { globalThis.fetch = real; }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const twoSites = (extra = {}) => [
  { site_id: SITE_ON, tenant_id: ON, domain: "owned.example.test", site_token_raw: "t1", wp_app_password_ref: "user:pw", se_ranking_project_id: 1, seo_addon_tier: "authority", ...extra },
  { site_id: SITE_OFF, tenant_id: OFF, domain: "ended.example.test", site_token_raw: "t2", wp_app_password_ref: "user:pw", se_ranking_project_id: 2, seo_addon_tier: "authority", ...extra },
];

/* ── the helper ────────────────────────────────────────────────────────── */

test("keepRowsOfOwners: owned kept, ended left out, undecided kept (or held for a send), no id kept", async () => {
  const rows = [{ tenant_id: ON }, { tenant_id: OFF }, { tenant_id: null }];
  const decided = await keepRowsOfOwners("arion", rows, { ownership: ownershipOver(offPlatform()), log: quiet });
  assert.deepEqual(decided.kept.map((r) => r.tenant_id), [ON, null]);
  assert.deepEqual(decided.leftOut.map((r) => r.tenant_id), [OFF]);
  const unknown = await keepRowsOfOwners("arion", rows, { ownership: ownershipUnreachable(), log: quiet });
  assert.equal(unknown.kept.length, 3, "a background pull runs as before when we cannot tell");
  const held = await keepRowsOfOwners("arion", rows, { ownership: ownershipUnreachable(), holdWhenUndecided: true, log: quiet });
  assert.equal(held.kept.length, 0, "a send is held when we cannot tell");
  assert.equal(held.held, true);
});

test("the copied SEAM-3-B rule answers every case in the byte-identical fixture", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "entitlement-rule-cases.json"), "utf8"));
  for (const c of cases.cases) {
    assert.equal(mayUseFeature(c.entry, c.min_tier), c.feature, `FEATURE — ${c.why}`);
    assert.equal(maySpend(c.entry, c.min_tier), c.spend, `SPEND — ${c.why}`);
  }
  const sibling = path.join(ROOT, "..", "arion-api-septa", "test", "fixtures", "entitlement-rule-cases.json");
  if (fs.existsSync(sibling)) {
    assert.equal(fs.readFileSync(path.join(ROOT, "test", "fixtures", "entitlement-rule-cases.json"), "utf8").replace(/\r\n/g, "\n"),
      fs.readFileSync(sibling, "utf8").replace(/\r\n/g, "\n"), "the fixture must stay byte-identical to arion-api's");
  }
});

/* ── row 24: plugin snapshot ───────────────────────────────────────────── */

test("plugin snapshot: an ended ARION's site is not pulled or written; the owned one is", async () => {
  const pool = fakePool((s) => (/FROM arion\.site/.test(s) && /site_token_raw/.test(s) ? { recordset: twoSites() } : null));
  await withFetch(() => null, async (urls) => {
    const r = await runPluginSnapshot(pool, () => {}, { ownership: ownershipOver(offPlatform()) });
    assert.equal(r.sitesChecked, 1);
    assert.equal(r.sitesLeftOut, 1);
    assert.ok(urls.some((u) => u.url.includes("owned.example.test")), "the owned site is pulled as before");
    assert.ok(!urls.some((u) => u.url.includes("ended.example.test")), "the ended site is never contacted");
    assert.equal(named(pool, SITE_OFF), false, "no statement for the ended site");
  });
});

test("plugin snapshot: undecided runs every site as before", async () => {
  const pool = fakePool((s) => (/FROM arion\.site/.test(s) && /site_token_raw/.test(s) ? { recordset: twoSites() } : null));
  await withFetch(() => null, async () => {
    const r = await runPluginSnapshot(pool, () => {}, { ownership: ownershipUnreachable() });
    assert.equal(r.sitesChecked, 2);
  });
});

/* ── row 25: monthly PageSpeed ─────────────────────────────────────────── */

test("PageSpeed: an ended ARION's site gets no test and no row; the owned one does", async () => {
  const pool = fakePool((s) => (/FROM arion\.site s/.test(s) ? { recordset: twoSites({ arion_tier: "business" }) } : null));
  const tested = [];
  const out = await runMonthlyPageSpeed(pool, () => {}, {
    force: true, ownership: ownershipOver(offPlatform()),
    runPSI: async (url, strategy) => { tested.push(`${url}|${strategy}`); return { scores: { performance: 90 } }; },
  });
  assert.equal(out.sitesProcessed, 1);
  assert.equal(out.sitesLeftOut, 1);
  assert.deepEqual(tested, ["https://owned.example.test|mobile", "https://owned.example.test|desktop"]);
  assert.equal(named(pool, SITE_OFF), false);
});

/* ── row 27: Market Monitor ────────────────────────────────────────────── */

test("Market Monitor: moves, backlinks and page changes leave an ended ARION's site untouched", async () => {
  for (const run of [runMovesCapture, runBacklinkSnapshot, runPageChangeSweep]) {
    const pool = fakePool((s) => {
      if (/FROM arion\.site/.test(s)) return { recordset: twoSites() };
      if (/INSERT INTO\s+arion\.market_monitor_job_log/.test(s)) return { recordset: [{ log_id: 1 }] };
      return null;
    });
    await withFetch(() => null, async (urls) => {
      const r = await run(pool, () => {}, { ownership: ownershipOver(offPlatform()) });
      assert.equal(r.sitesProcessed, 1, run.name);
      assert.equal(named(pool, SITE_OFF), false, `${run.name}: nothing written for the ended site`);
      assert.ok(named(pool, SITE_ON), `${run.name}: the owned site runs as before`);
      assert.ok(!urls.some((u) => u.url.includes("ended.example.test")), `${run.name}: the ended site is never contacted`);
    });
  }
});

/* ── row 28: page voice score (a model spend) ──────────────────────────── */

function voiceFetch(spent) {
  return (url) => {
    if (url.includes("/content/pages-recent")) {
      return json({ data: [{ post_id: 7, post_type: "page", link: `${new URL(url).origin}/about`, title: "About", content_html: "<p>" + "We mow lawns with care and pride. ".repeat(5) + "</p>" }] });
    }
    if (url.includes("/my-brand/voice/_internal/score")) {
      spent.push(url);
      return json({ data: { score: 0.8, drift_reasons: [], source: "model", check_id: 1 } });
    }
    return null;
  };
}
const arionPayload = (owned, decided = true) => async () => ({ decided, products: { arion: { owned, tier: "pro", decided } } });

test("voice score: an ended ARION is left out and no model call is made for it; the owned one is scored", async () => {
  const pool = fakePool((s) => (/FROM arion\.site/.test(s) && /wp_app_password_ref IS NOT NULL/.test(s) ? { recordset: twoSites() } : null));
  const spent = [];
  await withFetch(voiceFetch(spent), async (urls) => {
    const r = await runPageVoiceScoreScan(pool, () => {}, { ownership: ownershipOver(offPlatform()), getEntitlements: arionPayload(true) });
    assert.equal(r.sitesChecked, 1);
    assert.equal(spent.length, 1, "exactly one model call, for the owned site");
    assert.ok(!urls.some((u) => u.url.includes("ended.example.test")));
    assert.equal(named(pool, SITE_OFF), false);
  });
});

test("voice score: ARION owned but the subscription is undecided -> the spend is refused, nothing scored or written", async () => {
  const pool = fakePool((s) => (/FROM arion\.site/.test(s) && /wp_app_password_ref IS NOT NULL/.test(s) ? { recordset: twoSites() } : null));
  const spent = [];
  await withFetch(voiceFetch(spent), async () => {
    const r = await runPageVoiceScoreScan(pool, () => {}, { ownership: ownershipOver(offPlatform()), getEntitlements: arionPayload(true, false) });
    assert.equal(spent.length, 0, "no model call on 'we do not know'");
    assert.equal(r.sitesChecked, 0);
    assert.equal(r.spendRefused.length, 1);
    assert.match(r.spendRefused[0].reason, /could not confirm the ARION subscription/);
    assert.equal(pool.calls.filter((c) => /page_voice_score/.test(c.text)).length, 0);
  });
});

test("voice score: platform-api says ARION is not owned -> no model call", async () => {
  const pool = fakePool((s) => (/FROM arion\.site/.test(s) && /wp_app_password_ref IS NOT NULL/.test(s) ? { recordset: [twoSites()[0]] } : null));
  const spent = [];
  await withFetch(voiceFetch(spent), async () => {
    const r = await runPageVoiceScoreScan(pool, () => {}, { ownership: ownershipOver(offPlatform()), getEntitlements: arionPayload(false) });
    assert.equal(spent.length, 0);
    assert.match(r.spendRefused[0].reason, /ARION is not in this business's subscription/);
  });
});

/* ── row 32: lead-gen weekly digest (a send) ───────────────────────────── */

const DIGEST_ROW = {
  dispatch_count: 2, runs_count: 2, runs_skipped_count: 0, leads_total: 5, top_search_profile_name: "Lawns",
  leads_promoted: 1, leads_suppressed: 0, profile_id: 1, profile_name: "Lawns", ran_at: new Date(), leads_found: 5, status: "queued",
};
function digestPool(tenants) {
  return fakePool((s) => {
    if (/GROUP BY d\.tenant_id/.test(s)) return { recordset: tenants.map((t) => ({ tenant_id: t, dispatch_count: 2 })) };
    if (/lumen\./.test(s)) return { recordset: [DIGEST_ROW] };
    return null;
  });
}
const ownerPool = { request() { const r = { input() { return r; }, async query() { return { recordset: [{ business_name: "Fernbrook", primary_contact_email: "owner@example.test" }] }; } }; return r; } };
const sparkPayload = (owned, decided = true) => async () => ({ decided, products: { spark: { owned, tier: "standard", decided } } });
function platformApiFetch(url) {
  if (url.includes("/internal/notify/can-send")) return json({ allowed: true });
  if (url.includes("/internal/business-identity") || url.includes("/identity")) return json({ display_name: "Fernbrook" });
  return null;
}
async function digest({ tenants = [ON, OFF], ownership, getEntitlements }) {
  const sent = [];
  const summary = await withFetch(platformApiFetch, () => runWeeklyDigestTick(digestPool(tenants), () => {}, {
    ownership, getEntitlements, getPlatformPool: async () => ownerPool,
    send: async (m) => { sent.push(m); return { messageId: "m1" }; },
  }));
  return { summary, sent };
}

test("weekly digest: a business without SPARK gets no email; the SPARK business gets it as before", async () => {
  const { summary, sent } = await digest({ ownership: ownershipOver(offPlatform(), sparkDecidedOff), getEntitlements: sparkPayload(true) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tenantId, ON);
  assert.equal(summary.skipped_not_owned, 1);
});

test("weekly digest: the live check right before the send stops a business whose SPARK just ended", async () => {
  const { summary, sent } = await digest({ tenants: [ON], ownership: ownershipOver(offPlatform()), getEntitlements: sparkPayload(false) });
  assert.equal(sent.length, 0);
  assert.equal(summary.skipped_not_owned, 1);
});

test("weekly digest: undecided (live check or ownership) holds the email; nothing is sent", async () => {
  const live = await digest({ tenants: [ON], ownership: ownershipOver(offPlatform()), getEntitlements: sparkPayload(true, false) });
  assert.equal(live.sent.length, 0);
  assert.equal(live.summary.held_undecided, 1);
  const list = await digest({ tenants: [ON], ownership: ownershipUnreachable(), getEntitlements: sparkPayload(true) });
  assert.equal(list.sent.length, 0);
  assert.equal(list.summary.held_undecided, 1);
});

/* ── row 33: lead-gen cold re-verify ───────────────────────────────────── */

test("cold re-verify: leads of a business without SPARK are not touched; the SPARK business's are", async () => {
  const services = fakePool((s) => (/FROM lumen\.search_profile/.test(s) ? { recordset: [{ tenant_id: ON }, { tenant_id: OFF }] } : null));
  const platform = fakePool((s) => (/FROM platform\.lead_cache lc/.test(s) ? { recordset: [{ id: 41, domain: "a.test", composite_score: 50 }] } : { recordset: [], rowsAffected: [1] }));
  const r = await enqueueColdReverify({ dryRun: false, ageDays: 14, scoreMin: 40, scoreMax: 70, maxPerTick: 10 }, () => {}, {
    getServicesPool: async () => services, getPlatformPool: async () => platform,
    ownership: ownershipOver(offPlatform(), sparkDecidedOff),
  });
  const candidateCall = platform.calls.find((c) => /FROM platform\.lead_cache lc/.test(c.text));
  assert.ok(Object.values(candidateCall.inputs).includes(ON), "the SPARK business's leads are looked at");
  assert.ok(!Object.values(candidateCall.inputs).includes(OFF), "the ended business's leads are not");
  assert.equal(r.enqueued, 1);
});

/* ── row 23: social post dispatcher (a send) ───────────────────────────── */

function socialFetch(posts, patched) {
  return async (url, init = {}) => {
    if (url.includes("/_internal/due-posts")) return json({ data: posts });
    if (url.includes("/_internal/post/")) { patched.push(url); return json({ data: { post_status: "published" } }); }
    return json({}, 404);
  };
}
const POSTS = [
  { post_id: "p-on", tenant_id: ON, body_default: "Hello", targets: [{ platform: "facebook", access_token_kv_ref: "kv-1", page_id: "1" }] },
  { post_id: "p-off", tenant_id: OFF, body_default: "Hello", targets: [{ platform: "facebook", access_token_kv_ref: "kv-2", page_id: "2" }] },
];
// Social posts are My Brand: platform-api answers products.my_brand as owned
// when the business owns ARION OR SPARK.
const myBrand = (byTenant) => async (id) => {
  const v = byTenant[id];
  if (v === undefined) return null; // platform-api did not answer
  return { decided: true, products: { my_brand: { owned: v, tier: v ? "standard" : null, decided: true } } };
};
async function dispatch(getEntitlements, posts = POSTS) {
  const patched = [];
  const published = [];
  const summary = await runSocialDispatchTick(() => {}, {
    getEntitlements,
    fetchImpl: socialFetch(posts, patched),
    getSecret: async () => "token",
    publishers: { facebook: async (args) => { published.push(args.pageId); return { ok: true, external_post_id: "x" }; } },
  });
  return { summary, patched, published };
}

test("social dispatcher: a post of a business without My Brand (neither ARION nor SPARK) is not published and not marked done", async () => {
  const { summary, patched, published } = await dispatch(myBrand({ [ON]: true, [OFF]: false }));
  assert.deepEqual(published, ["1"], "only the owned business's post goes out");
  assert.equal(patched.length, 1);
  assert.ok(patched[0].includes("p-on"));
  assert.ok(!patched.some((u) => u.includes("p-off")), "the ended business's post is left as it is");
  assert.equal(summary.left_out, 1);
});

test("social dispatcher: undecided holds every post (nothing published, nothing marked)", async () => {
  for (const getEntitlements of [myBrand({}), async (id) => ({ decided: false, products: { my_brand: { owned: true, decided: false } } })]) {
    const { published, patched } = await dispatch(getEntitlements);
    assert.equal(published.length, 0);
    assert.equal(patched.length, 0);
  }
});

test("social dispatcher: a SPARK-only business has My Brand, so its approved post is published", async () => {
  // The platform-api payload as it answers a business with SPARK and no ARION.
  const sparkOnly = async () => ({
    decided: true,
    products: {
      arion: { owned: false, tier: null, decided: true },
      spark: { owned: true, tier: "standard", decided: true },
      my_brand: { owned: true, tier: "standard", decided: true },
    },
  });
  const { published, patched, summary } = await dispatch(sparkOnly, [POSTS[0]]);
  assert.deepEqual(published, ["1"]);
  assert.equal(patched.length, 1);
  assert.equal(summary.left_out, 0);
});
