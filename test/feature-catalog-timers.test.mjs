/**
 * arion-func's timers name their feature catalog key (scope 2.4, 11 Oct 2026):
 *   Market Monitor (moves competitor capture, backlinks, page changes)
 *     -> arion_seo_market_monitor; the rung each site needs is the catalog
 *        row's addon_min_tier, the rung it has is arion.site.seo_addon_tier
 *   page voice score -> my_brand_voice_monitor (a model spend)
 *
 * Runs the REAL timers with the services database and platform-api stubbed:
 *   allowed false -> the business is left out, untouched, with the plan it needs
 *   allowed null  -> held (a job / a spend): nothing done, asked next run
 *   allowed true  -> runs as before
 *   key missing / catalog unreadable -> held, logged
 * plus the fixture pin and the startup check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SQL_SERVER = "";
process.env.SERVICES_SQL_SERVER = "";
process.env.LUMEN_API_BASE_URL = "https://lumen.example.test";
process.env.LUMEN_VOICE_INTERNAL_TOKEN = "voice-token";
process.env.PLATFORM_API_URL = "https://platform.example.test";
process.env.PLATFORM_INTERNAL_TOKEN = "platform-token";
// SE Ranking calls go to a stubbed fetch (no real host is ever contacted).
process.env.SERANKING_API_SYSTEM_KEY = "test-key";
process.env.SERANKING_PROJECT_API_BASE = "https://seranking.example.test";

const { featureGate, featureDecision, rungMeets, keepRowsWithFeature, HOLDING_INTENTS } = await import("../src/shared/featureGate.js");
const { runPageChangeSweep, runBacklinkSnapshot, runMovesCapture, MARKET_MONITOR_FEATURE } = await import("../src/shared/marketMonitor.js");
const { runPageVoiceScoreScan, VOICE_MONITOR_FEATURE } = await import("../src/shared/pageVoiceScore.js");
const { namedFeatureKeys, checkFeatureKeysAtStartup } = await import("../src/shared/featureKeys.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = "11111111-1111-4111-8111-111111111111";
const SITE_AUTH = "aaaaaaaa-0000-4000-8000-0000000000a1";
const SITE_GROW = "aaaaaaaa-0000-4000-8000-0000000000a2";
const ALL_OWNED = async (product, ids) => ({ product, owned: [...ids], off: [], held: [], unknown: [], undecided: false, error: null, mode: "apply" });

const row = (allowed, over = {}) => ({
  allowed, reason: allowed === true ? "included" : allowed === false ? "needs the ARION SEO add-on (Authority)" : "could not tell",
  needs: allowed === true ? null : "the ARION SEO add-on (Authority)",
  product: "arion", min_tier: null, addon: "seo", addon_min_tier: "authority", kind: "page", availability: "live", ...over,
});
const payload = (features, { catalog = "ok" } = {}) => async () => ({
  decided: true, products: { arion: { owned: true, tier: "pro", decided: true } },
  features: catalog === "ok" ? features : {}, sources: { catalog },
});

function fakePool(sites) {
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
          if (/FROM arion\.site\b/.test(s) && !/site_page_watch/.test(s)) return { recordset: sites };
          if (/INSERT INTO\s+arion\.market_monitor_job_log/.test(s)) return { recordset: [{ log_id: 1 }] };
          return { recordset: [], rowsAffected: [1] };
        },
      };
      return req;
    },
  };
}
const touched = (pool, siteId) => pool.calls.some((c) => Object.values(c.inputs).some((v) => String(v).toLowerCase() === siteId.toLowerCase()));
const SITES = [
  { site_id: SITE_AUTH, tenant_id: T, domain: "auth.example.test", se_ranking_project_id: 1, seo_addon_tier: "authority" },
  { site_id: SITE_GROW, tenant_id: T, domain: "grow.example.test", se_ranking_project_id: 2, seo_addon_tier: "growth" },
];

test("featureGate: verbatim rule; a timer's job and spend intents hold on undecided", () => {
  assert.deepEqual(HOLDING_INTENTS, ["send", "cross_write", "spend", "job"]);
  const f = { a: row(true), b: row(false), c: row(null) };
  assert.equal(featureGate(f, "a", "job").action, "run");
  assert.equal(featureGate(f, "b", "job").action, "refuse");
  assert.equal(featureGate(f, "b", "job").needs, "the ARION SEO add-on (Authority)");
  assert.equal(featureGate(f, "c", "job").action, "hold");
  assert.equal(featureGate(f, "c", "read").action, "run");
  assert.equal(featureGate(f, "zz", "job").action, "hold");
  assert.equal(featureGate(f, "zz", "job").log, "error");
});

test("featureDecision: no payload or an unreadable catalog holds a job", async () => {
  assert.equal((await featureDecision(T, MARKET_MONITOR_FEATURE, "job", { getEntitlements: async () => null })).action, "hold");
  assert.equal((await featureDecision(T, MARKET_MONITOR_FEATURE, "job", { getEntitlements: payload({}, { catalog: "unreadable" }) })).action, "hold");
  assert.equal((await featureDecision(T, MARKET_MONITOR_FEATURE, "job", { getEntitlements: async () => { throw new Error("down"); } })).action, "hold");
});

test("rungMeets + keepRowsWithFeature: one payload read per business; the site's rung against the row's", async () => {
  assert.equal(rungMeets("growth", "authority"), false);
  assert.equal(rungMeets("authority", "authority"), true);
  assert.equal(rungMeets("starter", null), true);
  let reads = 0;
  const out = await keepRowsWithFeature(MARKET_MONITOR_FEATURE, SITES, {
    getEntitlements: async () => { reads++; return (await payload({ [MARKET_MONITOR_FEATURE]: row(true) })()); },
    siteOk: (s, e) => rungMeets(s.seo_addon_tier, e.addon_min_tier), log: { error() {}, warn() {} },
  });
  assert.equal(reads, 1);
  assert.deepEqual(out.kept.map((s) => s.site_id), [SITE_AUTH]);
});

for (const [name, run] of [["page changes", runPageChangeSweep], ["backlinks", runBacklinkSnapshot]]) {
  test(`Market Monitor ${name}: plan includes it -> only the site whose rung reaches the catalog's runs`, async () => {
    const pool = fakePool(SITES);
    const r = await run(pool, () => {}, { ownership: ALL_OWNED, getEntitlements: payload({ [MARKET_MONITOR_FEATURE]: row(true) }) });
    assert.equal(r.sitesProcessed, 1);
    assert.equal(touched(pool, SITE_AUTH), true);
    assert.equal(touched(pool, SITE_GROW), false, "the Growth site is untouched");
  });

  test(`Market Monitor ${name}: the rung comes from the catalog row (lowered to growth -> both run)`, async () => {
    const pool = fakePool(SITES);
    const r = await run(pool, () => {}, { ownership: ALL_OWNED, getEntitlements: payload({ [MARKET_MONITOR_FEATURE]: row(true, { addon_min_tier: "growth" }) }) });
    assert.equal(r.sitesProcessed, 2);
  });

  test(`Market Monitor ${name}: not in the plan, undecided, missing key or unreadable catalog -> nothing touched`, async () => {
    for (const getEntitlements of [
      payload({ [MARKET_MONITOR_FEATURE]: row(false) }),
      payload({ [MARKET_MONITOR_FEATURE]: row(null) }),
      payload({}),
      payload({ [MARKET_MONITOR_FEATURE]: row(true) }, { catalog: "unreadable" }),
      async () => null,
    ]) {
      const pool = fakePool(SITES);
      const lines = [];
      const r = await run(pool, (m) => lines.push(m), { ownership: ALL_OWNED, getEntitlements });
      assert.equal(r.sitesProcessed, 0);
      assert.equal(touched(pool, SITE_AUTH), false);
      assert.ok(lines.some((l) => /not in its plan|held/.test(l)), "the log says why");
    }
  });
}

test("Market Monitor moves: own-site capture runs for every project site; competitor capture only where the catalog allows", async () => {
  const lines = [];
  const urls = [];
  const record = (url) => { urls.push(url); return null; };
  await withFetch(record, () => runMovesCapture(fakePool(SITES), (m) => lines.push(m), { ownership: ALL_OWNED, getEntitlements: payload({ [MARKET_MONITOR_FEATURE]: row(true) }) }));
  assert.ok(lines.some((l) => /processing 2 project site\(s\) \(1 with Market Monitor\)/.test(l)), lines.join("\n"));
  assert.ok(urls.some((u) => u.endsWith("/sites/1/positions")) && urls.some((u) => u.endsWith("/sites/2/positions")), "own-site positions for both");
  assert.ok(urls.some((u) => u.endsWith("/competitors/site/1")), "competitors for the Authority site");
  assert.ok(!urls.some((u) => u.endsWith("/competitors/site/2")), "no competitor capture for the Growth site");
  const held = [];
  const heldUrls = [];
  await withFetch((u) => { heldUrls.push(u); return null; }, () => runMovesCapture(fakePool(SITES), (m) => held.push(m), { ownership: ALL_OWNED, getEntitlements: payload({ [MARKET_MONITOR_FEATURE]: row(null) }) }));
  assert.ok(held.some((l) => /processing 2 project site\(s\) \(0 with Market Monitor\)/.test(l)));
  assert.ok(!heldUrls.some((u) => u.includes("/competitors/")), "undecided: no competitor capture");
});

test("Market Monitor no longer states a rung of its own", () => {
  const src = fs.readFileSync(path.join(ROOT, "src", "shared", "marketMonitor.js"), "utf8");
  assert.doesNotMatch(src, /=\s*['"]authority['"]/i);
  assert.doesNotMatch(src, /LOWER\(seo_addon_tier\)\s*=/);
});

/* ── page voice score ─────────────────────────────────────────────────── */

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => (await handler(String(url))) || new Response("{}", { status: 503 });
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const jsonRes = (b) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
function voiceWorld() {
  const spent = [];
  const handler = (url) => {
    if (url.includes("/content/pages-recent")) return jsonRes({ data: [{ post_id: 7, post_type: "page", link: `${new URL(url).origin}/about`, title: "About", content_html: "<p>" + "We mow lawns with care and pride. ".repeat(5) + "</p>" }] });
    if (url.includes("/my-brand/voice/_internal/score")) { spent.push(url); return jsonRes({ data: { score: 0.8, drift_reasons: [], source: "model", check_id: 1 } }); }
    return null;
  };
  const pool = fakePool([{ site_id: SITE_AUTH, tenant_id: T, domain: "auth.example.test", site_token_raw: "t", wp_app_password_ref: "user:pw" }]);
  return { spent, handler, pool };
}
const voice = (allowed) => payload({ [VOICE_MONITOR_FEATURE]: { ...row(allowed), product: "my_brand", addon: null, addon_min_tier: null, min_tier: "pro", needs: allowed === true ? null : "ARION Pro" } });

