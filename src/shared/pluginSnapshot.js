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

/**
 * Authorization headers for an outbound plugin call.
 *
 * MIRRORS arion-api `lib/pluginClient.js buildPluginAuth()` — deliberately, and
 * this file must not drift from it again.
 *
 * 2026-08-14 root cause: this job only ever implemented the LEGACY app-password
 * path, and did not even SELECT `site_token_raw`. Every ARION-provisioned site
 * authenticates with the site token (zero-config, set on every redeem/rotate);
 * the app password only exists where a staffer created one by hand in WP admin.
 * All four production sites have a token and NO app password — so every fetch
 * returned "no host or app password", okCount hit 0, every site was SKIPped as
 * unreachable, and `arion.site_plugin_snapshot` sat at 0 rows since the job was
 * written. The live proxy in arion-api works precisely because it sends both.
 *
 * Send BOTH when available so the plugin's check_token_or_admin permission
 * callback passes on either path.
 */
function buildPluginAuthHeaders(site) {
  // no-cache is not belt-and-braces here. Every one of our sites runs LiteSpeed,
  // and LiteSpeed will happily cache a /wp-json response — which means the
  // nightly snapshot can capture LAST WEEK'S numbers indefinitely and look
  // completely healthy doing it. Caught 2026-08-14: the site had been upgraded
  // to plugin v1.4.0 and the snapshot still stored the 1.3.3 payload, so every
  // new column came back NULL and the word counts never moved.
  const headers = {
    Accept: "application/json",
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
  };
  if (site?.site_token_raw) headers["X-Arion-Site-Token"] = site.site_token_raw;
  if (site?.wp_app_password_ref) {
    headers.Authorization = "Basic " + Buffer.from(site.wp_app_password_ref).toString("base64");
  }
  return headers;
}

/** One stamp per process, so every call in a run bypasses cache the same way. */
const RUN_STAMP = Date.now().toString(36);

