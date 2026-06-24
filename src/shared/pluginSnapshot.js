/**
 * Plugin snapshot puller.
 *
 * For each site with a connected IA Plugin, hit every plugin data endpoint,
 * aggregate the results, and upsert a daily row into
 * arion.site_plugin_snapshot + refresh arion.site_plugin_inventory.
 *
 * Uses the site's wp_app_password_ref for Basic auth — same pattern as the
 * arion-api pluginClient.js lib. Defaults to soft-failure: if one plugin
 * endpoint fails, we still capture the ones that worked and record errors
 * in the payload JSON so the next run can retry.
 */
import sql from "mssql";

const REQUEST_TIMEOUT_MS = 20_000;

function resolveHost(site) {
  if (site.domain) return String(site.domain).replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (site.wp_admin_url) {
    try { return new URL(site.wp_admin_url).host; } catch { /* ignore */ }
  }
  return null;
}

async function pluginFetch(site, path) {
  const host = resolveHost(site);
  if (!host || !site.wp_app_password_ref) {
    return { ok: false, data: null, pluginStatus: "unreachable", errorText: "no host or app password" };
  }
  const url = `https://${host}/wp-json/intelligent-analytics/v1${path}`;
  const auth = "Basic " + Buffer.from(site.wp_app_password_ref).toString("base64");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: auth },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* ignore */ }
    if (!res.ok) {
      return {
        ok: false,
        data,
        pluginStatus: res.status === 401 || res.status === 403 ? "token_invalid" : "error",
        errorText: `HTTP ${res.status}`,
      };
    }
    return { ok: true, data: data?.data ?? data, pluginStatus: data?.plugin_status || "connected" };
  } catch (err) {
    return {
      ok: false,
      data: null,
      pluginStatus: err.name === "AbortError" ? "timeout" : "unreachable",
      errorText: err.message,
    };
  }
}

/**
 * Fetch all plugin endpoints for a single site in parallel.
 * Returns an object with raw payloads for downstream aggregation.
 */
export async function pullPluginData(site) {
  const endpoints = {
    health: "/health",
    status: "/status",
    plugins: "/plugins",
    wordfence: "/security/wordfence",
    coreHealth: "/security/core-health",
    users: "/security/users",
    litespeed: "/performance/litespeed",
    shortpixel: "/performance/shortpixel",
    ewww: "/performance/ewww",
    server: "/performance/server",
    cron: "/performance/cron",
    contentSummary: "/content/summary",
    seoAggregate: "/content/seo-aggregate",
    theme: "/theme",
    formsSummary: "/forms/summary",
    updates: "/updates/available",
  };
  const entries = await Promise.all(
    Object.entries(endpoints).map(async ([k, p]) => [k, await pluginFetch(site, p)])
  );
  return Object.fromEntries(entries);
}

/**
 * Reduce raw plugin data into promoted columns + a payload_json for the
 * site_plugin_snapshot row. Any missing endpoint still produces a row.
 */
function buildSnapshotRow(siteRow, pulled) {
  const h = pulled.health?.data || {};
  const wf = pulled.wordfence?.data || {};
  const ch = pulled.coreHealth?.data || {};
  const ls = pulled.litespeed?.data || {};
  const sp = pulled.shortpixel?.data || {};
  const ew = pulled.ewww?.data || {};
  const th = pulled.theme?.data || {};
  const upd = pulled.updates?.data || {};
  const cs = pulled.contentSummary?.data || {};
  const seo = pulled.seoAggregate?.data || {};
  const status = pulled.status?.data || {};

  return {
    plugin_version: status.plugin_version || h.plugin_version || null,
    wp_version: h.wp_version || null,
    php_version: h.php_version || null,
    theme_name: th.name || null,
    theme_version: th.version || null,
    plugins_total: Array.isArray(pulled.plugins?.data) ? pulled.plugins.data.length : null,
    plugins_active: Array.isArray(pulled.plugins?.data) ? pulled.plugins.data.filter((p) => p.active).length : null,
    plugins_update_available: upd.plugin_update_count ?? null,
    theme_update_available: upd.theme_update_count > 0 ? 1 : 0,
    core_update_available: upd.core_update ? 1 : 0,
    wordfence_active: wf.installed === true ? 1 : wf.installed === false ? 0 : null,
    wordfence_firewall_on: wf.firewall_enabled === true ? 1 : wf.firewall_enabled === false ? 0 : null,
    wordfence_last_scan_at: wf.last_scan_at || null,
    wordfence_blocked_24h: wf.blocked_attacks_24h ?? null,
    core_health_critical: ch.critical_count ?? null,
    core_health_recommended: ch.recommended_count ?? null,
    litespeed_active: ls.installed === true ? 1 : ls.installed === false ? 0 : null,
    litespeed_opt_score: ls.optimization_score ?? null,
    shortpixel_active: sp.installed === true ? 1 : sp.installed === false ? 0 : null,
    ewww_active: ew.installed === true ? 1 : ew.installed === false ? 0 : null,
    posts_published: cs.posts_published ?? null,
    pages_published: cs.pages_published ?? null,
    media_count: cs.media_count ?? null,
    rm_avg_seo_score: seo.avg_seo_score != null ? Number(seo.avg_seo_score) : null,
    rm_posts_missing_meta: seo.posts_missing_meta_desc ?? null,
  };
}

