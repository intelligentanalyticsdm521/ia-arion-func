// Pins L16's monthly re-score tick to what the handoff file specified
// (LUMEN-API-septa/docs/handoff/arion-func-monthly-rescore.js):
//
//   schedule   "0 29 3 1 * *"  — 03:29 UTC on the 1st of every month
//   endpoint   POST {LUMEN_API_BASE_URL}/api/v1/internal/leadgen/rescore/monthly
//   timeout    20 minutes
//   token      an app setting / Key Vault secret — never a literal in source
//
// No network, no Functions host: importing the module puts @azure/functions in
// test mode (it declines to register), and the HTTP call is driven through an
// injected fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MONTHLY_RESCORE_SCHEDULE,
  MONTHLY_RESCORE_PATH,
  MONTHLY_RESCORE_TIMEOUT_MS,
  runMonthlyRescore,
} from "../src/functions/leadgenMonthlyRescore.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("the schedule is the 1st-of-the-month 03:29 UTC tick the handoff specified", () => {
  assert.equal(MONTHLY_RESCORE_SCHEDULE, "0 29 3 1 * *");
  const src = read("src/functions/leadgenMonthlyRescore.js");
  assert.match(src, /app\.timer\("leadgenMonthlyRescore", \{\s*schedule: MONTHLY_RESCORE_SCHEDULE/,
    "the registered timer uses the pinned constant, not a second copy of the string");
  assert.match(src, /runOnStartup: false/, "a deploy must not fire a portfolio re-score");
});

test("the endpoint and the 20-minute timeout are the handoff's", () => {
  assert.equal(MONTHLY_RESCORE_PATH, "/api/v1/internal/leadgen/rescore/monthly");
  assert.equal(MONTHLY_RESCORE_TIMEOUT_MS, 20 * 60 * 1000);
});

test("the tick POSTs the LUMEN endpoint with the internal token header", async () => {
  const calls = [];
  const r = await runMonthlyRescore({
    baseUrl: "https://lumen.example.com/",
    token: "tok-123",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"tenants":3}' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://lumen.example.com/api/v1/internal/leadgen/rescore/monthly",
    "trailing slash on the base URL must not double up");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["x-internal-token"], "tok-123");
  assert.deepEqual(JSON.parse(calls[0].init.body), { send: true });
  assert.ok(calls[0].init.signal, "the call carries an abort signal (the 20-minute cap)");
  assert.equal(r.ok, true);
  assert.equal(r.body, '{"tenants":3}');
});

test("LEADGEN_MONTHLY_RESCORE_SEND=0 re-scores but asks for no report email", async () => {
  const saved = process.env.LEADGEN_MONTHLY_RESCORE_SEND;
  try {
    process.env.LEADGEN_MONTHLY_RESCORE_SEND = "0";
    let body = null;
    await runMonthlyRescore({
      baseUrl: "https://lumen.example.com",
      token: "tok",
      fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, status: 200, text: async () => "" }; },
    });
    assert.deepEqual(body, { send: false });
  } finally {
    if (saved === undefined) delete process.env.LEADGEN_MONTHLY_RESCORE_SEND;
    else process.env.LEADGEN_MONTHLY_RESCORE_SEND = saved;
  }
});

test("a missing base URL or token makes no call and reports the gap", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, status: 200, text: async () => "" }; };
  const errors = [];
  const logError = (m) => errors.push(m);

  assert.deepEqual(
    await runMonthlyRescore({ baseUrl: "", token: "tok", fetchImpl, logError }),
    { ok: false, error: "not_configured" });
  assert.deepEqual(
    await runMonthlyRescore({ baseUrl: "https://lumen.example.com", token: "", fetchImpl, logError }),
    { ok: false, error: "not_configured" });
  assert.equal(called, false);
  assert.equal(errors.length, 2, "both gaps are logged, not swallowed");
});

test("a non-2xx is reported as a failure, never as a quiet success", async () => {
  const errors = [];
  const r = await runMonthlyRescore({
    baseUrl: "https://lumen.example.com",
    token: "tok",
    logError: (m) => errors.push(m),
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => "lumen down" }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.match(errors[0], /HTTP 503/);
});

test("a thrown/timed-out call is reported, not thrown out of the timer", async () => {
  const errors = [];
  const r = await runMonthlyRescore({
    baseUrl: "https://lumen.example.com",
    token: "tok",
    logError: (m) => errors.push(m),
    fetchImpl: async () => { const e = new Error("The operation was aborted"); e.name = "TimeoutError"; throw e; },
  });
  assert.deepEqual(r, { ok: false, error: "timeout" });
  assert.match(errors[0], /call failed: timeout/);
});

test("the token is read from settings/Key Vault — no secret literal in the source", () => {
  const src = read("src/functions/leadgenMonthlyRescore.js");
  assert.match(src, /getSecret\("LUMEN_INTERNAL_SERVICE_TOKEN", "LUMEN-INTERNAL-SERVICE-TOKEN"\)/);
  assert.match(src, /getSecret\("LUMEN_WALKTHROUGH_SEED_TOKEN", "WALKTHROUGH-SEED-INTERNAL-TOKEN"\)/);
  assert.ok(!/x-internal-token":\s*"[A-Za-z0-9]/.test(src), "no hardcoded token value");
});

test("the timer is registered on the app entry point, so it actually runs", () => {
  assert.match(read("src/index.js"), /import "\.\/functions\/leadgenMonthlyRescore\.js"/);
});
