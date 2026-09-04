// Pins the 2-business-day pre-run notice (Release A.2 P5 / X1 LOCKED).
//
//   window   Friday afternoon → Tuesday is TWO business days (the weekend does
//            not count), and nothing more than two business days out is ever
//            noticed. The count happens in the profile's own timezone.
//   wording  the notice names the date and only carries the soft warning when
//            the schedule's last run strained — and never a pool count.
//   stamp    a run is noticed once; a second tick the same day sends nothing;
//            changing the date produces a fresh notice.
//
// Pure helpers + a fake pool. No network, no DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  businessDaysUntil, isWithinBusinessDays, formatRunDate,
} from "../src/shared/businessDays.js";
import { previewMessage, preRunMessage, strainFromSummary } from "../src/shared/leadgenRunMessages.js";
import { interpolate } from "../src/shared/leadgenNoticeTemplate.js";

const TZ = "America/Chicago";
// All times below are written as UTC and read in America/Chicago (CDT, -5).
const at = (iso) => new Date(iso);

// ── the business-day window ─────────────────────────────────────────────────
test("Friday 16:00 → Tuesday counts 2 business days; the weekend is not two days of notice", () => {
  const friday = at("2026-09-04T21:00:00Z");   // Fri 16:00 Chicago
  assert.equal(businessDaysUntil(friday, at("2026-09-08T13:00:00Z"), TZ), 2, "Tue");
  assert.equal(businessDaysUntil(friday, at("2026-09-07T13:00:00Z"), TZ), 1, "Mon");
  assert.equal(businessDaysUntil(friday, at("2026-09-05T13:00:00Z"), TZ), 0, "Sat is no notice at all");
});

test("a mid-week run is noticed two week-days ahead", () => {
  const monday = at("2026-09-07T14:00:00Z");
  assert.equal(businessDaysUntil(monday, at("2026-09-09T14:00:00Z"), TZ), 2, "Wed");
  assert.equal(businessDaysUntil(monday, at("2026-09-10T14:00:00Z"), TZ), 3, "Thu is out of the window");
});

test("a run more than 2 business days out gets NO notice, and a past run gets none either", () => {
  const friday = at("2026-09-04T21:00:00Z");
  assert.equal(isWithinBusinessDays(friday, at("2026-09-08T13:00:00Z"), 2, TZ), true, "Tue — notice");
  assert.equal(isWithinBusinessDays(friday, at("2026-09-09T13:00:00Z"), 2, TZ), false, "Wed — too early");
  assert.equal(isWithinBusinessDays(friday, at("2026-09-14T13:00:00Z"), 2, TZ), false, "next week — too early");
  assert.equal(isWithinBusinessDays(friday, at("2026-09-03T13:00:00Z"), 2, TZ), false, "already gone");
});

test("the window is counted in the profile's timezone, not UTC", () => {
  // 01:00 UTC Tuesday is still Monday evening in Chicago.
  const moment = at("2026-09-08T01:00:00Z");
  assert.equal(businessDaysUntil(moment, at("2026-09-09T14:00:00Z"), TZ), 2, "Chicago: still Mon evening → Wed is 2");
  assert.equal(businessDaysUntil(moment, at("2026-09-09T14:00:00Z"), "UTC"), 1, "UTC: already Tue → Wed is 1");
  assert.equal(isWithinBusinessDays(moment, at("2026-09-09T14:00:00Z"), 2, TZ), true, "the Chicago tenant is noticed now");
  assert.equal(formatRunDate(at("2026-09-09T14:00:00Z"), TZ), "Wed, Sep 9");
});

// ── the wording (X1) ────────────────────────────────────────────────────────
test("the notice names the run date; the soft warning only rides along when the last run strained", () => {
  assert.equal(preRunMessage({ runDate: "Wed, Sep 9" }),
    "Your leads are scheduled to run on Wed, Sep 9 — check your settings.");
  assert.equal(previewMessage("none"), null);
  assert.match(previewMessage("tight"),
    /^Our models show you may not hit your lead limit with a search this strict — widen the location, add related terms, or use a less strict model\.$/);
  assert.match(previewMessage("exhausted"), /likely deliver fewer than you asked for/);
});

test("no notice wording anywhere contains a count", () => {
  for (const band of ["tight", "exhausted"]) {
    assert.doesNotMatch(previewMessage(band), /\d/, `${band} band leaks a number`);
  }
  assert.doesNotMatch(preRunMessage({ runDate: "Wed, Sep 9", band: "tight" }).replace("Sep 9", ""), /\d/);
});

test("the strain band comes off the last run's stored summary, and bad JSON is just 'none'", () => {
  assert.equal(strainFromSummary('{"pool_strain":"tight"}'), "tight");
  assert.equal(strainFromSummary('{"pool_strain":"none"}'), "none");
  assert.equal(strainFromSummary("nonsense"), "none");
  assert.equal(strainFromSummary(null), "none");
});

// ── template rendering ──────────────────────────────────────────────────────
test("the template renders the run date and drops unknown tags rather than printing them", () => {
  const out = interpolate(
    "Your saved search {{run.profile_name}} runs on {{run.run_date}}. {{run.recommendation}}{{run.nothing_here}}",
    { run: { profile_name: "Ankeny roofers", run_date: "Wed, Sep 9", recommendation: "" } }
  );
  assert.equal(out, "Your saved search Ankeny roofers runs on Wed, Sep 9. ");
});
