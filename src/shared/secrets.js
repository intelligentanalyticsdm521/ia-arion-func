/**
 * Lazy secret loader from Azure Key Vault — mirror of arion-api/lib/secrets.js.
 * Used by the timer functions which run in the arion-func App.
 */
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

const KEY_VAULT_URI = process.env.KEY_VAULT_URI || "https://kv-iadm-prod.vault.azure.net/";

let _client = null;
const _cache = new Map();

function getClient() {
  if (_client) return _client;
  try {
    _client = new SecretClient(KEY_VAULT_URI, new DefaultAzureCredential());
    return _client;
  } catch (err) {
    console.error('[secrets] Failed to init Key Vault client:', err.message);
    return null;
  }
}

export async function getSecret(envName, secretName) {
  if (process.env[envName]) return process.env[envName];
  if (_cache.has(secretName)) return _cache.get(secretName);
  const client = getClient();
  if (!client) {
    _cache.set(secretName, null);
    return null;
  }
  try {
    const secret = await client.getSecret(secretName);
    const val = secret?.value || null;
    _cache.set(secretName, val);
    return val;
  } catch (err) {
    console.error(`[secrets] Failed to read '${secretName}' from Key Vault:`, err.message);
    _cache.set(secretName, null);
    return null;
  }
}
