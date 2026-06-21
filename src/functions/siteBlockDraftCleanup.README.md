# AI Website Builder — Site Block Draft Cleanup

Timer-triggered Azure Function that prunes stale rows from
`arion.site_block_draft` so the table doesn't grow unbounded.

## What it does

Once per night, the job runs two parameterized `DELETE` statements against
`arion.site_block_draft` (iadm_services DB):

1. **Discarded drafts** — `WHERE accepted = 0 AND created_at < (now - 30d)`
   The founder had 30 days to recover any block they discarded by accident.
   Past that, the row goes.

2. **Stale accepted drafts** — `WHERE accepted = 1 AND created_at < (now - 90d)`
   Accepted drafts were already injected into the live WP page by
   `wpInjector.js`; the row is pure audit history at that point. 90 days
   is plenty for "what did we ship to this site last quarter?" reviews.

Row counts for both deletes are logged separately to App Insights.

## Why two TTLs (and these values)

- The Portal AI Website Builder generates blocks on every emit run. Most
  get discarded as the founder iterates on a hero/services section. Without
  a sweep, every test/preview piles up forever.
- Keeping the unaccepted window short (30d) keeps the table small without
  costing the founder real undo room — the Portal recovery UI doesn't
  surface drafts older than that anyway.
- Keeping the accepted window longer (90d) preserves audit trail across
  a quarter so we can answer "did we change this site's hero copy in Q1?"
  without digging into Elementor revisions.

Both knobs are env-tunable (see below) — no migration needed to change them.

## Schedule

```
0 47 4 * * *
```

Fires at **04:47 UTC** daily. Off-peak (overnight US per
`convention_timer_schedules`), prime-minute `:47` sits past the existing
nightly cluster:

| Time      | Job                       |
| --------- | ------------------------- |
| 04:13 UTC | monthlyPageSpeed          |
| 04:15 UTC | pluginSnapshot            |
| 04:17 UTC | marketMonitorMoves        |
| 04:23 UTC | domainCheckCacheCleanup   |
| 04:29 UTC | marketMonitorPageChanges  |
| 04:43 UTC | marketMonitorBacklinks    |
| **04:47** | **siteBlockDraftCleanup** |

No DST adjustment needed — UTC.

## Dry-run mode

Set the App Setting:

```
SITE_BLOCK_DRAFT_CLEANUP_DRY_RUN=1
```

on `func-iadm-arion-prod`. The job runs the full logic but issues
`SELECT COUNT(*)` instead of `DELETE`, logging:

```
would-delete N unaccepted draft(s) older than 30d
would-delete M accepted draft(s) older than 90d
```

No rows are removed. Recommended for the **first 24 h after deploy** to
confirm the blast radius matches expectations before going live.

To go live, remove the setting (or set it to anything other than `"1"`).

## How to disable

Three options:

1. **Kill switch** — App Setting `SITE_BLOCK_DRAFT_CLEANUP_DISABLED=true`.
   The handler returns immediately, no SQL touched.
2. **Globally** — comment out the import line in `src/index.js`:
   ```js
   // import "./functions/siteBlockDraftCleanup.js";
   ```
   then commit + push. The pipeline will redeploy without the timer
   registered.
3. **Tune retention** — bump `SITE_BLOCK_DRAFT_DISCARD_TTL_DAYS` or
   `SITE_BLOCK_DRAFT_ACCEPTED_TTL_DAYS` to a much larger value (e.g.
   `36500` for "effectively never"). No code change needed.

## Required Function App settings

| Setting                              | Source                       | Notes                                              |
| ------------------------------------ | ---------------------------- | -------------------------------------------------- |
| `SERVICES_SQL_SERVER`                | existing                     | reused from every other arion-func timer           |
| `SERVICES_SQL_DATABASE`              | existing (`iadm_services`)   | `arion.*` tables live here                         |
| `SITE_BLOCK_DRAFT_CLEANUP_DRY_RUN`   | optional, `"1"` = preview    | unset = real deletes                               |
| `SITE_BLOCK_DRAFT_CLEANUP_DISABLED`  | optional, `"true"` = no-op   | kill switch                                        |
| `SITE_BLOCK_DRAFT_DISCARD_TTL_DAYS`  | optional, default `30`       | unaccepted draft retention (days)                  |
| `SITE_BLOCK_DRAFT_ACCEPTED_TTL_DAYS` | optional, default `90`       | accepted draft retention (days)                    |

The function app's managed identity already has `db_datawriter` on
`iadm_services` (used by every other timer). No new RBAC grants needed.

## Verifying locally

```
node scripts/verify-site-block-draft-cleanup.mjs
```

The verifier:

1. Generates a process-unique tenant UUID.
2. Inserts 5 sentinel rows (3 unaccepted at 31/45/60 days old, 2 accepted
   at 91/120 days old).
3. Runs `runSiteBlockDraftCleanup()` in real mode.
4. Asserts 0 sentinel rows remain.
5. Belt-and-suspenders sweep of the sentinel tenant on exit (even on
   failure).

Exit code `0` = pass, `1` = fail. Safe to run against prod (uses an
isolated random tenant_id, never touches real customer drafts).

## Index plan

Both deletes seek `IX_site_block_draft_tenant_created` from migration 024
(`tenant_id, created_at DESC`). The leading `tenant_id` column isn't in
our WHERE clause, so the optimizer falls back to a scan — but since the
table is bounded by exactly this cleanup's TTLs, the scan stays cheap.
If/when the table grows large enough to matter, the right fix is a
filtered index:

```sql
CREATE INDEX IX_sbd_unaccepted_created
  ON arion.site_block_draft (created_at)
  WHERE accepted = 0;
CREATE INDEX IX_sbd_accepted_created
  ON arion.site_block_draft (created_at)
  WHERE accepted = 1;
```

Not adding now — premature.

## Cost-at-scale estimate

- Cron: 1 tick/day × 2 SQL roundtrips. Negligible.
- SQL: each DELETE is a range scan + tombstone write. At a few hundred
  rows/night this is sub-second.
- Function App compute: each tick is well under 1s on the existing
  Consumption plan, way under the 5-minute timeout.

Net infra add: $0/month.
