#!/usr/bin/env node
/**
 * exercise-agency-sender.mjs — the acceptance test for October pull-forward
 * item 3, against a REAL platform-api and the REAL local dev database.
 *
 * THE CLAIM: the weekly Lead Gen digest's sender name and footer come from
 * the AGENCY'S OWN RECORD, not from a string typed into this repo.
 *
 * That is only provable if the answer can be something OTHER than
 * "Intelligent Analytics" — a test whose fixture happens to be named the same
 * as the deleted literal proves nothing. The dev database is fixture-only
 * (memory: no real client data in dev) and its agency tenant is
 * "The Software Company", so this script's whole point is that the digest
 * signs itself with THAT, and then with a name it changes on the fly.
 *
 * WHAT IT TOUCHES, AND HOW IT PUTS IT BACK
 *   · The dev AGENCY fixture tenant's preferred_business_name, for one check.
 *     Read first, restored in a finally, and the restoration VERIFIED by
 *     reading it back — reported as a failing check if it did not take.
 *   · Nothing else is written, and the founder's dev stack is never contacted:
 *     this starts its own platform-api on a free port and stops it.
 *
 *   node scripts/exercise-agency-sender.mjs
 */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const sql = require("mssql");

const HERE = path.resolve(import.meta.dirname, "..");
const PLATFORM = "C:/dev/iadm/platform-api-septa-octpull";
const PORT = 4210;
const TOKEN = "octpull-agency-sender-exercise-token";

// The dev database's AGENCY tenant (tenant_kind = 'agency'). Deliberately NOT
// the production founder GUID: that row does not exist on dev, and a fixture
// named after the literal we deleted would prove nothing.
const DEV_AGENCY = "0A6E0C00-0000-4000-8000-00000000A6E0";

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(true));
    s.once("listening", () => s.close(() => resolve(false)));
    s.listen(port, "127.0.0.1");
  });
}

/* ── guards ─────────────────────────────────────────────────────────────── */
// The database credentials come from platform-api's .env, not from this repo's
// local.settings.json: arion-func's local settings carry only PLATFORM_API_URL
// and PLATFORM_INTERNAL_TOKEN (which is the point of SEAM-11 — this app asks
// platform-api rather than the database), and platform-api is the server this
// script starts anyway.
const dotenv = require("dotenv");
const settings = dotenv.parse(fs.readFileSync(path.join(PLATFORM, ".env")));
const server = String(settings.PLATFORM_SQL_SERVER || settings.SQL_SERVER || "");
const host = server.split(",")[0].trim();
if (!/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) {
  console.error(`refusing: "${host || "(unset)"}" is not the local dev container.`);
  process.exit(3);
}
if (await portInUse(PORT)) {
  console.error(`refusing: port ${PORT} is in use — this script must not attach to somebody else's server.`);
  process.exit(3);
}

const pool = await sql.connect({
  server: host,
  port: Number(server.split(",")[1] || 1433),
  database: settings.PLATFORM_SQL_DATABASE || "iadm_platform",
  options: { encrypt: false, trustServerCertificate: true },
  authentication: {
    type: "default",
    options: { userName: settings.SQL_USER, password: settings.SQL_PASSWORD },
  },
});

async function readPreferred() {
  const r = await pool.request().input("tid", sql.UniqueIdentifier, DEV_AGENCY)
    .query(`SELECT tenant_kind, business_name, preferred_business_name
              FROM core.tenants WHERE tenant_id = @tid`);
  return r.recordset[0] || null;
}
async function writePreferred(v) {
  await pool.request().input("tid", sql.UniqueIdentifier, DEV_AGENCY)
    .input("v", sql.NVarChar(500), v)
    .query(`UPDATE core.tenants SET preferred_business_name = @v WHERE tenant_id = @tid`);
}

const before = await readPreferred();
if (!before) {
  console.error(`refusing: dev agency fixture ${DEV_AGENCY} is not in this database.`);
  await pool.close();
  process.exit(3);
}
console.log(`agency fixture before: ${JSON.stringify(before)}`);

