// Pins the ARGUS global spend kill-switch (migration 146 + charger read).
// FAIL-CLOSED: only the exact value 'true' enables spend; missing row, other
// values, and read errors are all OFF. Mutation: inverting the default or
// accepting truthy values fails these cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isArgusSpendEnabled } from "../src/functions/argusAutotopoffCharger.js";

const poolWith = (rows) => ({ request: () => ({ query: async () => ({ recordset: rows }) }) });
const failingPool = { request: () => ({ query: async () => { throw new Error("db down"); } }) };

test("kill-switch — fail-closed in every ambiguous state", async (t) => {
  await t.test("value 'true' → ON", async () => {
    assert.equal(await isArgusSpendEnabled(poolWith([{ value: "true" }])), true);
  });
  await t.test("'TRUE' (case-insensitive) → ON", async () => {
    assert.equal(await isArgusSpendEnabled(poolWith([{ value: "TRUE" }])), true);
  });
  await t.test("missing row → OFF", async () => {
    assert.equal(await isArgusSpendEnabled(poolWith([])), false);
  });
  await t.test("'false' → OFF", async () => {
    assert.equal(await isArgusSpendEnabled(poolWith([{ value: "false" }])), false);
  });
  await t.test("truthy-but-not-'true' ('1', 'yes', 'on') → OFF", async () => {
    for (const v of ["1", "yes", "on", "enabled"]) {
      assert.equal(await isArgusSpendEnabled(poolWith([{ value: v }])), false, `value=${v}`);
    }
  });
  await t.test("read error (missing table / db down) → OFF", async () => {
    assert.equal(await isArgusSpendEnabled(failingPool), false);
  });
});
