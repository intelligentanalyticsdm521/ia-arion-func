// test/seams-4a.test.mjs — SEAM-11 in arion-func.
//
// arion-func's notification gate carried its own fallback chain for
// platform-api's address and token, in a DIFFERENT order from its three sibling
// repos. Set one of the two names on the Functions app and half the calls
// authenticate — which for this app means the weekly digest deciding it "cannot
// tell" whether a message may be sent, and sending nothing.
//
// MUTATION-TESTED 2026-09-04 (each break made, the named test failed, reverted):
//   * drop PLATFORM_API_URL from URL_NAMES
//       -> "the canonical name wins over every legacy one" fails
//   * put a legacy read back into src/shared/notificationGate.js
//       -> "nothing outside the shim reads a legacy name" fails
//   * make the warning include the value
//       -> "a warning never prints a secret" fails
//
// THE FIRST VERSION OF THIS FILE HAD AN INERT GREP, and the mutation above is
// what found it: the regex was built as `process\.env\.${n}\b` inside a
// TEMPLATE LITERAL, where `\.` collapses to `.` and `\b` becomes a literal
// backspace character — so it matched nothing, ever, and the "nothing reads a
// legacy name" test passed on a file that read one twice. A guard that cannot
// fail is a comment with a green tick on it. Hence the self-check at the bottom,
// which drives the same regex over a sample that MUST match.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as env from "../src/shared/platformEnv.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const code = (rel) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

/** The one regex the grep uses, built once so the self-check drives the SAME one. */
const legacyReadRe = (name) => new RegExp("process\\.env\\." + name + "\\b");

test("the canonical name wins over every legacy one", () => {
  assert.equal(env.URL_NAMES[0], "PLATFORM_API_URL");
  assert.equal(env.TOKEN_NAMES[0], "PLATFORM_INTERNAL_TOKEN");
  assert.equal(env.platformApiUrl({ PLATFORM_API_URL: "http://canonical", PLATFORM_API_BASE_URL: "http://legacy" }), "http://canonical");
  assert.equal(env.platformInternalToken({ PLATFORM_INTERNAL_TOKEN: "canon", PLATFORM_INTERNAL_SERVICE_TOKEN: "legacy" }), "canon");
});

test("the preference order is the SAME as the other three repos'", () => {
  // Four near-identical copies exist because four runtimes share no package.
  // What must never differ is the ORDER — that difference IS the defect.
  assert.deepEqual(env.URL_NAMES, ["PLATFORM_API_URL", "PLATFORM_API_BASE_URL", "PLATFORM_API_BASE"]);
  assert.deepEqual(env.TOKEN_NAMES, ["PLATFORM_INTERNAL_TOKEN", "PLATFORM_INTERNAL_SERVICE_TOKEN", "LUMEN_INTERNAL_SERVICE_TOKEN"]);
});

test("each legacy name still works on its own — one release of compatibility", () => {
  for (const n of env.URL_NAMES.slice(1)) assert.equal(env.platformApiUrl({ [n]: "http://legacy/" }), "http://legacy", n);
  for (const n of env.TOKEN_NAMES.slice(1)) assert.equal(env.platformInternalToken({ [n]: " s3cret " }), "s3cret", n);
});

test("unset is empty, so the gate fails closed rather than throwing", () => {
  assert.equal(env.platformApiUrl({}), "");
  assert.equal(env.platformInternalToken({}), "");
});

test("an alias-only configuration warns once, naming both names and the file", () => {
  env.resetAliasWarnings();
  const lines = [];
  env.warnOnAliases({ PLATFORM_API_BASE_URL: "http://legacy", PLATFORM_INTERNAL_SERVICE_TOKEN: "s3cret" }, (m) => lines.push(m));
  assert.equal(lines.length, 2);
  const joined = lines.join("\n");
  for (const n of ["PLATFORM_API_BASE_URL", "PLATFORM_API_URL", "PLATFORM_INTERNAL_SERVICE_TOKEN", "PLATFORM_INTERNAL_TOKEN"]) {
    assert.ok(joined.includes(n), n);
  }
  assert.match(joined, /platformEnv\.js/);
});

test("a warning never prints a secret", () => {
  env.resetAliasWarnings();
  const lines = [];
  env.warnOnAliases({ PLATFORM_INTERNAL_SERVICE_TOKEN: "SUPER-SECRET-VALUE" }, (m) => lines.push(m));
  assert.equal(lines.join("\n").includes("SUPER-SECRET-VALUE"), false);
});

