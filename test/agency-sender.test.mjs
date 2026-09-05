// test/agency-sender.test.mjs — October pull-forward item 3.
//
// The weekly Lead Gen digest is sent BY the agency TO the client. That
// direction is right. The agency's NAME was a string literal in two places —
// the From: display name and the email footer — so a second agency running
// this platform would have signed its own clients' mail with our company
// name, and nobody could have changed it without a code deploy.
//
// Source shape is read with \r\n normalised.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.join(HERE, "..", "src", "shared");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

test("no runtime source signs a client's email with a typed-in agency name", () => {
  const offenders = walk(path.join(HERE, "..", "src"))
    .map((p) => ({ p, code: stripComments(read(p)) }))
    .filter(({ code }) => /Intelligent Analytics/.test(code))
    .map(({ p }) => path.relative(path.join(HERE, ".."), p).replace(/\\/g, "/"));
  assert.deepEqual(offenders, [],
    `these files still hardcode the agency name:\n  ${offenders.join("\n  ")}`);
});

test('no runtime source falls back to the product codename "Lead Gen"', () => {
  // Pack 4b's note says the "Lead Gen" fallback is gone. It was gone from the
  // SENDER; the TEMPLATE still had its own copy one function call away, and a
  // client whose name did not resolve would have been addressed by our
  // internal product name in the subject line.
  const offenders = walk(path.join(HERE, "..", "src"))
    .map((p) => ({ p, code: stripComments(read(p)) }))
    .filter(({ code }) => /\|\|\s*"Lead Gen"/.test(code))
    .map(({ p }) => path.relative(path.join(HERE, ".."), p).replace(/\\/g, "/"));
  assert.deepEqual(offenders, [], `still falling back to "Lead Gen":\n  ${offenders.join("\n  ")}`);
});

test("the founder tenant id lives in exactly one module in this repo", async () => {
  const GUID = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";
  const offenders = walk(path.join(HERE, "..", "src"))
    .filter((p) => !p.endsWith(path.join("shared", "agency.js")))
    .filter((p) => new RegExp(GUID, "i").test(read(p)))
    .map((p) => path.relative(path.join(HERE, ".."), p).replace(/\\/g, "/"));
  assert.deepEqual(offenders, [],
    `the GUID belongs only in src/shared/agency.js:\n  ${offenders.join("\n  ")}`);

  const { founderTenantId } = await import("../src/shared/agency.js");
  assert.equal(founderTenantId({}), GUID, "the default is what actually runs — it is not set in prod");
  assert.equal(founderTenantId({ FOUNDER_TENANT_ID: "abc-DEF" }), "ABC-DEF");
  assert.equal(founderTenantId({ PLATFORM_OWNER_TENANT_ID: "xyz" }), "XYZ",
    "the second env name oliver's stripeConnect used is accepted here too");
  assert.equal(founderTenantId({ FOUNDER_TENANT_ID: "a", PLATFORM_OWNER_TENANT_ID: "b" }), "A",
    "FOUNDER_TENANT_ID is canonical when both are set");
});

test("the sender resolves the agency name through the ONE business identity", async () => {
  const { agencyDisplayName } = await import("../src/shared/agencyIdentity.js");
  const { clearIdentityCache } = await import("../src/shared/businessIdentity.js");
  clearIdentityCache();

  process.env.PLATFORM_API_URL = "http://127.0.0.1:9/platform";
  process.env.PLATFORM_INTERNAL_TOKEN = "t";

  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return {
      ok: true,
      json: async () => ({ tenant_id: "x", found: true, display_name: "Waddle Marketing Co." }),
    };
  };

  const name = await agencyDisplayName({ fetchImpl });
  assert.equal(name, "Waddle Marketing Co.", "the name comes from the resolver, not from the code");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /\/internal\/business-identity\/8c9527b9-8999-4b31-a306-f3d4ccc39fbd$/,
    "and it asks about the AGENCY tenant, not a client");
  clearIdentityCache();
});

test("one digest run makes ONE call for the agency name, not one per recipient", async () => {
  const { agencyDisplayName } = await import("../src/shared/agencyIdentity.js");
  const { clearIdentityCache } = await import("../src/shared/businessIdentity.js");
  clearIdentityCache();
  process.env.PLATFORM_API_URL = "http://127.0.0.1:9/platform";
  process.env.PLATFORM_INTERNAL_TOKEN = "t";

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => ({ found: true, display_name: "Waddle Marketing Co." }) };
  };
  // 40 client businesses in one Monday-morning tick.
  for (let i = 0; i < 40; i++) await agencyDisplayName({ fetchImpl });
  assert.equal(calls, 1, "the 60-second identity cache absorbs the rest");
  clearIdentityCache();
});

