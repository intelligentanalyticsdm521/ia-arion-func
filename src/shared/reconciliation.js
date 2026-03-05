import sql from "mssql";

export async function reconcileArtifacts(pool, logger) {
  const sitesResult = await pool.request().query(`
    SELECT s.site_id, s.tenant_id, s.ssl_status, s.primary_domain, t.full_name, t.name
    FROM arion.sites s
    JOIN core.tenants t
      ON t.tenant_id = s.tenant_id;
  `);

  let seoUpserts = 0;
  let presenceCreated = 0;
  let healthCreated = 0;

  for (const site of sitesResult.recordset) {
    const integrationsResult = await pool
      .request()
      .input("site_id", sql.UniqueIdentifier, site.site_id)
      .query(`
        SELECT provider_code, status
        FROM arion.site_integrations
        WHERE site_id = @site_id;
      `);

    const providers = new Set(
      (integrationsResult.recordset || [])
        .filter((row) => String(row.status || "").toUpperCase() === "ACTIVE")
        .map((row) => String(row.provider_code || "").toUpperCase())
    );

    const ga4Connected = providers.has("GOOGLE_ANALYTICS");
    const searchConsoleConnected = providers.has("GOOGLE_SEARCH_CONSOLE");
    const bingWebmasterConnected = providers.has("BING_WEBMASTER");

    const seoExisting = await pool
      .request()
      .input("site_id", sql.UniqueIdentifier, site.site_id)
      .query(`SELECT TOP 1 site_seo_status_id FROM arion.site_seo_status WHERE site_id = @site_id ORDER BY updated_at DESC, created_at DESC;`);

    if (seoExisting.recordset[0]?.site_seo_status_id) {
      await pool
        .request()
        .input("site_seo_status_id", sql.UniqueIdentifier, seoExisting.recordset[0].site_seo_status_id)
        .input("ga4_connected", sql.Bit, ga4Connected)
        .input("search_console_connected", sql.Bit, searchConsoleConnected)
        .input("bing_webmaster_connected", sql.Bit, bingWebmasterConnected)
        .query(`
          UPDATE arion.site_seo_status
          SET ga4_connected = @ga4_connected,
              search_console_connected = @search_console_connected,
              bing_webmaster_connected = @bing_webmaster_connected,
              updated_at = SYSUTCDATETIME(),
              last_checked_at = SYSUTCDATETIME()
          WHERE site_seo_status_id = @site_seo_status_id;
        `);
    } else {
      await pool
        .request()
        .input("tenant_id", sql.UniqueIdentifier, site.tenant_id)
        .input("site_id", sql.UniqueIdentifier, site.site_id)
        .input("ga4_connected", sql.Bit, ga4Connected)
        .input("search_console_connected", sql.Bit, searchConsoleConnected)
        .input("bing_webmaster_connected", sql.Bit, bingWebmasterConnected)
        .query(`
          INSERT INTO arion.site_seo_status (
            tenant_id,
            site_id,
            ga4_connected,
            search_console_connected,
            bing_webmaster_connected,
            last_checked_at
          )
          VALUES (
            @tenant_id,
            @site_id,
            @ga4_connected,
            @search_console_connected,
            @bing_webmaster_connected,
            SYSUTCDATETIME()
          );
        `);
    }
    seoUpserts += 1;

    const presenceExisting = await pool
      .request()
      .input("site_id", sql.UniqueIdentifier, site.site_id)
      .query(`SELECT TOP 1 site_presence_id FROM arion.site_presence WHERE site_id = @site_id;`);

    if (!presenceExisting.recordset[0]?.site_presence_id) {
      await pool
        .request()
        .input("tenant_id", sql.UniqueIdentifier, site.tenant_id)
        .input("site_id", sql.UniqueIdentifier, site.site_id)
        .input("business_name", sql.NVarChar(500), site.full_name || site.name || null)
        .input("google_maps_url", sql.NVarChar(500), site.primary_domain ? `https://www.google.com/search?q=${encodeURIComponent(site.primary_domain)}` : null)
        .query(`
          INSERT INTO arion.site_presence (
            tenant_id,
            site_id,
            business_name,
            google_maps_url
          )
          VALUES (
            @tenant_id,
            @site_id,
            @business_name,
            @google_maps_url
          );
        `);
      presenceCreated += 1;
    }

    const healthExisting = await pool
      .request()
      .input("site_id", sql.UniqueIdentifier, site.site_id)
      .query(`SELECT TOP 1 site_health_id FROM arion.site_health WHERE site_id = @site_id ORDER BY updated_at DESC, created_at DESC;`);

    if (!healthExisting.recordset[0]?.site_health_id) {
      await pool
        .request()
        .input("tenant_id", sql.UniqueIdentifier, site.tenant_id)
        .input("site_id", sql.UniqueIdentifier, site.site_id)
        .input("ssl_status", sql.VarChar(50), site.ssl_status || null)
        .query(`
          INSERT INTO arion.site_health (
            tenant_id,
            site_id,
            ssl_status,
            site_status,
            created_at,
            updated_at
          )
          VALUES (
            @tenant_id,
            @site_id,
            @ssl_status,
            'UNKNOWN',
            SYSUTCDATETIME(),
            SYSUTCDATETIME()
          );
        `);
      healthCreated += 1;
    }
  }

  logger(`reconcileArtifacts complete: sites=${sitesResult.recordset.length} seoUpserts=${seoUpserts} presenceCreated=${presenceCreated} healthCreated=${healthCreated}`);
  return { sites: sitesResult.recordset.length, seoUpserts, presenceCreated, healthCreated };
}

export async function markStaleHealth(pool, logger) {
  const staleAfterHours = Number(process.env.ARION_STALE_HEALTH_HOURS || "24");

  const result = await pool
    .request()
    .input("stale_hours", sql.Int, staleAfterHours)
    .query(`
      UPDATE arion.site_health
      SET site_status = 'STALE',
          updated_at = SYSUTCDATETIME()
      WHERE last_health_check_at IS NOT NULL
        AND last_health_check_at < DATEADD(HOUR, -@stale_hours, SYSUTCDATETIME())
        AND (site_status IS NULL OR site_status <> 'STALE');

      SELECT @@ROWCOUNT AS updated_count;
    `);

  const updatedCount = result.recordset?.[0]?.updated_count || 0;
  logger(`markStaleHealth complete: updated=${updatedCount}`);
  return { updatedCount, staleAfterHours };
}
