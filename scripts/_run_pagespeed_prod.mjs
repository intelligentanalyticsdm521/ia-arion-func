#!/usr/bin/env node
/**
 * _run_pagespeed_prod.mjs — run the PageSpeed capture on demand against prod.
 *
 * PSI runs monthly, so a change to what it captures is otherwise invisible
 * until the next cycle. This fires it now so the new columns (full audit set,
 * pass counts, TTFB, Speed Index) are populated and the reports built on them
 * can be verified rather than assumed.
 *
 * Needs GOOGLE_PAGESPEED_API_KEY — pulled from Key Vault via the same Node
 * path the other prod scripts use, because the Python `az keyvault` command
 * fails TLS against the AVG root cert on this machine.
 *
 * Usage: node scripts/_run_pagespeed_prod.mjs
 */
import { execSync } from 'node:child_process';
import sql from 'mssql';
import { runMonthlyPageSpeed } from '../src/shared/pagespeedRunner.js';

const kvGet = async (name) => {
  const token = execSync('az account get-access-token --resource https://vault.azure.net --query accessToken -o tsv',
    { encoding: 'utf8', maxBuffer: 10 << 20 }).trim();
  const r = await fetch(`https://kv-IADM-prod.vault.azure.net/secrets/${name}?api-version=7.4`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return (await r.json()).value;
};

if (!process.env.GOOGLE_PAGESPEED_API_KEY) {
  process.env.GOOGLE_PAGESPEED_API_KEY = await kvGet('GOOGLE-PAGESPEED-API-KEY');
  console.log('[psi] key loaded from Key Vault');
}

const token = execSync(
  'az account get-access-token --resource https://database.windows.net --query accessToken -o tsv',
  { encoding: 'utf8', maxBuffer: 10 << 20 }).trim();

const pool = await sql.connect({
  server: process.env.PROD_SQL_SERVER || 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true, trustServerCertificate: false },
  authentication: { type: 'azure-active-directory-access-token', options: { token } },
  connectionTimeout: 30000,
  requestTimeout: 600000,
});

// force=true so it runs regardless of each site's cadence window.
const out = await runMonthlyPageSpeed(pool, (m) => console.log(m), { force: true });
console.log('\n' + JSON.stringify(out, null, 2));
await pool.close();