test("the cache expires after 60 seconds — a rename is picked up, eventually", async () => {
  const { agencyDisplayName } = await import("../src/shared/agencyIdentity.js");
  const { clearIdentityCache, IDENTITY_TTL_MS } = await import("../src/shared/businessIdentity.js");
  clearIdentityCache();
  process.env.PLATFORM_API_URL = "http://127.0.0.1:9/platform";
  process.env.PLATFORM_INTERNAL_TOKEN = "t";

  let n = 0;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ found: true, display_name: `Name ${++n}` }),
  });

  let clock = 1_000_000;
  const now = () => clock;
  assert.equal(await agencyDisplayName({ fetchImpl, now }), "Name 1");
  clock += IDENTITY_TTL_MS - 1;
  assert.equal(await agencyDisplayName({ fetchImpl, now }), "Name 1", "still inside the window");
  clock += 2;
  assert.equal(await agencyDisplayName({ fetchImpl, now }), "Name 2", "and re-asked after it");
  clearIdentityCache();
});

test("a platform blip serves the LAST KNOWN agency name, never a rename mid-send", async () => {
  const { agencyDisplayName } = await import("../src/shared/agencyIdentity.js");
  const { clearIdentityCache, IDENTITY_TTL_MS, NEUTRAL_BUSINESS_NAME } =
    await import("../src/shared/businessIdentity.js");
  clearIdentityCache();
  process.env.PLATFORM_API_URL = "http://127.0.0.1:9/platform";
  process.env.PLATFORM_INTERNAL_TOKEN = "t";

  let clock = 2_000_000;
  const now = () => clock;
  const ok = async () => ({ ok: true, json: async () => ({ found: true, display_name: "Waddle Marketing Co." }) });
  const down = async () => { throw new Error("ECONNREFUSED"); };

  assert.equal(await agencyDisplayName({ fetchImpl: ok, now }), "Waddle Marketing Co.");
  clock += IDENTITY_TTL_MS + 1;
  assert.equal(await agencyDisplayName({ fetchImpl: down, now, log: { warn() {} } }),
    "Waddle Marketing Co.",
    "a thirty-second outage must not re-brand a live client's mail");

  // Only with no history at all does it fall back — to the platform's ONE
  // neutral name, never to somebody else's brand and never to a codename.
  clearIdentityCache();
  assert.equal(await agencyDisplayName({ fetchImpl: down, now, log: { warn() {} } }),
    NEUTRAL_BUSINESS_NAME);
  clearIdentityCache();
});

test("LEADGEN_DIGEST_FROM_NAME is an override that WINS, not a fallback", () => {
  // The distinction matters: as a fallback, an unset env var means "guess". As
  // an override it means "an operator said so", and the resolver answers
  // otherwise. The old code had it the first way with a literal behind it.
  const code = stripComments(read(path.join(SHARED, "weeklyDigestSender.js")));
  assert.match(code, /process\.env\.LEADGEN_DIGEST_FROM_NAME \|\| ""/,
    "an unset override must be empty, not a name");
  assert.match(code, /\|\|\s*\(await agencyDisplayName\(\)\)/,
    "and the resolver is what answers when it is unset");
});

test("the digest template takes both names as arguments and hardcodes neither", async () => {
  const { renderWeeklyDigestHtml } = await import("../src/shared/weeklyDigestTemplate.js");
  const digest = { window: { start: "2026-09-01", end: "2026-09-08" }, runs_count: 2, leads_total: 5 };

  const r = renderWeeklyDigestHtml(digest, "Waddle Exteriors", "Acme Agency");
  assert.match(r.subject, /^Waddle Exteriors —/, "the CLIENT is named in the subject");
  assert.match(r.html, /Acme Agency · \d{4}/, "the AGENCY signs the footer");
  assert.ok(!/Intelligent Analytics/.test(r.html), "and no company name is typed in");

  // The last resorts are neutral, not a product codename and not a brand.
  const { NEUTRAL_BUSINESS_NAME } = await import("../src/shared/businessIdentity.js");
  const bare = renderWeeklyDigestHtml(digest, "", "");
  assert.match(bare.subject, new RegExp(`^${NEUTRAL_BUSINESS_NAME} —`));
  assert.match(bare.html, new RegExp(`${NEUTRAL_BUSINESS_NAME} · \\d{4}`));
  assert.ok(!/Lead Gen —/.test(bare.subject), "never our internal product name");
});
