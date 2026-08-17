/**
 * ARGUS Auto-Topoff Charger — core logic.
 *
 * Runs from a timer-triggered Azure Function (see
 * src/functions/argusAutotopoffCharger.js). Scans every enabled config in
 * lumen.argus_autotopoff_config, joins to the per-tenant credit balance
 * (lumen.sp_argus_balance) and to core.tenants.saas_stripe_customer_id,
 * and fires a Stripe Invoice (one-shot, charge_automatically, off-session)
 * for tenants whose balance has dropped below threshold_credits and whose
 * month_spent_usd + pack_price stays under max_per_month_usd.
 *
 * On successful Stripe pay, the existing webhook (oliver-api
 * routes/webhooks.js handles invoice.paid + metadata.ia_argus_purchase=1)
 * grants the credits idempotently. The charger only writes bookkeeping:
 * month_spent_usd, last_charge_at, last_charge_amount_usd.
 *
 * Safety:
 *   - ARGUS_AUTOTOPOFF_DRY_RUN=1 short-circuits Stripe (logs "WOULD CHARGE")
 *   - Idempotency key on stripe.invoices.create — Stripe dedups for 24h
 *   - Pack price is matched against the LOCKED catalog in PACK_PRICE_USD;
 *     any mismatch with the Stripe-side unit_amount is logged + skipped
 *   - month_period_start rolls forward atomically before the cap check
 */

import sql from "mssql";
import { argusTables } from "./argusTables.js";

// Locked pack price map (USD) — matches scripts/seed-argus-data-pack-catalog.mjs
// `onetime` mode. Authoritative copy; Stripe is the source of truth at
// charge time, but we use this map for the cap check + sanity comparison.
export const PACK_PRICE_USD = Object.freeze({
  50: 5.00,
  100: 10.00,
  150: 15.00,
  200: 20.00,
  250: 22.50,
  300: 27.00,
  400: 36.00,
  500: 42.50,
  750: 63.75,
  1000: 80.00,
});

/**
 * Stamp YYYYMMDDHH (UTC) — used in the Stripe idempotency key so each
 * 15-min tick within the same hour collapses to one charge attempt per
 * tenant. (Stripe's idempotency window is 24h, so the hour bucket is the
 * right granularity: we want one shot per "current hour" if balance is
 * low, not one shot per 15-min tick.)
 */
