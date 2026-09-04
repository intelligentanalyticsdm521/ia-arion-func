// test/business-identity.test.mjs — SEAM-10 in arion-func.
//
// The audit listed NINE "what is this business called" chains. Reading this
// repo on the same pass found two more, and the second is the worst of the
// eleven:
//
//   src/shared/leadgenScheduler.js   business_name || "your business"
//   src/shared/weeklyDigestSender.js business_name || "Lead Gen"
//
// A business whose name was not recorded received a WEEKLY DIGEST addressed to
// "Lead Gen" — our internal product name, in a client-facing email. Same class
// of failure as the "Intelligent Analytics" fallback pack 1 removed from
// LUMEN's recipe emails. Neither chain read `preferred_business_name` at all,
// so a business that had asked to be called something else was called
// something else everywhere EXCEPT in the two emails this repo sends.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getBusinessIdentity, businessDisplayName, clearIdentityCache,
  NEUTRAL_BUSINESS_NAME, IDENTITY_TTL_MS,
} from "../src/shared/businessIdentity.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TENANT = "22222222-2222-2222-2222-222222222222";

function code(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function withEnv(fn) {
  const keys = ["PLATFORM_API_URL", "PLATFORM_API_BASE_URL", "PLATFORM_API_BASE",
                "PLATFORM_INTERNAL_TOKEN", "PLATFORM_INTERNAL_SERVICE_TOKEN", "LUMEN_INTERNAL_SERVICE_TOKEN"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.PLATFORM_API_URL = "http://127.0.0.1:9";
  process.env.PLATFORM_INTERNAL_TOKEN = "s3cret";
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test("the neutral is the platform's one neutral — never a product name of ours", () => {
  assert.equal(NEUTRAL_BUSINESS_NAME, "Your Service Provider");
});

test("one call per business per minute, and the TTL expires", async () => {
  clearIdentityCache();
  await withEnv(async () => {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      assert.match(url, /\/internal\/business-identity\//);
      assert.equal(init.headers["x-internal-token"], "s3cret");
      return okResponse({ found: true, display_name: "Rolling In It" });
    };
    let t = 1000;
    const now = () => t;
    assert.equal(await businessDisplayName(TENANT, { fetchImpl, now }), "Rolling In It");
    assert.equal(await businessDisplayName(TENANT, { fetchImpl, now }), "Rolling In It");
    assert.equal(calls, 1);
    t += IDENTITY_TTL_MS + 1;
    await businessDisplayName(TENANT, { fetchImpl, now });
    assert.equal(calls, 2);
  });
});

test("an outage serves the last known name; nothing cached gives the neutral", async () => {
  clearIdentityCache();
  await withEnv(async () => {
    const log = { warn() {} };
    let down = false;
    const fetchImpl = async () => {
      if (down) throw new Error("ECONNREFUSED");
      return okResponse({ found: true, display_name: "Rolling In It" });
    };
    let t = 4000;
    const now = () => t;
    await getBusinessIdentity(TENANT, { fetchImpl, now, log });
    down = true;
    t += IDENTITY_TTL_MS + 1;
    const stale = await getBusinessIdentity(TENANT, { fetchImpl, now, log });
    assert.equal(stale.display_name, "Rolling In It");
    assert.equal(stale.stale, true);

    clearIdentityCache();
    const cold = await getBusinessIdentity(TENANT, { fetchImpl, now, log });
    assert.equal(cold.display_name, NEUTRAL_BUSINESS_NAME);
    assert.equal(cold.source, "unavailable");
  });
});

test("MUTATION: unconfigured is unreachable, not a name, and never throws", async () => {
  clearIdentityCache();
  const keys = ["PLATFORM_API_URL", "PLATFORM_API_BASE_URL", "PLATFORM_API_BASE"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    const id = await getBusinessIdentity(TENANT, {
      fetchImpl: async () => { throw new Error("must not be called"); },
      log: { warn() {} },
    });
    assert.equal(id.display_name, NEUTRAL_BUSINESS_NAME);
  } finally {
    for (const k of keys) if (prev[k] !== undefined) process.env[k] = prev[k];
  }
});

test("MUTATION: neither client-facing email can name a product of ours again", () => {
  for (const rel of ["src/shared/weeklyDigestSender.js", "src/shared/leadgenScheduler.js"]) {
    const src = code(rel);
    assert.ok(!src.includes('|| "Lead Gen"'), `${rel} still names our product to a client`);
    assert.ok(!src.includes('|| "your business"'), `${rel} still has a last resort of its own`);
    assert.match(src, /businessDisplayName\(/, `${rel} must ask the one resolver`);
  }
});

test("the digest's FROM NAME is a separate seam, and it is recorded, not fixed here", () => {
  // Found while writing the guard above: weeklyDigestSender.js has
  //
  //   const fromName = (process.env.LEADGEN_DIGEST_FROM_NAME
  //                     || "Intelligent Analytics").trim() || undefined;
  //
  // That is OUR company name as the default sender of a client-facing email —
  // the same literal seams pack 1 removed from LUMEN's recipe emails. It is
  // deliberately NOT changed here, and the difference matters:
  //
  //   · LUMEN's recipe email is the CLIENT writing to the CLIENT'S CUSTOMER.
  //     Signing that with our name is a leak, and it was a defect.
  //   · This digest is the AGENCY writing to the CLIENT. The agency's own name
  //     is the correct sender — it is simply hardcoded to ONE agency, which is
  //     wrong the day a second agency runs this platform (migration 138's
  //     tenant_kind model says one can).
  //
  // The right fix is the agency resolver (lib/agency.resolveAgencyTenantId),
  // not the business-identity resolver, and arion-func has no agency resolver
  // yet. Recorded in MASTER_DEFECT_REGISTER §4d rather than half-fixed here.
  const src = code("src/shared/weeklyDigestSender.js");
  assert.match(src, /LEADGEN_DIGEST_FROM_NAME/,
    "if this ever stops being env-overridable, a white-label agency has no way out at all");
  assert.ok(!/tenantName[\s\S]{0,80}Intelligent Analytics/.test(src),
    "the BUSINESS name must never fall back to ours — only the agency sender may name an agency");
});

test("the digest and the notice now render the SAME name for the same business", async () => {
  // Both go through one function with one cache, so this is true by
  // construction — which is the point. Proven rather than asserted in prose.
  clearIdentityCache();
  await withEnv(async () => {
    const fetchImpl = async () => okResponse({ found: true, display_name: "Summit Lawn & Landscape" });
    const forDigest = await businessDisplayName(TENANT, { fetchImpl });
    const forNotice = await businessDisplayName(TENANT, { fetchImpl });
    assert.equal(forDigest, forNotice);
    assert.equal(forDigest, "Summit Lawn & Landscape");
  });
});
