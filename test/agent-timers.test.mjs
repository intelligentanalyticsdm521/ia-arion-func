// test/agent-timers.test.mjs
//
// The two ARGUS agent timers. Both are thin bell-ringers — every piece of logic
// lives in the API that owns the data — so the ONLY things that can be wrong
// here are the four facts this file pins:
//
//   THE PATH      A timer that POSTs a path the API does not mount logs
//                 "tick HTTP 404" once a week and looks exactly like nothing at
//                 all. That is what contentAgentWeekly did from 2026-09-05 until
//                 the arion-api half landed. Both paths are exported constants
//                 now, checked here, and cross-checked against the sibling
//                 repo's route when that checkout is present.
//   THE SCHEDULE  Monday, prime-minute spread per the timer-schedules
//                 convention, and runOnStartup false — a deploy must not fire a
//                 content cycle or a campaign draft.
//   THE SWITCH    CONTENT_AGENT_DISABLED / CAMPAIGN_AGENT_DISABLED, read from
//                 the named constant so the log line and the check cannot drift
//                 apart. arion-api's copy of the content switch is deliberately
//                 BROADER (any non-off value disables); this side stays
//                 `=== "true"` and the asymmetry is safe in one direction only.
//   THE SILENCE   Neither timer throws. A failed tick logs and returns, because
//                 an unhandled rejection in a Functions timer is a retry the
//                 host schedules for us.
//
// No network and no Functions host: importing a function module puts
// @azure/functions in test mode (it declines to register), and nothing here
// calls the handler.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTENT_AGENT_SCHEDULE, CONTENT_AGENT_TICK_PATH, CONTENT_AGENT_KILL_SWITCH,
} from "../src/functions/contentAgentWeekly.js";
import {
  CAMPAIGN_AGENT_SCHEDULE, CAMPAIGN_AGENT_TICK_PATH, CAMPAIGN_AGENT_KILL_SWITCH,
} from "../src/functions/sparkCampaignAgentWeekly.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CONTENT_SRC = read("src/functions/contentAgentWeekly.js");
const CAMPAIGN_SRC = read("src/functions/sparkCampaignAgentWeekly.js");

/* ── the paths ──────────────────────────────────────────────────────────── */

test("the content agent tick path is the one arion-api mounts", () => {
  assert.equal(CONTENT_AGENT_TICK_PATH, "/internal/content-agent-tick");
  assert.match(CONTENT_SRC, /\$\{base\}\$\{CONTENT_AGENT_TICK_PATH\}/,
    "the fetch must use the exported constant, not a second copy of the string");
});

test("the campaign agent tick path is the one LUMEN-API mounts", () => {
  assert.equal(CAMPAIGN_AGENT_TICK_PATH, "/api/v1/internal/campaign-agent/tick");
  assert.match(CAMPAIGN_SRC, /\$\{base\}\$\{CAMPAIGN_AGENT_TICK_PATH\}/);
});

test("CROSS-REPO: each path exists in the API that is supposed to serve it", () => {
  // Skipped rather than failed when the sibling line checkout is not on this
  // machine — a missing checkout is not a broken contract. Where it IS present,
  // this is the assertion that would have caught the 404.
  const checks = [
    {
      repo: "C:/dev/iadm/LUMEN-API-septa",
      file: "src/routes/campaignAgent.js",
      // LUMEN mounts the router under /api/v1, so the route declares the tail.
      needle: "'/internal/campaign-agent/tick'",
      what: "SPARK campaign agent tick",
    },
    {
      repo: "C:/dev/iadm/arion-api-septa-contentagent",
      file: "routes/internal.js",
      needle: "'/content-agent-tick'",
      what: "ARION content agent tick",
    },
  ];
  let checked = 0;
  for (const c of checks) {
    const p = path.join(c.repo, c.file);
    if (!fs.existsSync(p)) { console.log(`      (skipped ${c.what}: ${c.repo} not on this machine)`); continue; }
    const src = fs.readFileSync(p, "utf8");
    assert.ok(src.includes(c.needle),
      `${c.what}: ${c.file} in ${c.repo} does not register ${c.needle} — this timer would POST a 404`);
    checked += 1;
  }
  console.log(`      cross-checked ${checked} of ${checks.length} sibling repos`);
});

/* ── the schedules ──────────────────────────────────────────────────────── */