function hourStamp(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}`;
}

/**
 * Lazy Stripe client. The arion-func App must have STRIPE_SECRET_KEY
 * either set directly or loaded from Key Vault via getSecret. We import
 * `stripe` dynamically to avoid breaking other timer functions if the
 * arion-func App ever ships without the package on disk.
 */
async function getStripeClient(secretLoader) {
  let key = process.env.STRIPE_SECRET_KEY;
  if (!key && typeof secretLoader === "function") {
    key = await secretLoader("STRIPE_SECRET_KEY", "STRIPE-SECRET-KEY");
  }
  if (!key) throw new Error("STRIPE_SECRET_KEY not set (env or Key Vault 'STRIPE-SECRET-KEY')");
  const { default: Stripe } = await import("stripe");
  return new Stripe(key, {
    apiVersion: "2024-06-20",
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: "arion-func/argus-autotopoff", version: "1.0.0" },
  });
}

/**
 * Pull every enabled auto-topoff config plus the tenant's current balance
 * and Stripe customer id.
 *
 * Cross-DB note: arion-func currently runs against a SINGLE services pool
 * (iadm_services). The reconciliation code path (shared/reconciliation.js)
 * already references `core.tenants` via cross-DB three-part naming inside
 * the same logical Azure SQL server, so that pattern is known to work
 * here. We use a single query with two joins rather than two-pool +
 * JS-merge to keep the timer tight.
 *
 * Returns:
 *   [{
 *     tenant_id, enabled, threshold_credits, refill_pack_size,
 *     max_per_month_usd, month_spent_usd, month_period_start,
 *     balance, saas_stripe_customer_id, business_name
 *   }, ...]
 */
async function loadCandidates(pool) {
  // 2026-07-21 split-brain fix: balance reads the CANONICAL ledger — the
  // same tables the balance endpoint and the My Brand meter use (argus.*
  // after migration 132; the oliver names before it). The old lumen CTE
  // read a ledger that debits never touched, so the charger would have
  // seen a stale-high balance and never topped anyone off. Accumulate
  // model: un-expired grants − all uses (matches creditLedger.getBalance).
  const T = await argusTables(pool);
  const r = await pool.request().query(`
    WITH balance AS (
      SELECT
        g.tenant_id,
        SUM(g.credits) AS lifetime_granted
      FROM ${T.CREDIT_GRANT} g
      WHERE g.expires_at IS NULL OR g.expires_at > SYSDATETIMEOFFSET()
      GROUP BY g.tenant_id
    ),
    spent AS (
      SELECT u.tenant_id, SUM(u.credits) AS lifetime_spent
      FROM ${T.CREDIT_USE} u
      GROUP BY u.tenant_id
    )
    SELECT
      c.tenant_id,
      c.enabled,
      c.threshold_credits,
      c.refill_pack_size,
      c.max_per_month_usd,
      c.month_spent_usd,
      c.month_period_start,
      ISNULL(b.lifetime_granted, 0) - ISNULL(s.lifetime_spent, 0) AS balance,
      t.saas_stripe_customer_id,
      t.business_name,
      t.primary_contact_email
    FROM ${T.AUTOTOPOFF_CONFIG} c
    LEFT JOIN balance b ON b.tenant_id = c.tenant_id
    LEFT JOIN spent   s ON s.tenant_id = c.tenant_id
    LEFT JOIN core.tenants t ON t.tenant_id = c.tenant_id
    WHERE c.enabled = 1
  `);
  return r.recordset || [];
}

/**
 * Atomically write the month rollover (if needed) and the post-charge
 * bookkeeping. Two separate UPDATEs — the rollover is cheap, but only
 * fires when the calendar month flips.
 */
async function recordCharge(pool, tenantId, packPriceUsd) {
  const T = await argusTables(pool);
  await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("price", sql.Decimal(10, 2), packPriceUsd)
    .query(`
      UPDATE ${T.AUTOTOPOFF_CONFIG}
         SET month_spent_usd       = month_spent_usd + @price,
             last_charge_at        = SYSUTCDATETIME(),
             last_charge_amount_usd = @price,
             updated_at            = SYSUTCDATETIME()
       WHERE tenant_id = @tid
    `);
}

async function rolloverMonthIfNeeded(pool, tenantId, monthPeriodStart) {
  const now = new Date();
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = monthPeriodStart ? new Date(monthPeriodStart) : null;
  // monthPeriodStart is a DATE column, so just compare year+month.
  const sameMonth =
    startDate &&
    startDate.getUTCFullYear() === firstOfMonth.getUTCFullYear() &&
    startDate.getUTCMonth() === firstOfMonth.getUTCMonth();
  if (sameMonth) return false;

  const T = await argusTables(pool);
  await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("first", sql.Date, firstOfMonth)
    .query(`
      UPDATE ${T.AUTOTOPOFF_CONFIG}
         SET month_spent_usd     = 0,
             month_period_start  = @first,
             updated_at          = SYSUTCDATETIME()
       WHERE tenant_id = @tid
    `);
  return true;
}

/**
 * Look up the Stripe Price for the given pack size (onetime mode).
 */
async function findPackPrice(stripe, packSize) {
  const lookupKey = `argus_pack_${packSize}_onetime`;
  const list = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (!list.data.length) {
    throw new Error(`Stripe price lookup_key "${lookupKey}" not found (run scripts/seed-argus-data-pack-catalog.mjs)`);
  }
  return list.data[0];
}

/**
 * Drive one full pass over enabled configs.
 *
 * @param {object} pool        — mssql connection pool (iadm_services)
 * @param {object} opts
 * @param {function} opts.log  — logger (context.log)
 * @param {function} [opts.secretLoader] — async (envName, secretName) => value
 * @returns {Promise<{scanned, charged, capped, no_customer, below_threshold, failed, dry_run}>}
 */
export async function runArgusAutotopoff(pool, opts = {}) {
  const log = opts.log || ((msg) => console.log(msg));
  const dryRun = String(process.env.ARGUS_AUTOTOPOFF_DRY_RUN || "").trim() === "1";
  const summary = { scanned: 0, charged: 0, capped: 0, no_customer: 0, below_threshold: 0, failed: 0, dry_run: dryRun };

  log(`scanning enabled configs (dry_run=${dryRun})`);
  const rows = await loadCandidates(pool);
  summary.scanned = rows.length;
  log(`found ${rows.length} enabled config(s)`);
  if (rows.length === 0) return summary;

  // Lazy Stripe init — only if we have at least one candidate that will
  // actually need a charge (otherwise we don't even need the secret).
  let stripe = null;

  for (const row of rows) {
    const tenantId = row.tenant_id;
    const packSize = Number(row.refill_pack_size);
    const packPrice = PACK_PRICE_USD[packSize];

    try {
      if (!Number.isFinite(packPrice)) {
        log(`[skip] tenant=${tenantId} unsupported pack_size=${packSize}`);
        summary.failed += 1;
        continue;
      }

      // 1. Roll over month if needed (this also resets month_spent_usd to 0
      //    in the DB so our cap check below uses fresh values).
      const rolled = await rolloverMonthIfNeeded(pool, tenantId, row.month_period_start);
      const monthSpent = rolled ? 0 : Number(row.month_spent_usd || 0);

      // 2. Balance gate — only charge if balance has dropped below threshold.
      const balance = Number(row.balance || 0);
      if (balance >= Number(row.threshold_credits)) {
        // Most tenants fall here every tick — keep the log terse.
        summary.below_threshold += 1;
        continue;
      }

      // 3. Cap gate — month_spent + pack_price must stay <= max.
      if (monthSpent + packPrice > Number(row.max_per_month_usd)) {
        log(`[cap_reached] tenant=${tenantId} month_spent=${monthSpent.toFixed(2)} pack=${packPrice.toFixed(2)} cap=${row.max_per_month_usd}`);
        summary.capped += 1;
        continue;
      }

      // 4. Stripe customer required.
      const customerId = row.saas_stripe_customer_id;
      if (!customerId) {
        log(`[no_customer] tenant=${tenantId} (no saas_stripe_customer_id on core.tenants)`);
        summary.no_customer += 1;
        continue;
      }

      // 5. Dry-run short circuit — log + record summary, but no Stripe call,
      //    no bookkeeping write.
      if (dryRun) {
        log(`[would_charge] tenant=${tenantId} pack=${packSize} price=${packPrice.toFixed(2)} customer=${customerId}`);
        summary.charged += 1;
        continue;
      }

      // 6. Stripe path — lazy-init the client on first real charge.
      if (!stripe) {
        stripe = await getStripeClient(opts.secretLoader);
      }

      const price = await findPackPrice(stripe, packSize);
      const stripeUnitUsd = Number(price.unit_amount || 0) / 100;
      if (Math.abs(stripeUnitUsd - packPrice) > 0.01) {
        log(`[skip] tenant=${tenantId} Stripe price mismatch: stripe=$${stripeUnitUsd} local=$${packPrice} — refusing to charge`);
        summary.failed += 1;
        continue;
      }

      const idemKey = `autotopoff_${tenantId}_${hourStamp()}`;

      // Pack-credits metadata MUST land on the invoice line so the webhook
      // (oliver-api routes/webhooks.js, invoice.paid branch) can credit
      // the pool. The webhook reads ia_argus_purchase + pack_credits +
      // tenant_id from the line's metadata, which is sourced from the
      // invoice-item metadata at finalize time.
      const lineMetadata = {
        ia_argus_purchase: "1",
        tenant_id: tenantId,
        pack_credits: String(packSize),
        pack_mode: "onetime",
        source: "autotopoff",
      };

      await stripe.invoiceItems.create({
        customer: customerId,
        price: price.id,
        currency: "usd",
        metadata: lineMetadata,
      });

      const invoice = await stripe.invoices.create(
        {
          customer: customerId,
          auto_advance: true,
          collection_method: "charge_automatically",
          metadata: {
            ia_argus_purchase: "1",
            tenant_id: tenantId,
            pack_credits: String(packSize),
            pack_mode: "onetime",
            source: "autotopoff",
          },
        },
        { idempotencyKey: idemKey }
      );

      await stripe.invoices.finalizeInvoice(invoice.id);

      try {
        await stripe.invoices.pay(invoice.id, { off_session: true });
      } catch (payErr) {
        // pay() can throw card_declined / authentication_required even on
        // a valid customer — Stripe will retry the invoice on its own
        // schedule (collection_method=charge_automatically). Webhook will
        // grant credits only on invoice.paid, so a deferred Stripe retry
        // is still safe.
        log(`[charge_failed:pay] tenant=${tenantId} invoice=${invoice.id} error=${payErr.message}`);
        summary.failed += 1;
        continue;
      }

      // 7. Bookkeeping — only on confirmed Stripe success.
      await recordCharge(pool, tenantId, packPrice);
      log(`[charged] tenant=${tenantId} pack=${packSize} price=${packPrice.toFixed(2)} invoice=${invoice.id}`);
      summary.charged += 1;
    } catch (err) {
      log(`[charge_failed] tenant=${tenantId} pack=${packSize} error=${err.message}`);
      summary.failed += 1;
    }
  }

  log(`summary scanned=${summary.scanned} charged=${summary.charged} below_threshold=${summary.below_threshold} capped=${summary.capped} no_customer=${summary.no_customer} failed=${summary.failed} dry_run=${dryRun}`);
  return summary;
}
