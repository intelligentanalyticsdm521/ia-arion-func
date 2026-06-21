// shared/platformPool.js — connect to the shared iadm_platform DB.
//
// arion-func's main pool (shared/servicesPool.js) points at iadm_services
// where lumen.* lives. The PLATFORM tenant directory (core.tenants) sits in
// iadm_platform on the same SQL server. Most timer jobs don't need it, so
// we keep this as a separate optional pool only the digest timer + future
// owner-resolution code paths import.
//
// Auth mirrors servicesPool exactly — same credential chain, same scope.

import sql from "mssql";
import {
  DefaultAzureCredential,
  AzureCliCredential,
  ManagedIdentityCredential,
} from "@azure/identity";

const authMode = process.env.AUTH_MODE || "LOCAL_DEV";
const sqlServer = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER;
const sqlDatabase = process.env.PLATFORM_SQL_DATABASE || "iadm_platform";
const SQL_SCOPE = "https://database.windows.net/.default";

function getCredential() {
  if (authMode === "MANAGED_IDENTITY") return new ManagedIdentityCredential();
  if (authMode === "AZURE_CLI") return new AzureCliCredential();
  return new DefaultAzureCredential();
}

let poolPromise = null;

export async function getPlatformPool() {
  if (poolPromise) return poolPromise;
  if (!sqlServer) throw new Error("SERVICES_SQL_SERVER (or SQL_SERVER) is required for platform DB");

  const connectTimeoutMs = Number(process.env.SQL_CONNECT_TIMEOUT_MS || "12000");
  const credential = getCredential();
  const token = await credential.getToken(SQL_SCOPE);

  const config = {
    server: sqlServer,
    database: sqlDatabase,
    options: { encrypt: true },
    connectionTimeout: connectTimeoutMs,
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT_MS || "15000"),
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
    pool: { max: 3, min: 0, idleTimeoutMillis: 30000 },
  };

  poolPromise = new sql.ConnectionPool(config)
    .connect()
    .catch((err) => { poolPromise = null; throw err; });

  return poolPromise;
}
