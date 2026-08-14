#!/usr/bin/env node
/**
 * _run_plugin_snapshot_prod.mjs — run the nightly plugin snapshot on demand,
 * against production, from a dev machine.
 *
 * The timer runs once a night. When a plugin change lands, waiting a night to
 * find out whether the capture works is a night spent not knowing — and storage
 * has time value: a night without capture is history that cannot be recovered.
 *
 * Read-mostly: it calls each site's plugin API and writes snapshot rows. It
 * changes nothing on the sites themselves.
 *
 * Usage: node scripts/_run_plugin_snapshot_prod.mjs
 */
import { execSync } from 'node:child_process';
import sql from 'mssql';
import { runPluginSnapshot } from '../src/shared/pluginSnapshot.js';

const token = execSync(
  'az account get-access-token --resource https://database.windows.net --query accessToken -o tsv',
  { encoding: 'utf8', maxBuffer: 10 << 20 }
).trim();

const pool = await sql.connect({
  server: process.env.PROD_SQL_SERVER || 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true, trustServerCertificate: false },
  authentication: { type: 'azure-active-directory-access-token', options: { token } },
  connectionTimeout: 30000,
  requestTimeout: 300000,
});

const out = await runPluginSnapshot(pool, (m) => console.log(m));
console.log('\n' + JSON.stringify(out, null, 2));
await pool.close();