/**
 * Upsert today's snapshot for a site + refresh plugin inventory.
 */
export async function snapshotSite(pool, site, log = () => {}) {
  const start = Date.now();
  const pulled = await pullPluginData(site);

  // Summary of endpoint health
  const okCount = Object.values(pulled).filter((r) => r?.ok).length;
  const totalCount = Object.values(pulled).length;
  log(`  fetched ${okCount}/${totalCount} endpoints in ${Date.now() - start}ms`);

  // If nothing succeeded at all, skip writing (avoid writing an all-null row)
  if (okCount === 0) {
    log(`  SKIP — no endpoints reachable`);
    return { siteId: site.site_id, written: false, reason: "unreachable" };
  }

  const row = buildSnapshotRow(site, pulled);
  const today = new Date().toISOString().slice(0, 10);
  const payloadJson = JSON.stringify({
    snapshot_date: today,
    raw: Object.fromEntries(
      Object.entries(pulled).map(([k, v]) => [k, v?.ok ? { data: v.data } : { error: v.errorText, status: v.pluginStatus }])
    ),
  });

  // Upsert snapshot — UQ_plugin_snapshot_daily ensures one row per (site_id, snapshot_date)
  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
    .input("siteId", sql.UniqueIdentifier, site.site_id)
    .input("snapshotDate", sql.Date, today)
    .input("pluginVersion", sql.NVarChar(20), row.plugin_version)
    .input("wpVersion", sql.NVarChar(20), row.wp_version)
    .input("phpVersion", sql.NVarChar(20), row.php_version)
    .input("themeName", sql.NVarChar(200), row.theme_name)
    .input("themeVersion", sql.NVarChar(40), row.theme_version)
    .input("pluginsTotal", sql.Int, row.plugins_total)
    .input("pluginsActive", sql.Int, row.plugins_active)
    .input("pluginsUpdateAvailable", sql.Int, row.plugins_update_available)
    .input("themeUpdateAvailable", sql.Bit, row.theme_update_available)
    .input("coreUpdateAvailable", sql.Bit, row.core_update_available)
    .input("wordfenceActive", sql.Bit, row.wordfence_active)
    .input("wordfenceFirewallOn", sql.Bit, row.wordfence_firewall_on)
    .input("wordfenceLastScanAt", sql.DateTimeOffset, row.wordfence_last_scan_at)
    .input("wordfenceBlocked24h", sql.Int, row.wordfence_blocked_24h)
    .input("coreHealthCritical", sql.Int, row.core_health_critical)
    .input("coreHealthRecommended", sql.Int, row.core_health_recommended)
    .input("litespeedActive", sql.Bit, row.litespeed_active)
    .input("litespeedOptScore", sql.Int, row.litespeed_opt_score)
    .input("shortpixelActive", sql.Bit, row.shortpixel_active)
    .input("ewwwActive", sql.Bit, row.ewww_active)
    .input("postsPublished", sql.Int, row.posts_published)
    .input("pagesPublished", sql.Int, row.pages_published)
    .input("mediaCount", sql.Int, row.media_count)
    .input("rmAvgSeoScore", sql.Decimal(5, 2), row.rm_avg_seo_score)
    .input("rmPostsMissingMeta", sql.Int, row.rm_posts_missing_meta)
    .input("payloadJson", sql.NVarChar(sql.MAX), payloadJson)
    .query(`
      MERGE arion.site_plugin_snapshot AS tgt
      USING (VALUES (@siteId, @snapshotDate)) AS src(site_id, snapshot_date)
      ON tgt.site_id = src.site_id AND tgt.snapshot_date = src.snapshot_date
      WHEN MATCHED THEN UPDATE SET
        plugin_version = @pluginVersion,
        wp_version = @wpVersion,
        php_version = @phpVersion,
        theme_name = @themeName,
        theme_version = @themeVersion,
        plugins_total = @pluginsTotal,
        plugins_active = @pluginsActive,
        plugins_update_available = @pluginsUpdateAvailable,
        theme_update_available = @themeUpdateAvailable,
        core_update_available = @coreUpdateAvailable,
        wordfence_active = @wordfenceActive,
        wordfence_firewall_on = @wordfenceFirewallOn,
        wordfence_last_scan_at = @wordfenceLastScanAt,
        wordfence_blocked_24h = @wordfenceBlocked24h,
        core_health_critical = @coreHealthCritical,
        core_health_recommended = @coreHealthRecommended,
        litespeed_active = @litespeedActive,
        litespeed_opt_score = @litespeedOptScore,
        shortpixel_active = @shortpixelActive,
        ewww_active = @ewwwActive,
        posts_published = @postsPublished,
        pages_published = @pagesPublished,
        media_count = @mediaCount,
        rm_avg_seo_score = @rmAvgSeoScore,
        rm_posts_missing_meta = @rmPostsMissingMeta,
        payload_json = @payloadJson,
        captured_at = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT
        (tenant_id, site_id, snapshot_date, plugin_version, wp_version, php_version,
         theme_name, theme_version, plugins_total, plugins_active, plugins_update_available,
         theme_update_available, core_update_available, wordfence_active, wordfence_firewall_on,
         wordfence_last_scan_at, wordfence_blocked_24h, core_health_critical, core_health_recommended,
         litespeed_active, litespeed_opt_score, shortpixel_active, ewww_active, posts_published, pages_published,
         media_count, rm_avg_seo_score, rm_posts_missing_meta, payload_json)
      VALUES
        (@tenantId, @siteId, @snapshotDate, @pluginVersion, @wpVersion, @phpVersion,
         @themeName, @themeVersion, @pluginsTotal, @pluginsActive, @pluginsUpdateAvailable,
         @themeUpdateAvailable, @coreUpdateAvailable, @wordfenceActive, @wordfenceFirewallOn,
         @wordfenceLastScanAt, @wordfenceBlocked24h, @coreHealthCritical, @coreHealthRecommended,
         @litespeedActive, @litespeedOptScore, @shortpixelActive, @ewwwActive, @postsPublished, @pagesPublished,
         @mediaCount, @rmAvgSeoScore, @rmPostsMissingMeta, @payloadJson);
    `);

  // Refresh plugin inventory — drop today's rows and reinsert fresh
  if (pulled.plugins?.ok && Array.isArray(pulled.plugins.data)) {
    await pool.request()
      .input("siteId", sql.UniqueIdentifier, site.site_id)
      .query(`DELETE FROM arion.site_plugin_inventory WHERE site_id = @siteId AND CAST(captured_at AS DATE) = CAST(SYSDATETIMEOFFSET() AS DATE)`);

    for (const p of pulled.plugins.data) {
      await pool.request()
        .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
        .input("siteId", sql.UniqueIdentifier, site.site_id)
        .input("pluginFile", sql.NVarChar(300), String(p.file || ""))
        .input("pluginSlug", sql.NVarChar(200), p.slug || null)
        .input("pluginName", sql.NVarChar(300), p.name || null)
        .input("currentVersion", sql.NVarChar(40), p.version || null)
        .input("newVersion", sql.NVarChar(40), null)
        .input("updateAvailable", sql.Bit, p.update_available ? 1 : 0)
        .input("isActive", sql.Bit, p.active ? 1 : 0)
        .input("author", sql.NVarChar(200), p.author || null)
        .query(`
          INSERT INTO arion.site_plugin_inventory
            (tenant_id, site_id, plugin_file, plugin_slug, plugin_name,
             current_version, new_version, update_available, is_active, author)
          VALUES (@tenantId, @siteId, @pluginFile, @pluginSlug, @pluginName,
                  @currentVersion, @newVersion, @updateAvailable, @isActive, @author)
        `);
    }
  }

  // Update site row connection state
  await pool.request()
    .input("siteId", sql.UniqueIdentifier, site.site_id)
    .input("version", sql.NVarChar(20), row.plugin_version)
    .query(`
      UPDATE arion.site
      SET plugin_status = 'connected',
          plugin_version = COALESCE(@version, plugin_version),
          plugin_last_status_at = SYSDATETIMEOFFSET(),
          plugin_connected_at = ISNULL(plugin_connected_at, SYSDATETIMEOFFSET())
      WHERE site_id = @siteId
    `);

  return { siteId: site.site_id, written: true, endpointsOk: okCount, endpointsTotal: totalCount };
}

/**
 * Run snapshot for every site that has plugin connectivity markers.
 */
export async function runPluginSnapshot(pool, log = () => {}) {
  const sitesResult = await pool.request().query(`
    SELECT site_id, tenant_id, domain, wp_admin_url, wp_app_password_ref,
           plugin_status, plugin_version
    FROM arion.site
    WHERE status IS NULL OR status != 'suspended'
      AND wp_app_password_ref IS NOT NULL
    ORDER BY plugin_last_status_at ASC
  `);
  const sites = sitesResult.recordset;
  log(`found ${sites.length} site(s) with plugin app-password configured`);

  const results = [];
  for (const site of sites) {
    try {
      log(`site ${site.domain || site.site_id}`);
      const r = await snapshotSite(pool, site, log);
      results.push(r);
    } catch (err) {
      log(`  ERROR: ${err.message}`);
      results.push({ siteId: site.site_id, written: false, reason: err.message });
    }
  }

  return {
    sitesChecked: sites.length,
    sitesWritten: results.filter((r) => r.written).length,
    errors: results.filter((r) => !r.written),
  };
}