/* ── a real platform-api ────────────────────────────────────────────────── */
let child = null;
async function startPlatformApi() {
  child = spawn(process.execPath, ["index.js"], {
    cwd: PLATFORM,
    env: { ...process.env, PORT: String(PORT), PLATFORM_INTERNAL_TOKEN: TOKEN,
           NODE_ENV: "development", DEV_AUTH: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => {
    const s = String(d);
    if (/Error|error:/i.test(s)) process.stderr.write(`[platform-api] ${s}`);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let exitCode = 1;
try {
  const up = await startPlatformApi();
  check(`a real platform-api answered on 127.0.0.1:${PORT}`, up);
  if (!up) throw new Error("platform-api did not start");

  process.env.PLATFORM_API_URL = `http://127.0.0.1:${PORT}`;
  process.env.PLATFORM_INTERNAL_TOKEN = TOKEN;
  process.env.FOUNDER_TENANT_ID = DEV_AGENCY;
  delete process.env.LEADGEN_DIGEST_FROM_NAME;

  const identity = await import(pathToFileURL(path.join(HERE, "src/shared/businessIdentity.js")).href);
  const agencyId = await import(pathToFileURL(path.join(HERE, "src/shared/agencyIdentity.js")).href);
  const tpl = await import(pathToFileURL(path.join(HERE, "src/shared/weeklyDigestTemplate.js")).href);

  identity.clearIdentityCache();
  const name1 = await agencyId.agencyDisplayName();
  console.log(`  resolved agency name: ${JSON.stringify(name1)}`);
  check("the agency's name comes back from the real route", !!name1 && name1 !== identity.NEUTRAL_BUSINESS_NAME,
    name1);
  check("and it is NOT the literal this item deleted", name1 !== "Intelligent Analytics", name1);
  check("it is the AGENCY fixture's own recorded name",
    name1 === (before.preferred_business_name || before.business_name),
    `${name1} vs ${before.preferred_business_name || before.business_name}`);

  // The digest a client would actually receive.
  const digest = { window: { start: "2026-09-01", end: "2026-09-08" }, runs_count: 3, leads_total: 7 };
  const rendered = tpl.renderWeeklyDigestHtml(digest, "Harbor Point Coffee", name1);
  check("the CLIENT is named in the subject", /^Harbor Point Coffee —/.test(rendered.subject), rendered.subject);
  check("the AGENCY signs the footer", rendered.html.includes(`${name1} · `));
  check("and no company name is typed into the email", !/Intelligent Analytics/.test(rendered.html));

  // Change the record; the email changes. That is the whole claim.
  await writePreferred("Northbridge Digital");
  identity.clearIdentityCache();
  const name2 = await agencyId.agencyDisplayName();
  check("renaming the agency in core.tenants renames the sender", name2 === "Northbridge Digital", name2);
  const rendered2 = tpl.renderWeeklyDigestHtml(digest, "Harbor Point Coffee", name2);
  check("and the footer follows it, with no deploy", rendered2.html.includes("Northbridge Digital · "));

  // A platform blip must not re-brand a live client's mail mid-send.
  const down = async () => { throw new Error("ECONNREFUSED"); };
  const stale = await agencyId.agencyDisplayName({ fetchImpl: down, log: { warn() {} } });
  check("a platform outage serves the LAST KNOWN name, not a neutral one",
    stale === "Northbridge Digital", stale);

  exitCode = checks.every((c) => c.ok) ? 0 : 1;
} finally {
  console.log("\n── restore ──");
  try {
    await writePreferred(before.preferred_business_name);
    const after = await readPreferred();
    check("the agency fixture's name is back exactly as it was",
      (after?.preferred_business_name ?? null) === (before.preferred_business_name ?? null),
      `now ${JSON.stringify(after?.preferred_business_name)}`);
  } catch (e) {
    check("the agency fixture's name is back exactly as it was", false, e.message);
  }
  await pool.close();
  if (child) {
    child.kill();
    await new Promise((r) => setTimeout(r, 600));
    check(`port ${PORT} is free again`, !(await portInUse(PORT)));
  }
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
