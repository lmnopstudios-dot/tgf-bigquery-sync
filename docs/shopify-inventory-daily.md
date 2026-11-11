# Daily Shopify inventory history

Create a separate Render Node cron only after approving the preview and first
write. This change does not add a service to the auto-synced Blueprint.

| Setting | Value |
| --- | --- |
| Name | oracle-shopify-inventory-daily |
| Branch | main after merge |
| Build | npm ci |
| Schedule | `20 2 * * *` UTC |
| Command | `node shopify/inventory-daily.js apply` |
| Environment | Existing Shopify shop/client credentials and BigQuery project/service credentials; `SHOPIFY_INVENTORY_DAILY_ENABLED=true` only after approval |

02:20 UTC is 02:20 London in winter and 03:20 in summer. This runs once per
London day through both clock changes. Shopify needs product, location and
inventory read access. Do not add write scopes. Keep catalogue and finance
jobs unchanged.

1. From a checkout of this revision with existing credentials:
   `timeout --kill-after=5s 16m node shopify/inventory-daily.js preview`.
   This only reads Shopify and prints aggregate counts. Check that the
   variant/location counts are plausible. Limits: 15 minutes for auth and
   reads, 14,000 GraphQL attempts, 250,000 matrix rows. Limit or partial-page
   failures do not publish. If the catalogue exceeds the bounds, review the
   collection strategy before enabling.
2. After explicit approval, initialize only the two missing permanent tables:
   `SHOPIFY_INVENTORY_DAILY_ENABLED=true node shopify/inventory-daily.js setup`.
   This requires cleared dataset defaults and verifies both tables have no
   table or partition expiry. The manifest has one internal serialization
   row (null snapshot date); exclude it from reporting.
3. First write: `SHOPIFY_INVENTORY_DAILY_ENABLED=true node shopify/inventory-daily.js apply`.
   Run only one invocation at a time. The collector uses fresh observations.
   Each stage expires after two hours. A transaction locks publication,
   validates the staged key count, inserts snapshots and the manifest together,
   and leaves an already published date unchanged. Concurrent transaction
   failures can be retried once the other run is terminal.
4. Verify using the aggregate query below and enable the cron only after
   reviewing the committed result. Schedule a separate check at `10 4 * * *`
   UTC with `node shopify/inventory-daily.js check` and configure Render
   failure notifications. The check exits nonzero on missing, incomplete,
   late (after 04:00 UTC), or expiring storage. No Shopify read is used by it.

```sql
SELECT m.snapshot_date,m.started_at,m.ended_at,m.variants,m.locations,
       m.row_count AS manifest_rows,COUNT(s.variant_id) AS stored_rows,
       COUNTIF(s.stock_state='missing_quantity') AS incomplete_quantity_rows,
       COUNTIF(s.stock_state='unstocked') AS unstocked_rows,
       COUNTIF(s.stock_state='untracked') AS untracked_rows
FROM `gf-full-data.shopify_data.inventory_daily_manifest` m
LEFT JOIN `gf-full-data.shopify_data.inventory_daily_snapshots` s
  ON s.snapshot_date=m.snapshot_date
WHERE m.snapshot_date=CURRENT_DATE('Europe/London')
GROUP BY 1,2,3,4,5,6;
```

Oracle should read only dates joined to a successful manifest; use a London
calendar spine so missing dates remain gaps. Use exact variant/location IDs.
Use the observation on the actual last calendar day for month-end; if missing,
label the nearest earlier observation with its actual date. A stockout day is
a tracked, stocked location observed with known available stock at or below
zero. For a location pool, require a known quantity for each member before
combining. Workshop labels are based on the location name and should be
reviewed if naming changes. Keep explicit negative and zero values. This
matrix is not an inventory movement ledger, receipt record, continuous
stockout duration or sell-through measure. No historical backfill is supported.

Back up both permanent tables together into a restricted, separately managed
US dataset or storage destination with reviewed retention and deletion access.
Take copies during a quiet period and record the latest common manifest date.
Verify backup row counts by date against the manifest. Restore to separate
names first, check schema, row uniqueness, counts and expiry, and only then
switch consumers. Ensure the manifest has exactly one lock row before
re-enabling publication. Never rely solely on time travel for retention.


## Batched collector revision

The production preview reached 3,580 API attempts at the unchanged 900-second
deadline. Per-variant level requests caused excessive network overhead.
The revised reader retains product/variant pagination, then sends batches of
at most 50 inventory-item IDs for one exact active location at a time.
No inventoryLevels connection is used: all active locations are enumerated
and every tracked item/location pair is explicitly requested. A null level
means unstocked; a missing/null batch node fails the complete run. Untracked
items retain null quantities. Duplicate item IDs or changed tracking state
also fail closed so a changing catalogue cannot silently become a complete day.

The 12,000-variant/six-location synthetic fixture uses 1,562 attempts with a
single product (catalogue distribution changes the total). This measures
request count, not live elapsed time. Shopify query cost, not request count
alone, controls throughput. Returned requested cost and throttle restoration
metadata pace subsequent reads, with bounded throttle retries. A cost error
does not reduce coverage or automatically increase limits.

No bulk operation is created. Bulk asynchronous JSONL exports were considered,
but batched exact location reads keep preview query-only, avoid introducing
vendor job ownership/cancellation and parent-child download recovery, and retain
bounded synchronous failure semantics. Live preview must still prove completion.

From deployed code containing this revision, the full validation command is:

```bash
timeout --signal=TERM --kill-after=5s 16m node shopify/inventory-daily.js preview
```

It emits startup, authentication, catalogue and inventory-batch phase messages,
aggregate heartbeats every 15 seconds, and an allowlisted failure code.
No raw API messages, inventory rows, customer records, credentials or IDs are
logged. Setup/apply remain separately gated as above. Do not enable the cron
until this preview completes and a separately approved first publication is
verified. Existing snapshot/manifest publication and retention guards are unchanged.

Official API references:
- https://shopify.dev/docs/api/admin-graphql/2026-07/queries/nodes
- https://shopify.dev/docs/api/admin-graphql/2026-07/objects/InventoryItem
- https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits
- https://shopify.dev/docs/api/usage/bulk-operations/queries
