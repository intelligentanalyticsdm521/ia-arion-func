// Seams pack 2 — the arion-func half.
//
// `src/shared/weeklyDigestSender.js` held copy FIVE of six of "may we email
// this person?" (seams audit §2). Like the other four it never read
// `marketing_optin`, so a client who pressed "one click stops all marketing
// email" kept receiving the weekly lead-gen digest and the two-business-day
// pre-run notice — the two emails on this timer.
//
// It asks the one gate now: platform-api lib/notificationGate.js, over
// POST /internal/notify/can-send.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const strip = (t) => t.split("\n")
  .filter((l) => { const x = l.trim(); return !(x.startsWith("//") || x.startsWith("*") || x.startsWith("/*")); })
  .join("\n");

test("the weekly sender has no send-permission logic of its own", () => {
  const s = strip(read("src", "shared", "weeklyDigestSender.js"));
  assert.doesNotMatch(s, /FROM lumen\.email_suppression/i,
    "reading the suppression list here is what made this copy five of six");
  assert.doesNotMatch(s, /email_unsubscribed/);
  assert.doesNotMatch(s, /notification_preferences_json/);
  assert.match(s, /await canSend\(\{/, "it has to ask the one gate");
  assert.match(s, /categoryKey: MARKETING_CATEGORY/,
    "a lead-gen report is not a receipt — the category is unchanged");
});

test("an undecided gate skips the tenant for this run, it does not send", () => {
  const s = strip(read("src", "shared", "weeklyDigestSender.js"));
  const fn = s.slice(s.indexOf("export async function isEmailAllowed"));
  assert.match(fn.slice(0, 900), /GateUnavailable/);
  assert.match(fn.slice(0, 900), /allowed: false, reason: "gate_unavailable"/,
    "this used to fall through to 'allowed' — a digest that is late is recoverable, "
    + "one sent to somebody who unsubscribed is not");
});

test("the signature is unchanged, so both callers are untouched", () => {
  const s = strip(read("src", "shared", "weeklyDigestSender.js"));
  assert.match(s, /export async function isEmailAllowed\(_servicesPool, tenantId, email, _mssql\)/);
  const sched = strip(read("src", "shared", "leadgenScheduler.js"));
  assert.match(sched, /await isEmailAllowed\(pool, row\.tenant_id, owner\.email, mssql\)/);
  assert.match(s, /await isEmailAllowed\(servicesPool, t\.tenant_id, owner\.email, mssql\)/);
});

test("the gate client never answers 'allowed' when it is not configured", async () => {
  const { canSend, GateUnavailable, clearGateCache } = await import("../src/shared/notificationGate.js");
  clearGateCache();
  const saved = {};
  for (const k of ["PLATFORM_API_URL", "PLATFORM_API_BASE_URL", "PLATFORM_INTERNAL_TOKEN", "PLATFORM_INTERNAL_SERVICE_TOKEN", "LUMEN_INTERNAL_SERVICE_TOKEN"]) {
    saved[k] = process.env[k]; delete process.env[k];
  }
  try {
    await assert.rejects(
      () => canSend({ tenantId: "t", channel: "email", to: "x@y.z", categoryKey: "marketing" }),
      (e) => e instanceof GateUnavailable && e.reason === "gate_not_configured",
    );
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    clearGateCache();
  }
});

test("nothing in this Function App queues platform.notification_event by hand", () => {
  const hits = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|cjs)$/.test(n)) continue;
      if (/INSERT\s+INTO\s+platform\.notification_event/i.test(strip(fs.readFileSync(p, "utf8")))) {
        hits.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, "src"));
  assert.deepEqual(hits, [], "arion-func sends over the webhook, not through the queue — keep it that way");
});