test("voice score: Voice Monitor in the plan -> scored (one model call)", async () => {
  const w = voiceWorld();
  await withFetch(w.handler, async () => {
    const r = await runPageVoiceScoreScan(w.pool, () => {}, { ownership: ALL_OWNED, getEntitlements: voice(true) });
    assert.equal(r.sitesChecked, 1);
    assert.equal(w.spent.length, 1);
  });
});

test("voice score: not in the plan -> no model call, the reason names the plan", async () => {
  const w = voiceWorld();
  await withFetch(w.handler, async () => {
    const r = await runPageVoiceScoreScan(w.pool, () => {}, { ownership: ALL_OWNED, getEntitlements: voice(false) });
    assert.equal(w.spent.length, 0);
    assert.equal(r.sitesChecked, 0);
    assert.match(r.spendRefused[0].reason, /Voice Monitor is not in this business's plan \(needs ARION Pro\)/);
  });
});

test("voice score: undecided, missing key or unreadable catalog -> the spend is held", async () => {
  for (const getEntitlements of [voice(null), payload({}), payload({ [VOICE_MONITOR_FEATURE]: row(true) }, { catalog: "unreadable" })]) {
    const w = voiceWorld();
    await withFetch(w.handler, async () => {
      const r = await runPageVoiceScoreScan(w.pool, () => {}, { ownership: ALL_OWNED, getEntitlements });
      assert.equal(w.spent.length, 0);
      assert.match(r.spendRefused[0].reason, /could not confirm Voice Monitor/);
    });
  }
});

/* ── the keys, the fixture, the startup check ─────────────────────────── */

test("every key the timers gate on is in this repo's copy of the catalog keys", () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "feature-keys.json"), "utf8"));
  assert.equal(j.count, j.keys.length);
  const have = new Set(j.keys);
  assert.deepEqual(namedFeatureKeys(), ["arion_seo_market_monitor", "my_brand_social_connect_x", "my_brand_voice_monitor"]);
  for (const k of namedFeatureKeys()) assert.ok(have.has(k), k);
});

