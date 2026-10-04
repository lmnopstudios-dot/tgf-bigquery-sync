# September Shopify customer recovery and platform verification

## Known production evidence (before repair)

The deduplicated September 2026 GBP financial population is **1,138 distinct
orders**, covering **September 1–30**. All 1,138 match a location. Customer
evidence matches 946 orders and ends September 24; the 192 missing customer
orders span September 24–30. The 413 currently fully joined eligible orders
(GBP 112,676.29 under the repository metric) are partial evidence, not a
full-month online total. The former 4,130 / GBP 1,126,762.90 rendering was a
tenfold repeated-coverage defect. Duplicate indicators were zero and typed
`BigQuery.date` parameters agreed with independent date literals.

The metric is stable-order-level original presentment total less recorded
presentment refunds. It is not ShopifyQL net sales and can include shipping,
tax, duties, or fees. Current cancellation and financial-status fields fetched
during recovery are a current snapshot; they do **not** prove historical status.

## Render one-off commands

Deploy the commit, open the service's Render Shell, and run these in order:

```sh
# Read-only: exact IDs, count/date bounds, typed binding and literal control.
npm run repair:shopify-customers -- --start=2026-09-01 --end=2026-09-30 --currency=GBP

# Explicit customer-only repair. This is the sole mutating recovery command.
npm run repair:shopify-customers -- --apply --start=2026-09-01 --end=2026-09-30 --currency=GBP --max-ids=192 --max-retries=4

# Read-only: must show zero missing IDs after an accepted repair.
npm run repair:shopify-customers -- --verify --start=2026-09-01 --end=2026-09-30 --currency=GBP

# Read-only: rerun Shopify typed/literal populations and independently inspect
# September 2025 Woo identity, date, status, currency and duplicate cardinality.
npm run verify:september-platforms
```

The apply command retrieves only the plan's confirmed IDs in batches of 50 and
bounded retries. A null Shopify node is recorded as inaccessible/deleted and
prevents promotion; a request failure is recorded separately as failed. Guest
orders are valid rows (`is_guest=true`, null customer ID). Returned identities
and required eligibility fields are validated before any destination write.
Rows are staged by a BigQuery load job, then a transaction atomically `MERGE`s
on `order_id` and records success/watermark evidence. It never truncates,
streams, invokes `syncShopify()`, resets a watermark, or writes finance,
refunds, locations, line items, Square, or Woo tables. Existing customer names
are not queried or overwritten.

Do not report production repaired merely because code was deployed or a plan
ran. Accept only the apply result `status=succeeded`, the zero-missing verify,
and the independent comparison diagnostic. Report Shopify and Woo separately,
including coverage, metric definitions, statuses/currencies and unresolved
populations; do not manufacture accounting equivalence or migration uplift.

## Optional ongoing incremental collection (not scheduled by this change)

After the explicit repair creates a successful watermark, a manually approved
one-off incremental run is:

```sh
npm run repair:shopify-customers -- --scheduled --overlap-hours=48 --max-retries=4
```

It queries a bounded Shopify `updated_at` half-open window from the persisted
watermark minus a 48-hour overlap, uses the same load-job/transactional MERGE,
and persists actual retrieval time plus run outcome. The overlap makes delayed
updates idempotently recoverable. No Render cron or blueprint is added or
activated; operations must separately approve and configure a schedule after
observing successful one-off runs.
