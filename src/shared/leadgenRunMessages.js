// shared/leadgenRunMessages.js — ESM mirror of LUMEN-API's
// src/services/leadgen/runMessages.js (the same arrangement as
// scheduleCadence.js: arion-func is ESM, LUMEN-API is CJS, so the wording is
// mirrored rather than imported).
//
// IF YOU CHANGE WORDING HERE, change LUMEN-API/src/services/leadgen/runMessages.js
// in the same commit. The test in test/leadgen-pre-run-notice.test.mjs pins the
// exact strings, so drift fails a build rather than quietly reaching a customer.
//
// X1 (LOCKED, Brandon 2026-09-04): soft and directional, never a pool count,
// never an automatic widening of anyone's search.

/** Preview / forecast sentence. null = say nothing (the ordinary case). */
export function previewMessage(band) {
  if (band === "exhausted") {
    return "Our models show you may not hit your lead limit with a search this strict — "
      + "this search will likely deliver fewer than you asked for. Widen the location, "
      + "add related terms, or use a less strict model.";
  }
  if (band === "tight") {
    return "Our models show you may not hit your lead limit with a search this strict — "
      + "widen the location, add related terms, or use a less strict model.";
  }
  return null;
}

/** The 2-business-day notice, plus the soft warning when the last run strained. */
export function preRunMessage({ runDate, band } = {}) {
  const base = `Your leads are scheduled to run on ${runDate} — check your settings.`;
  const warn = previewMessage(band);
  return warn ? `${base} ${warn}` : base;
}

/** Read the strain band off a stored summary_json, safely. */
export function strainFromSummary(summaryJson) {
  let s = summaryJson;
  if (typeof s === "string") {
    try { s = JSON.parse(s); } catch { return "none"; }
  }
  const band = s?.pool_strain;
  return band === "tight" || band === "exhausted" ? band : "none";
}