test("a source scan: every *_FEATURE constant in src/ is in namedFeatureKeys()", () => {
  const named = new Set(namedFeatureKeys());
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const found = [];
  for (const f of walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".js"))) {
    for (const m of fs.readFileSync(f, "utf8").matchAll(/_FEATURE\s*=\s*"([a-z0-9_]+)"/g)) found.push(m[1]);
  }
  assert.ok(found.length >= 2);
  for (const k of found) assert.ok(named.has(k), `${k} is not in src/shared/featureKeys.js`);
});

test("startup check: logs every named key the catalog lacks; quiet when all present; never throws", async () => {
  const env = { PLATFORM_API_URL: "https://platform.example.test", PLATFORM_INTERNAL_TOKEN: "t" };
  const errors = []; const logs = []; const warns = [];
  const log = { error: (m) => errors.push(m), log: (m) => logs.push(m), warn: (m) => warns.push(m) };
  let asked = null;
  const r = await checkFeatureKeysAtStartup({ env, log, fetchImpl: async (url, o) => { asked = { url, tok: o.headers["x-internal-token"] }; return jsonRes({ features: [{ key: "arion_seo_market_monitor" }] }); } });
  assert.match(asked.url, /\/internal\/feature-catalog$/);
  assert.equal(asked.tok, "t");
  assert.deepEqual(r.missing, ["my_brand_social_connect_x", "my_brand_voice_monitor"]);
  assert.equal(errors.length, 1);
  const ok = await checkFeatureKeysAtStartup({ env, log, fetchImpl: async () => jsonRes({ features: namedFeatureKeys().map((key) => ({ key })) }) });
  assert.deepEqual(ok.missing, []);
  assert.equal((await checkFeatureKeysAtStartup({ env: {}, log })).checked, false);
  assert.equal((await checkFeatureKeysAtStartup({ env, log, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } })).checked, false);
  assert.equal(errors.length, 1);
});

test("the startup check runs once when the Functions host loads src/index.js", () => {
  const index = fs.readFileSync(path.join(ROOT, "src", "index.js"), "utf8");
  assert.match(index, /import \{ checkFeatureKeysAtStartup \} from "\.\/shared\/featureKeys\.js";/);
  assert.match(index, /^checkFeatureKeysAtStartup\(\)\.catch\(/m);
});
