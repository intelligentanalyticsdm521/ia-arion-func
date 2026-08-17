// src/shared/argusTables.js — canonical ARGUS table names for arion-func
// (twin of arion-api/lib/argus/tables.js).
//
// The credit tables moved to the argus schema (LUMEN migration 132). The
// consolidated names are used only when argus.credit_grant actually exists,
// probed once per process; otherwise the pre-consolidation names keep
// working (the migration-131 fallback pattern). Drop the legacy map once
// 132 is applied everywhere.

const CONSOLIDATED = {
  consolidated: true,
  CREDIT_GRANT: "argus.credit_grant",
  CREDIT_USE: "argus.credit_use",
  AUTOTOPOFF_CONFIG: "argus.autotopoff_config",
};

const LEGACY = {
  consolidated: false,
  CREDIT_GRANT: "oliver.argus_credit_grant",
  CREDIT_USE: "oliver.argus_credit_use",
  AUTOTOPOFF_CONFIG: "lumen.argus_autotopoff_config",
};

let _consolidated = null; // null = not probed yet

export async function argusTables(pool) {
  if (_consolidated === null) {
    try {
      const r = await pool.request().query("SELECT OBJECT_ID('argus.credit_grant', 'U') AS id");
      _consolidated = r.recordset?.[0]?.id != null;
      if (!_consolidated) {
        console.warn("[argus] argus.credit_grant not found — using pre-consolidation table names (apply LUMEN migration 132)");
      }
    } catch {
      _consolidated = false;
    }
  }
  return _consolidated ? CONSOLIDATED : LEGACY;
}

// FAIL-CLOSED global spend gate. Only the exact value 'true' enables spend;
// absence, other values, and read errors refuse. Reads the new name first
// (migration 131 moved the switch to argus.platform_config), falls back to
// the old lumen name so an un-migrated database keeps its setting.
export async function isArgusSpendEnabled(pool) {
  for (const table of ["argus.platform_config", "lumen.argus_platform_config"]) {
    try {
      const r = await pool
        .request()
        .query(`SELECT [value] FROM ${table} WHERE [key] = N'spend_enabled'`);
      if (r.recordset?.length) {
        return String(r.recordset[0].value || "").toLowerCase() === "true";
      }
    } catch {
      /* table absent — try the next name */
    }
  }
  console.warn("[argus] spend gate unreadable (no argus.platform_config or lumen.argus_platform_config row) — refusing spend");
  return false;
}

// Test seam.
export function _resetArgusTablesProbe() {
  _consolidated = null;
}