test("a canonical-only configuration is silent", () => {
  env.resetAliasWarnings();
  const lines = [];
  env.warnOnAliases({ PLATFORM_API_URL: "http://x", PLATFORM_INTERNAL_TOKEN: "t" }, (m) => lines.push(m));
  assert.deepEqual(lines, []);
});

/** Files allowed to read a legacy name, and why. Each is a DIFFERENT secret. */
const EXCEPTIONS = new Map([
  ["src/shared/platformEnv.js", "the compatibility shim itself"],
  [
    "src/functions/sparkCampaignAgentWeekly.js",
    "LUMEN_INTERNAL_SERVICE_TOKEN here is the secret arion-func sends TO LUMEN's /api/v1/internal/*. " +
      "That is LUMEN's inbound secret, not platform-api's; renaming it would break the call.",
  ],
]);
// leadgenMonthlyRescore.js is deliberately NOT here. It also uses LUMEN's
// secret, but via `getSecret("LUMEN_INTERNAL_SERVICE_TOKEN", …)` — a Key Vault
// name, not a `process.env` read — so the grep never sees it and an exception
// for it would be a stale one. The "every exception still reads a legacy name"
// test below is what caught that, on its first run, which is the whole reason
// it exists: an exception list nobody prunes is a list of holes.

const LEGACY = ["PLATFORM_API_BASE_URL", "PLATFORM_API_BASE", "PLATFORM_INTERNAL_SERVICE_TOKEN", "LUMEN_INTERNAL_SERVICE_TOKEN"];

function sourceFiles(dir, out = []) {
  for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { sourceFiles(rel, out); continue; }
    if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}

test("nothing outside the shim reads a legacy name", () => {
  const files = sourceFiles("src");
  assert.ok(files.length > 10, "the walk found almost nothing — a grep over an empty set always passes");

  const offenders = [];
  for (const rel of files) {
    if (EXCEPTIONS.has(rel)) continue;
    const src = code(rel);
    for (const n of LEGACY) if (legacyReadRe(n).test(src)) offenders.push(`${rel} reads ${n}`);
  }
  assert.deepEqual(
    offenders, [],
    "read platform-api's address and token through src/shared/platformEnv.js. If this is a DIFFERENT secret " +
      "that merely looks similar, add it to EXCEPTIONS with the reason — do not widen the shim.",
  );
});

test("every exception still reads a legacy name — a stale exception is a hole", () => {
  for (const [rel] of EXCEPTIONS) {
    if (rel === "src/shared/platformEnv.js") continue;
    const src = code(rel);
    assert.ok(LEGACY.some((n) => legacyReadRe(n).test(src)), `${rel} no longer needs its exception`);
  }
});

test("the notification gate goes through the shim", () => {
  const src = code("src/shared/notificationGate.js");
  assert.match(src, /import \{ platformApiUrl, platformInternalToken \} from "\.\/platformEnv\.js"/);
  assert.match(src, /return platformApiUrl\(\);/);
  assert.match(src, /return platformInternalToken\(\);/);
});

test("the grep would actually catch a violation", () => {
  // THE TEST THAT WOULD HAVE CAUGHT THE INERT REGEX. It drives the exact
  // function the guard above uses, over a line shaped like the real thing.
  const sample = "  if (process.env.PLATFORM_INTERNAL_SERVICE_TOKEN) return process.env.PLATFORM_INTERNAL_SERVICE_TOKEN;";
  assert.equal(legacyReadRe("PLATFORM_INTERNAL_SERVICE_TOKEN").test(sample), true, "the grep is inert");
  assert.equal(legacyReadRe("PLATFORM_API_BASE_URL").test('const b = process.env.PLATFORM_API_BASE_URL || "";'), true);
  // …and does not fire on a name that merely starts the same way.
  assert.equal(legacyReadRe("PLATFORM_API_BASE").test("const b = process.env.PLATFORM_API_BASE_URL;"), false,
    "\\b must stop PLATFORM_API_BASE matching inside PLATFORM_API_BASE_URL");
  // …and survives comment-stripping on a line that also contains a URL.
  const tricky = code("src/shared/platformEnv.js");
  assert.ok(tricky.length > 100, "comment-stripping must not empty a file");
});
