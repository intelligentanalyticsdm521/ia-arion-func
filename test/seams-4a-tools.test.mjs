// SEAM-9-A — the shared dev tooling, and the applier that must not come back.
//
// Seams audit §9. `lint-sql-contracts.mjs` and `apply-migration-dev.mjs` now
// live ONCE, at C:/dev/iadm/_tools/, and every backend reaches them through a
// byte-identical `scripts/_tools.mjs`. Two things can quietly undo that:
//
//   1. `scripts/_tools.mjs` drifting in one repo. It is copied rather than
//      shared because it is the thing that FINDS the shared directory — it
//      cannot live inside what it is looking for — so the only thing keeping
//      five copies honest is each repo asserting the same sha256.
//
//   2. Somebody adding a bespoke `apply-migration-NNN.js` here. This repo has
//      never had one and must never grow one: it is an Azure Functions app
//      with no db/migrations of its own, so any applier it gained would be
//      applying somebody else's schema. LUMEN had four of these and oliver-api
//      had 61; every one hardcoded `sql-iadm-prod-cus.database.windows.net`.
//
// The guard below is on the PRESENCE of the shared wiring (the pinned hash,
// the named npm scripts), never on the absence of something bad.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIM = path.join(REPO_ROOT, "scripts", "_tools.mjs");

// The one hash, shared by oliver-api, platform-api, LUMEN-API, arion-api and
// iadm-webhooks. If you change scripts/_tools.mjs you change it in all five and
// update this literal in all five — that is the whole point of pinning it.
const SHIM_SHA256 = "acb669ce587c0b4f643c914da214b900ff866716d9cae5bf6543545b2c991ecc";

test("scripts/_tools.mjs is the declared byte-identical copy", () => {
  const bytes = fs.readFileSync(SHIM);
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    SHIM_SHA256,
    "scripts/_tools.mjs has drifted from the copy the other four backends carry"
  );
  // .gitattributes pins this path to eol=lf. core.autocrlf is true on the dev
  // machines, so without that pin a fresh checkout would arrive with CRLF and
  // the hash above could never match anywhere.
  assert.ok(!bytes.includes(0x0d), "scripts/_tools.mjs must be LF, not CRLF");
});

test("npm run lint:contracts goes through the shared tooling", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["lint:contracts"], "node scripts/_tools.mjs lint-sql-contracts .");
});

test("this repo has NO migrate:dev, because it owns no migrations", () => {
  // Deliberate, not an oversight. arion-func is an Azure Functions app; the
  // tables it reads and writes belong to LUMEN-API and arion-api and are
  // migrated from those repos, under those repos' keys in
  // db.schema_migrations. A migrate:dev here would either do nothing or
  // record another repo's migration under "arion-func", which silently
  // corrupts both sequences.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["migrate:dev"], undefined);
  assert.ok(!fs.existsSync(path.join(REPO_ROOT, "db", "migrations")),
    "a db/migrations directory appeared — this repo now owns migrations and needs the applier script after all");
});

test("no bespoke migration applier has reappeared in scripts/", () => {
  // Nothing was deleted here — this repo never had one. The guard exists so it
  // stays that way.
  const offenders = [];
  const walk = (dir, rel = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), relPath); continue; }
      if (/^_?apply[-_]migration/i.test(entry.name)) offenders.push(relPath);
    }
  };
  walk(path.join(REPO_ROOT, "scripts"));
  assert.deepEqual(
    offenders,
    [],
    "a bespoke migration applier is back in scripts/. Use `npm run migrate:dev` " +
      "(C:/dev/iadm/_tools/apply-migration-dev.mjs) — it refuses any server it " +
      "cannot prove is loopback, which is exactly what these files never did."
  );
});
