// test/services-pool-recovery.test.js
//
// Pins the two servicesPool bugs behind the Market Monitor outage.
//
// BUG 1 — A POISONED CACHE MADE ONE TIMEOUT PERMANENT.
// The old code reset `poolPromise = null` on the INNER promise:
//
//     poolPromise = withTimeout(
//       new sql.ConnectionPool(config).connect()
//         .then((pool) => pool)
//         .catch((err) => { poolPromise = null; throw err; }),   // inner
//       connectTimeoutMs, "SQL ConnectionPool.connect");
//
// so it only ran when connect() itself rejected. When the withTimeout wrapper
// rejected FIRST — what a slow SQL server actually causes — the reset never ran
// and poolPromise kept a REJECTED promise. `if (poolPromise) return poolPromise`
// then handed that same rejection to every later caller, forever, for the life of
// the process. One 12-second blip bricks the pool for all 18 functions until the
// app recycles.
//
// That is what a getServicesPool() failure looks like from outside, and it is
// exactly the Market Monitor signature: the timer fires every morning
// (status blob Last=2026-07-16T03:17) while market_monitor_job_log has no rows
// after 2026-07-10 — the run dies before it can log that it started.
//
// BUG 2 — the AAD token was fetched once and never refreshed. Tokens last ~1h;
// after that the pool cannot re-authenticate. This app runs 18 functions, several
// every few minutes, so the process is warm and this bites.
//
// These tests drive the REAL module with mssql and @azure/identity stubbed via
// module resolution, so they exercise the actual caching logic rather than a
// reimplementation of it.

import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// ── Stub loader: intercept `mssql` and `@azure/identity` for this test only ───
const LOADER = `
export async function resolve(specifier, context, next) {
  if (specifier === 'mssql') return { url: 'test-stub:mssql', shortCircuit: true };
  if (specifier === '@azure/identity') return { url: 'test-stub:identity', shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url === 'test-stub:mssql') {
    return { format: 'module', shortCircuit: true, source: \`
      export class ConnectionPool {
        constructor(config) { this.config = config; }
        async connect() {
          globalThis.__poolAttempts = (globalThis.__poolAttempts || 0) + 1;
          const mode = globalThis.__connectMode;
          if (mode === 'hang') { await new Promise(() => {}); }        // never settles -> withTimeout fires
          if (mode === 'reject') { throw new Error('connect refused'); }
          return { closed: false, close: async () => { this.closed = true; }, __token: this.config.authentication.options.token };
        }
      }
      export default { ConnectionPool };
    \` };
  }
  if (url === 'test-stub:identity') {
    return { format: 'module', shortCircuit: true, source: \`
      class Cred {
        async getToken() {
          return { token: 'tok-' + (globalThis.__tokenSeq = (globalThis.__tokenSeq || 0) + 1),
                   expiresOnTimestamp: globalThis.__tokenExpiry ?? (Date.now() + 3600e3) };
        }
      }
      export class DefaultAzureCredential extends Cred {}
      export class AzureCliCredential extends Cred {}
      export class ManagedIdentityCredential extends Cred {}
    \` };
  }
  return next(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(LOADER)}`, pathToFileURL("./"));

process.env.SERVICES_SQL_SERVER = "test.database.windows.net";
process.env.SQL_CONNECT_TIMEOUT_MS = "150"; // keep the timeout path fast

const MODULE = "../src/shared/servicesPool.js";

/** Fresh module instance per test — module-scope cache must not leak between them. */
async function freshPool() {
  const mod = await import(`${MODULE}?bust=${Math.random()}`);
  return mod.getServicesPool;
}

test("BUG 1: a CONNECT TIMEOUT must not poison the cache forever", async () => {
  const getServicesPool = await freshPool();
  globalThis.__poolAttempts = 0;

  // First call: connect hangs -> withTimeout rejects. This is the path the old
  // code's inner .catch never saw.
  globalThis.__connectMode = "hang";
  await assert.rejects(() => getServicesPool(), /timed out/, "expected the timeout to surface");
  const attemptsAfterFailure = globalThis.__poolAttempts;

  // Second call: the server is healthy again. The old code returned the SAME
  // rejected promise instantly and never even tried to reconnect.
  globalThis.__connectMode = "ok";
  const pool = await getServicesPool();

  assert.ok(pool, "🔴 POISONED CACHE — the pool never recovered after one timeout");
  assert.ok(
    globalThis.__poolAttempts > attemptsAfterFailure,
    "🔴 it did not even ATTEMPT to reconnect — the rejected promise was served from cache"
  );
});

test("a connect REJECTION also clears the cache (this path always worked)", async () => {
  const getServicesPool = await freshPool();
  globalThis.__connectMode = "reject";
  await assert.rejects(() => getServicesPool(), /connect refused/);
  globalThis.__connectMode = "ok";
  const pool = await getServicesPool();
  assert.ok(pool, "a plain rejection should also allow recovery");
});

test("a healthy pool IS cached — we must not reconnect on every call", async () => {
  const getServicesPool = await freshPool();
  globalThis.__connectMode = "ok";
  globalThis.__poolAttempts = 0;
  const a = await getServicesPool();
  const b = await getServicesPool();
  assert.equal(a, b, "should hand back the same pool");
  assert.equal(globalThis.__poolAttempts, 1, "should connect exactly once — the cache must still work");
});

test("BUG 2: an expired AAD token forces a rebuild with a FRESH token", async () => {
  const getServicesPool = await freshPool();
  globalThis.__connectMode = "ok";
  globalThis.__tokenSeq = 0;

  // A token already inside the 5-minute expiry buffer.
  globalThis.__tokenExpiry = Date.now() + 60_000;
  const first = await getServicesPool();
  const firstToken = first.__token;

  // Next call must NOT reuse a pool whose token is about to die.
  const second = await getServicesPool();

  assert.notEqual(second.__token, firstToken, "🔴 reused a pool whose AAD token is expiring — queries would fail with an auth error");
  assert.match(second.__token, /^tok-\d+$/);
});

test("a token with plenty of life left is NOT rebuilt", async () => {
  const getServicesPool = await freshPool();
  globalThis.__connectMode = "ok";
  globalThis.__tokenExpiry = Date.now() + 3600e3; // an hour out
  globalThis.__poolAttempts = 0;
  const a = await getServicesPool();
  const b = await getServicesPool();
  assert.equal(a, b, "should not churn the pool while the token is healthy");
  assert.equal(globalThis.__poolAttempts, 1);
});
