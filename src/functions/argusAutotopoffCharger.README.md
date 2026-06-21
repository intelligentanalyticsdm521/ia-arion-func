# ARGUS Auto-Topoff Charger

Timer-triggered Azure Function that auto-refills ARGUS AI credits via Stripe
for every tenant who has opted in.

## What it does

Every 15 minutes, the job:

1. Queries `lumen.argus_autotopoff_config` for rows with `enabled = 1`,
   joining to:
   - `lumen.argus_credit_grant` + `lumen.ai_call_audit` (computes the
     current credit balance — same math as `lumen.sp_argus_balance`)
   - `core.tenants` (for `saas_stripe_customer_id`)
2. Rolls over `month_period_start` + zeroes `month_spent_usd` when the UTC
   calendar month flips.
3. For each tenant whose balance is below `threshold_credits`:
   - Skip if `month_spent_usd + pack_price > max_per_month_usd` (cap
     guardrail) → logged as `cap_reached`.
   - Skip if `saas_stripe_customer_id` is null → logged as `no_customer`.
   - Look up the Stripe Price by `lookup_key = argus_pack_<size>_onetime`
     and confirm the unit_amount matches the locked map (anti-tamper).
   - Create a Stripe InvoiceItem with `metadata.ia_argus_purchase = "1"`
     + `pack_credits` + `tenant_id` (this is what the oliver-api webhook
     reads to grant credits).
   - Create + finalize + pay a Stripe Invoice (`charge_automatically`,
     `off_session: true`).
   - Update `month_spent_usd`, `last_charge_at`, `last_charge_amount_usd`.

The credit grant itself is NOT done in this job — it's done by the existing
webhook `oliver-api/routes/webhooks.js` `invoice.paid` branch, which
already handles `ia_argus_purchase=1` on the invoice line. The webhook is
idempotent per `stripe_invoice_id` via
`lumen.argus_credit_grant.stripe_invoice_id`.

## Schedule

```
0 3/15 * * * *
```

Fires at :03, :18, :33, :48 every hour (15-min cadence, off the
prime-minute :00 stampede). Roughly 96 ticks/day.

## Idempotency

Each `stripe.invoices.create` is called with idempotency key:

```
autotopoff_<tenant_id>_<YYYYMMDDHH>
```

Stripe dedups for 24 h on the same key, so a tenant cannot be charged
twice within the same UTC hour even if the timer mis-fires or the next
tick runs before the webhook has granted credits.

## Pack price catalog (LOCKED)

| Credits | USD     |
| ------- | ------- |
| 50      | $5.00   |
| 100     | $10.00  |
| 150     | $15.00  |
| 200     | $20.00  |
| 250     | $22.50  |
| 300     | $27.00  |
| 400     | $36.00  |
| 500     | $42.50  |
| 750     | $63.75  |
| 1000    | $80.00  |

Matches `oliver-api/scripts/seed-argus-data-pack-catalog.mjs`. Authoritative
copy lives in `src/shared/argusAutotopoff.js` `PACK_PRICE_USD`. If Stripe
returns a unit_amount that differs by more than $0.01, the charge is
refused and logged as `failed` (anti-tamper).

## Dry-run mode

Set the App Setting:

```
ARGUS_AUTOTOPOFF_DRY_RUN=1
```

on `func-iadm-arion-prod`. The job runs the full scan + cap math + all DB
reads, then logs `[would_charge] tenant=... pack=... price=...` instead of
hitting Stripe. No bookkeeping is written, no money moves. **Brandon
should keep this on for the first 24 h after deploy** to confirm the
candidate set looks right.

To go live, remove the setting (or set it to anything other than `"1"`).

## How to disable

Two clean options:

1. **Per-tenant** — `UPDATE lumen.argus_autotopoff_config SET enabled = 0
   WHERE tenant_id = ?` (the founder Auto-Topoff UI does this when the
   tenant toggles "Off").
2. **Globally** — comment out the import line in `src/index.js`:
   ```js
   // import "./functions/argusAutotopoffCharger.js";
   ```
   then commit + push. The pipeline will redeploy without the timer.

## Required Function App settings

| Setting                    | Source                                   | Notes                                                        |
| -------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `STRIPE_SECRET_KEY`        | KV ref → `kv-iadm-prod/STRIPE-SECRET-KEY`| LIVE mode in prod (see memory `reference_stripe_production_mode.md`) |
| `SERVICES_SQL_SERVER`      | existing                                 | reused from other arion-func timers                          |
| `SERVICES_SQL_DATABASE`    | existing (`iadm_services`)               | reused                                                       |
| `KEY_VAULT_URI`            | existing (`https://kv-iadm-prod.vault.azure.net/`) | reused via `shared/secrets.js`                     |
| `ARGUS_AUTOTOPOFF_DRY_RUN` | optional, `"1"` to disable real charges  | unset = live charges                                         |

The function app's managed identity already has `Key Vault Secrets User`
on `kv-iadm-prod` and `db_datawriter` on `iadm_services` (used by every
arion-func timer). No new RBAC grants needed.

## Cost-at-scale estimate

- Cron: 96 ticks/day × 1 SQL roundtrip + ~0–N Stripe calls per tick.
- SQL: one read query per tick (all enabled tenants in one shot). At
  10 k enabled tenants the result-set is ~1 MB — well within the timer
  budget.
- Stripe: per tenant who needs a charge, ~3 API calls
  (prices.list + invoiceItems.create + invoices.create + finalize + pay).
  At 100 charges/day this is ~500 Stripe API calls/day — free under
  Stripe's published quotas.
- Function App compute: each tick is ~1–2 s of CPU on the existing
  Consumption plan, well under the 5-minute timeout.

Net infra add: $0/month. Variable cost = Stripe processing fees on the
charges themselves (already priced into the pack margins per
`reference_argus_product_stack.md`).