test("both agents run on Monday, on their own minute, and never on deploy", () => {
  assert.equal(CONTENT_AGENT_SCHEDULE, "0 41 5 * * Mon");
  assert.equal(CAMPAIGN_AGENT_SCHEDULE, "0 40 12 * * Mon");
  for (const [name, src] of [["content", CONTENT_SRC], ["campaign", CAMPAIGN_SRC]]) {
    assert.match(src, /runOnStartup: false/, `${name}: a deploy must not fire an agent cycle`);
    assert.match(src, /schedule: SCHEDULE/, `${name}: the registered schedule must be the pinned constant`);
  }
  // Distinct minutes: two timers on the same tick contend for the same host.
  assert.notEqual(CONTENT_AGENT_SCHEDULE, CAMPAIGN_AGENT_SCHEDULE);
});

/* ── the kill switches ──────────────────────────────────────────────────── */

test("each timer is stopped by its own named switch, and says which one", () => {
  assert.equal(CONTENT_AGENT_KILL_SWITCH, "CONTENT_AGENT_DISABLED");
  assert.equal(CAMPAIGN_AGENT_KILL_SWITCH, "CAMPAIGN_AGENT_DISABLED");
  assert.match(CONTENT_SRC, /process\.env\[CONTENT_AGENT_KILL_SWITCH\] === "true"/);
  assert.match(CAMPAIGN_SRC, /process\.env\[CAMPAIGN_AGENT_KILL_SWITCH\] === "true"/);
  // The log line is built from the constant, so "disabled via X" can never name
  // a variable the code does not read.
  assert.match(CONTENT_SRC, /disabled via \$\{CONTENT_AGENT_KILL_SWITCH\}/);
  assert.match(CAMPAIGN_SRC, /disabled via \$\{CAMPAIGN_AGENT_KILL_SWITCH\}/);
});

test("the API half of the content switch is the broader one, on purpose", () => {
  // Documented here because this repo is where somebody will look first when the
  // switch behaves differently in the two places. arion-api treats any value
  // that is not an explicit off-word as disabled; this timer wants an exact
  // "true". Both directions of the mismatch end in NOTHING RUNNING, which is the
  // only direction that is safe.
  const p = "C:/dev/iadm/arion-api-septa-contentagent/lib/contentAgent/config.js";
  if (!fs.existsSync(p)) { console.log("      (skipped: arion-api worktree not on this machine)"); return; }
  const src = fs.readFileSync(p, "utf8");
  assert.match(src, /KILL_SWITCH_ENV = 'CONTENT_AGENT_DISABLED'/,
    "the two repos must name the same variable");
  assert.match(src, /KILL_SWITCH_OFF_VALUES/,
    "arion-api reads the switch broadly; if that changed, the comment here is now wrong");
});

/* ── the silence ────────────────────────────────────────────────────────── */

test("a failing tick logs and returns — it never throws at the host", () => {
  for (const [name, src] of [["content", CONTENT_SRC], ["campaign", CAMPAIGN_SRC]]) {
    assert.match(src, /catch \(err\) \{\s*\n?\s*log\(`tick error: \$\{err\.message\}`\);\s*\n?\s*\}/,
      `${name}: the handler must swallow into a log line, not reject`);
    assert.match(src, /log\(`tick HTTP \$\{res\.status\}/,
      `${name}: a non-2xx has to name its status, or a 404 is invisible`);
  }
});

test("both timers are registered in the entry point, or they never run", () => {
  const index = read("src/index.js");
  assert.match(index, /import "\.\/functions\/contentAgentWeekly\.js";/);
  assert.match(index, /import "\.\/functions\/sparkCampaignAgentWeekly\.js";/);
});

test("neither timer holds any agent logic of its own", () => {
  // The split is the point: scheduling here, logic in the API that owns the
  // data. A timer that starts making decisions is a second implementation.
  for (const [name, src] of [["content", CONTENT_SRC], ["campaign", CAMPAIGN_SRC]]) {
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    assert.ok(!/mssql|require\(.*sql|SELECT |INSERT INTO/i.test(code), `${name}: no database access belongs in a bell-ringer`);
    assert.ok(!/anthropic|openai/i.test(code), `${name}: no provider call belongs in a bell-ringer`);
    assert.ok(src.length < 4500, `${name}: this file is growing logic (${src.length} bytes)`);
  }
});
