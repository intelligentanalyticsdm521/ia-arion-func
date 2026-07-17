import sql from "mssql";
import {
  DefaultAzureCredential,
  AzureCliCredential,
  ManagedIdentityCredential,
} from "@azure/identity";

const authMode = process.env.AUTH_MODE || "LOCAL_DEV";
const sqlServer = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER;
const sqlDatabase = process.env.SERVICES_SQL_DATABASE || "iadm_services";
const SQL_SCOPE = "https://database.windows.net/.default";

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function getCredential() {
  if (authMode === "MANAGED_IDENTITY") return new ManagedIdentityCredential();
  if (authMode === "AZURE_CLI") return new AzureCliCredential();
  return new DefaultAzureCredential();
}

// Rebuild the pool this long before the AAD token actually expires.
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let poolPromise = null;
let poolTokenExpiresOnMs = 0;

/**
 * Connection pool for iadm_services.
 *
 * ⚠️ 2026-07-16 — TWO BUGS FIXED HERE. The first is the leading candidate for the
 * Market Monitor outage: arion.se_ranking_position_history stopped being written
 * on 2026-07-10 while the timer kept firing every single morning, and
 * arion.market_monitor_job_log recorded NOTHING after 07-10 — i.e. the run died
 * before it could even log that it had started. getServicesPool() is the very
 * first thing marketMonitorMoves calls.
 *
 * BUG 1 — A POISONED CACHE MADE ONE TIMEOUT PERMANENT.
 *
 *     poolPromise = withTimeout(
 *       new sql.ConnectionPool(config).connect()
 *         .then((pool) => pool)
 *         .catch((err) => { poolPromise = null; throw err; }),  // <-- INNER promise
 *       connectTimeoutMs, "SQL ConnectionPool.connect");
 *
 * The reset lived on the INNER promise, so it only ran when connect() itself
 * rejected. When the withTimeout wrapper rejected FIRST — exactly what a slow SQL
 * server causes — the reset never ran and `poolPromise` was left holding a
 * REJECTED promise. Every later call hit `if (poolPromise) return poolPromise`
 * and got that same rejection back instantly, forever, for the life of the
 * process. One transient 12-second blip permanently bricks the pool for all 18
 * functions in the app until it recycles.
 *
 * That matches the evidence: job_log records real query timeouts ("Timeout:
 * Request failed to complete in 15000ms") on 2026-07-05 and 07-06 — so the pool
 * worked then — success on 07-09/07-10, then total silence with no job_log rows
 * at all, which is what a getServicesPool() failure looks like from the outside.
 *
 * ⚠️ STILL UNVERIFIED as THE cause — that needs the App Insights exception
 * (component func-iadm-arion-prod202603051733, appId 107eb168-…). But it is a
 * real bug that produces precisely this signature, and it is worth fixing on its
 * own merits regardless of what the exception says.
 *
 * Now the reset is attached to the OUTER promise, so ANY rejection — timeout
 * included — clears the cache and the next call retries honestly.
 *
 * BUG 2 — THE AAD TOKEN WAS NEVER REFRESHED.
 * The token was fetched once and baked into the pool config forever. AAD access
 * tokens last roughly an hour; afterwards the pool cannot re-authenticate and
 * queries fail with an auth error that looks nothing like "your token expired".
 * LUMEN-API's platformPool.js already solved this with an expiry buffer;
 * arion-func never got it. Survivable for a daily timer in a cold process, lethal
 * in a warm one — and this app runs 18 functions, several every few minutes, so
 * the process IS warm.
 */
export async function getServicesPool() {
  // Rebuild if the cached pool's token has expired or is close to it.
  if (poolPromise && Date.now() >= poolTokenExpiresOnMs - TOKEN_EXPIRY_BUFFER_MS) {
    const stale = poolPromise;
    poolPromise = null;
    poolTokenExpiresOnMs = 0;
    // Close the old pool in the background; cleanup must never break the caller.
    Promise.resolve(stale).then((p) => p?.close?.()).catch(() => {});
  }

  if (poolPromise) return poolPromise;
  if (!sqlServer) throw new Error("SERVICES_SQL_SERVER (or SQL_SERVER) is required for arion-func");

  const connectTimeoutMs = Number(process.env.SQL_CONNECT_TIMEOUT_MS || "12000");
  const credential = getCredential();
  const token = await withTimeout(credential.getToken(SQL_SCOPE), connectTimeoutMs, "ManagedIdentity getToken");

  const config = {
    server: sqlServer,
    database: sqlDatabase,
    options: { encrypt: true },
    connectionTimeout: connectTimeoutMs,
    // Market Monitor's Moves capture issues ~2,651 statements per run (one per
    // keyword per engine, sequentially). 15s was tight enough that a slightly
    // slow server tipped it into "Timeout: Request failed to complete in
    // 15000ms" — which job_log recorded on 2026-07-05 and 07-06. The statement
    // COUNT is the real problem and is batched separately; this just stops a slow
    // day being an outage.
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT_MS || "60000"),
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  poolTokenExpiresOnMs = token.expiresOnTimestamp;

  // The reset MUST be on the OUTER promise. Attaching it to the inner one (as
  // before) misses the timeout path — which is the path that actually fires.
  poolPromise = withTimeout(
    new sql.ConnectionPool(config).connect(),
    connectTimeoutMs,
    "SQL ConnectionPool.connect"
  ).catch((err) => {
    poolPromise = null;
    poolTokenExpiresOnMs = 0;
    throw err;
  });

  return poolPromise;
}