async function pluginFetch(site, path) {
  const host = resolveHost(site);
  const headers = buildPluginAuthHeaders(site);
  const hasAuth = Boolean(headers["X-Arion-Site-Token"] || headers.Authorization);
  if (!host || !hasAuth) {
    return {
      ok: false, data: null, pluginStatus: "unreachable",
      errorText: !host ? "no host" : "no site token or app password",
    };
  }
  // A cache-busting param as well as the headers: an edge cache is free to
  // ignore Cache-Control on a response it already holds, but it cannot ignore a
  // URL it has never seen. Stamped per snapshot run, not per request, so one
  // run is internally consistent.
  const url = `https://${host}/wp-json/intelligent-analytics/v1${path}`
    + `${path.includes("?") ? "&" : "?"}_ia_cb=${RUN_STAMP}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "GET",
      headers,
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
    // Shield Security data. The IA Plugin serves it via the legacy
    // /security/wordfence route, which now returns Shield fields.
    shield: "/security/wordfence",
    coreHealth: "/security/core-health",
    users: "/security/users",
    litespeed: "/performance/litespeed",
    shortpixel: "/performance/shortpixel",
    ewww: "/performance/ewww",
    server: "/performance/server",
    cron: "/performance/cron",
    contentSummary: "/content/summary",
    seoAggregate: "/content/seo-aggregate",
    // Per-PAGE rows (up to 500). The aggregate above only yields site averages;
    // these are the line items the Website reports are built on, and until
    // 2026-08-14 they were fetched nowhere and stored nowhere.
    seoDetail: "/content/seo-detail",
    // v1.4.0. Both are whole-corpus views the per-page rows cannot give:
    // contentLinks answers "can anyone reach this page", mediaAudit answers
    // "what is the media library doing to the site". Sites still on an older
    // plugin 404 here, which pluginFetch records as a failed endpoint and the
    // rest of the snapshot ignores.
    contentLinks: "/content/links",
    mediaAudit: "/media/audit",
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
  // Shield Security payload (served via the legacy /security/wordfence route).
  const shield = pulled.shield?.data || {};
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
    // Shield Security metrics. DB columns keep the legacy wordfence_* names
    // (renaming requires a migration — out of scope) but carry Shield data.
    wordfence_active: shield.installed === true ? 1 : shield.installed === false ? 0 : null,
    wordfence_firewall_on: shield.firewall_enabled === true ? 1 : shield.firewall_enabled === false ? 0 : null,
    wordfence_last_scan_at: shield.last_scan_at || null,
    wordfence_blocked_24h: shield.blocked_attacks_24h ?? null,
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

  // Normalise a permalink to a PATH so GSC (full URL) and GA4 (path) can both
  // be joined to this later without a second normalisation pass. Declared out
  // here because the content, link and media blocks below all need it.
  const toPath = (url) => {
    if (!url) return null;
    try {
      const u = new URL(url);
      const p = u.pathname.replace(/\/+$/, "");
      return p === "" ? "/" : p;
    } catch { return null; }
  };

  // ── Per-PAGE content history (migration 048) ───────────────────────────
  // The rows /content/seo-detail returns were previously fetched, aggregated to
  // two averages, and thrown away. Storing them is what makes "this page has
  // been decaying since March" possible instead of only "this page is thin".
  //
  // Additive and non-fatal: a content failure must never cost us the snapshot
  // row we already wrote above.
  let contentRows = 0;
  try {
    const rows = pulled.seoDetail?.data?.rows;
    if (Array.isArray(rows) && rows.length) {

      // MERGE per row keyed on (site, post, date) so a same-day re-run updates
      // rather than duplicating — a manual re-run is always safe.
      for (const r of rows) {
        const postId = Number(r.post_id);
        if (!Number.isInteger(postId)) continue;
        await pool.request()
          .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
          .input("siteId", sql.UniqueIdentifier, site.site_id)
          .input("day", sql.Date, today)
          .input("postId", sql.Int, postId)
          .input("postType", sql.NVarChar(20), r.type || null)
          .input("title", sql.NVarChar(400), r.title ? String(r.title).slice(0, 400) : null)
          .input("permalink", sql.NVarChar(1000), r.permalink || null)
          .input("urlPath", sql.NVarChar(500), toPath(r.permalink))
          .input("seoScore", sql.Int, Number.isFinite(Number(r.seo_score)) ? Number(r.seo_score) : null)
          .input("focusKw", sql.NVarChar(255), r.focus_keyword || null)
          .input("hasMeta", sql.Bit, r.has_meta_desc ? 1 : 0)
          .input("metaLen", sql.Int, Number.isFinite(Number(r.meta_desc_len)) ? Number(r.meta_desc_len) : null)
          .input("schemaType", sql.NVarChar(100), r.schema_type || null)
          .input("readability", sql.Int, r.readability != null ? Number(r.readability) : null)
          .input("wordCount", sql.Int, Number.isFinite(Number(r.word_count)) ? Number(r.word_count) : null)
          .input("noindex", sql.Bit, r.is_noindex ? 1 : 0)
          .input("lastMod", sql.DateTime2, r.last_modified || null)
          // v1.4.0 (migration 049). Null on anything captured by an older
          // plugin, which is the honest record: we did not know then.
          .input("source", sql.NVarChar(20), r.content_source || null)
          .input("h1", sql.Int, Number.isFinite(Number(r.h1_count)) ? Number(r.h1_count) : null)
          .input("h2", sql.Int, Number.isFinite(Number(r.h2_count)) ? Number(r.h2_count) : null)
          .input("h3", sql.Int, Number.isFinite(Number(r.h3_count)) ? Number(r.h3_count) : null)
          .query(`
            MERGE arion.site_content_item AS tgt
            USING (VALUES (@siteId, @postId, @day)) AS src(site_id, post_id, snapshot_date)
              ON tgt.site_id = src.site_id AND tgt.post_id = src.post_id
             AND tgt.snapshot_date = src.snapshot_date
            WHEN MATCHED THEN UPDATE SET
              post_type = @postType, title = @title, permalink = @permalink, url_path = @urlPath,
              seo_score = @seoScore, focus_keyword = @focusKw, has_meta_desc = @hasMeta,
              meta_desc_len = @metaLen, schema_type = @schemaType, readability = @readability,
              word_count = @wordCount, is_noindex = @noindex, last_modified = @lastMod,
              content_source = @source, h1_count = @h1, h2_count = @h2, h3_count = @h3,
              captured_at = SYSDATETIMEOFFSET()
            WHEN NOT MATCHED THEN INSERT
              (tenant_id, site_id, snapshot_date, post_id, post_type, title, permalink, url_path,
               seo_score, focus_keyword, has_meta_desc, meta_desc_len, schema_type, readability,
               word_count, is_noindex, last_modified, content_source, h1_count, h2_count, h3_count)
            VALUES
              (@tenantId, @siteId, @day, @postId, @postType, @title, @permalink, @urlPath,
               @seoScore, @focusKw, @hasMeta, @metaLen, @schemaType, @readability,
               @wordCount, @noindex, @lastMod, @source, @h1, @h2, @h3);`);
        contentRows++;
      }
      log(`  stored ${contentRows} content item(s)`);
    } else if (pulled.seoDetail && !pulled.seoDetail.ok) {
      log(`  content detail unavailable: ${pulled.seoDetail.errorText || "unknown"}`);
    }
  } catch (e) {
    // Loud, but never fatal — the snapshot row above is already committed.
    log(`  CONTENT CAPTURE FAILED: ${e.message}`);
  }

  // ── Link graph + media library (migration 050, plugin v1.4.0) ──────────
  // Both are whole-corpus views: "can anyone reach this page" and "what is the
  // media library doing to the site". Sites on an older plugin 404 here, which
  // is why each block checks for rows rather than assuming.
  //
  // Same rule as the content block above: additive and non-fatal. Neither of
  // these may cost us the snapshot row that is already written.
  let linkRows = 0;
  try {
    const rows = pulled.contentLinks?.data?.rows;
    if (Array.isArray(rows) && rows.length) {
      for (const r of rows) {
        const postId = Number(r.post_id);
        if (!Number.isInteger(postId)) continue;
        await pool.request()
          .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
          .input("siteId", sql.UniqueIdentifier, site.site_id)
          .input("day", sql.Date, today)
          .input("postId", sql.Int, postId)
          .input("title", sql.NVarChar(400), r.title ? String(r.title).slice(0, 400) : null)
          .input("urlPath", sql.NVarChar(500), toPath(r.permalink))
          .input("out", sql.Int, Number(r.links_out) || 0)
          .input("outExt", sql.Int, Number(r.links_out_external) || 0)
          .input("in_", sql.Int, Number(r.links_in) || 0)
          .input("inMenu", sql.Bit, r.in_menu ? 1 : 0)
          .input("orphan", sql.Bit, r.is_orphan ? 1 : 0)
          .input("toMissing", sql.Int, (r.to_missing || []).length)
          .input("toUnpub", sql.Int, (r.to_unpublished || []).length)
          // The paths, not just the count — a number tells an owner they have a
          // problem, the list tells them where it is.
          .input("missPaths", sql.NVarChar(sql.MAX),
                 (r.to_missing || []).length ? JSON.stringify(r.to_missing.slice(0, 40)) : null)
          .query(`
            MERGE arion.site_page_link AS tgt
            USING (VALUES (@siteId, @postId, @day)) AS src(site_id, post_id, snapshot_date)
              ON tgt.site_id = src.site_id AND tgt.post_id = src.post_id
             AND tgt.snapshot_date = src.snapshot_date
            WHEN MATCHED THEN UPDATE SET
              title = @title, url_path = @urlPath, links_out = @out,
              links_out_external = @outExt, links_in = @in_, in_menu = @inMenu,
              is_orphan = @orphan, to_missing = @toMissing, to_unpublished = @toUnpub,
              to_missing_paths = @missPaths, captured_at = SYSDATETIMEOFFSET()
            WHEN NOT MATCHED THEN INSERT
              (tenant_id, site_id, snapshot_date, post_id, title, url_path, links_out,
               links_out_external, links_in, in_menu, is_orphan, to_missing,
               to_unpublished, to_missing_paths)
            VALUES
              (@tenantId, @siteId, @day, @postId, @title, @urlPath, @out,
               @outExt, @in_, @inMenu, @orphan, @toMissing, @toUnpub, @missPaths);`);
        linkRows++;
      }
      const sum = pulled.contentLinks.data.summary || {};
      log(`  stored ${linkRows} link row(s) — ${sum.orphan_count ?? "?"} orphan(s), ${sum.links_to_missing ?? "?"} link(s) to missing pages`);
    }
  } catch (e) {
    log(`  LINK CAPTURE FAILED: ${e.message}`);
  }

  let mediaRows = 0;
  try {
    const rows = pulled.mediaAudit?.data?.rows;
    if (Array.isArray(rows) && rows.length) {
      for (const r of rows) {
        const attId = Number(r.attachment_id);
        if (!Number.isInteger(attId)) continue;
        await pool.request()
          .input("tenantId", sql.UniqueIdentifier, site.tenant_id)
          .input("siteId", sql.UniqueIdentifier, site.site_id)
          .input("day", sql.Date, today)
          .input("attId", sql.Int, attId)
          .input("title", sql.NVarChar(400), r.title ? String(r.title).slice(0, 400) : null)
          .input("file", sql.NVarChar(500), r.file ? String(r.file).slice(0, 500) : null)
          .input("mime", sql.NVarChar(100), r.mime || null)
          .input("bytes", sql.BigInt, Number.isFinite(Number(r.bytes)) ? Number(r.bytes) : null)
          .input("w", sql.Int, r.width == null ? null : Number(r.width))
          .input("h", sql.Int, r.height == null ? null : Number(r.height))
          .input("alt", sql.Bit, r.has_alt ? 1 : 0)
          .input("img", sql.Bit, r.is_image ? 1 : 0)
          .input("ref", sql.Bit, r.referenced ? 1 : 0)
          .input("big", sql.Bit, r.oversized ? 1 : 0)
          .input("parent", sql.Int, r.attached_to == null ? null : Number(r.attached_to))
          .input("up", sql.DateTime2, r.uploaded_at || null)
          .query(`
            MERGE arion.site_media_item AS tgt
            USING (VALUES (@siteId, @attId, @day)) AS src(site_id, attachment_id, snapshot_date)
              ON tgt.site_id = src.site_id AND tgt.attachment_id = src.attachment_id
             AND tgt.snapshot_date = src.snapshot_date
            WHEN MATCHED THEN UPDATE SET
              title = @title, file_path = @file, mime = @mime, bytes = @bytes,
              width = @w, height = @h, has_alt = @alt, is_image = @img,
              referenced = @ref, oversized = @big, attached_to = @parent,
              uploaded_at = @up, captured_at = SYSDATETIMEOFFSET()
            WHEN NOT MATCHED THEN INSERT
              (tenant_id, site_id, snapshot_date, attachment_id, title, file_path, mime,
               bytes, width, height, has_alt, is_image, referenced, oversized,
               attached_to, uploaded_at)
            VALUES
              (@tenantId, @siteId, @day, @attId, @title, @file, @mime,
               @bytes, @w, @h, @alt, @img, @ref, @big, @parent, @up);`);
        mediaRows++;
      }
      const sum = pulled.mediaAudit.data.summary || {};
      log(`  stored ${mediaRows} media row(s) — ${Math.round((sum.library_bytes || 0) / 1048576)}MB, ${sum.missing_alt ?? "?"} missing alt, ${sum.unused ?? "?"} unused${sum.scan === "partial" ? " (PARTIAL scan)" : ""}`);
    }
  } catch (e) {
    log(`  MEDIA CAPTURE FAILED: ${e.message}`);
  }

  return { siteId: site.site_id, written: true, endpointsOk: okCount, endpointsTotal: totalCount, contentRows, linkRows, mediaRows };
}

/**
 * Run snapshot for every site that has plugin connectivity markers.
 */
export async function runPluginSnapshot(pool, log = () => {}) {
  // site_token_raw is the PRIMARY credential and was missing from this SELECT —
  // see buildPluginAuthHeaders(). Without it every fetch was unauthenticated.
  //
  // The WHERE also had an operator-precedence bug: AND binds tighter than OR, so
  //   status IS NULL OR status != 'suspended' AND <has credential>
  // parsed as
  //   status IS NULL OR (status != 'suspended' AND <has credential>)
  // which admitted NULL-status sites carrying no credential at all — they then
  // failed every fetch and were SKIPped as "unreachable". Parenthesised, and the
  // credential test now accepts EITHER auth path.
  const sitesResult = await pool.request().query(`
    SELECT site_id, tenant_id, domain, wp_admin_url, wp_app_password_ref, site_token_raw,
           plugin_status, plugin_version
    FROM arion.site
    WHERE (status IS NULL OR status <> 'suspended')
      AND (site_token_raw IS NOT NULL OR wp_app_password_ref IS NOT NULL)
    ORDER BY plugin_last_status_at ASC
  `);
  const sites = sitesResult.recordset;
  log(`found ${sites.length} site(s) with a usable plugin credential`);

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
