/**
 * Minimal SE Ranking HTTP client for the arion-func timer jobs.
 *
 * Mirrors the request shape used in arion-api/lib/seranking.js but
 * self-contained (the function app doesn't import from arion-api).
 *
 * Two keys because SE Ranking has two separate APIs with separate billing:
 *   - SERANKING_API_SYSTEM_KEY     → https://api4.seranking.com (projects, audits, positions)
 *   - SERANKING_DATA_API_KEY       → https://api.seranking.com/v1 (backlinks, domain overview)
 *
 * Every request returns a shape { ok, status, data, errorText } so callers
 * can reason about upstream failures without try/catch.
 */

const PROJECT_BASE = process.env.SERANKING_PROJECT_API_BASE || "https://api4.seranking.com";
const DATA_BASE    = process.env.SERANKING_DATA_API_BASE    || "https://api.seranking.com/v1";

function projectHeaders() {
  const key = process.env.SERANKING_API_SYSTEM_KEY;
  if (!key) return null;
  return { "Authorization": `Token ${key}`, "Content-Type": "application/json" };
}

function dataHeaders() {
  const key = process.env.SERANKING_DATA_API_KEY;
  if (!key) return null;
  return { "Authorization": `Token ${key}`, "Content-Type": "application/json" };
}

async function doRequest(url, method, headers, body) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return {
    ok: res.ok,
    status: res.status,
    data,
    errorText: !res.ok ? (data?.message || data?.error || text || null) : null,
  };
}

/** Project API (api4) — positions, audits, competitors. */
export async function projectApi(method, path, body) {
  const headers = projectHeaders();
  if (!headers) return { ok: false, status: 0, data: null, errorText: "SERANKING_API_SYSTEM_KEY not configured" };
  return doRequest(`${PROJECT_BASE}${path}`, method, headers, body);
}

/** Data API (v1) — backlinks, domain overview, keyword suggestions. */
export async function dataApi(method, path, body) {
  const headers = dataHeaders();
  if (!headers) return { ok: false, status: 0, data: null, errorText: "SERANKING_DATA_API_KEY not configured" };
  return doRequest(`${DATA_BASE}${path}`, method, headers, body);
}
