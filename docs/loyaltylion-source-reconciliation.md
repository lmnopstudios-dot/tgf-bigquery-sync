# Read-only Shopify source reconciliation for LoyaltyLion

The retained audit found 17,490 order rows and zero missing finance, customer-row,
channel-row, invalid-order-ID or gross fields. That is join consistency, not
proof of complete Shopify order-created coverage. This separate diagnostic
compares currently accessible Shopify orders to the retained warehouse. It never
writes to BigQuery or Shopify and never edits private coverage configuration.

## Run after review and deployment

```bash
timeout --signal=TERM --kill-after=5s 16m \
node diagnostics/loyaltylion-source-reconciliation.mjs \
  2025-11-16T00:00:00Z 2026-11-16T00:00:00Z --execute-read-only
```

These are Europe/London midnight bounds (both dates are GMT). For BST dates use
actual London midnight instants, not an assumed UTC midnight. Reuse the existing
Shopify and BigQuery connection; no LoyaltyLion API key or history plan is needed.
The app must have read_all_orders, read_orders/write_orders and customer-read
access. Missing permissions stop the audit, rather than accepting the normal
recent-order visibility as a historical population.

Aggregate progress prints from startup and every 15 seconds. The final JSON is
compact: invocation ID and observation bounds, exact population counts, monthly
field-difference counts, source/retained sorted-order-ID SHA-256 hashes, explicit
limits, review readiness and limitations. No customer data, raw IDs, query bodies,
credentials or underlying provider error messages are printed. Keep the final
JSON as the review evidence; the script does not automatically persist a manifest.

## Source strategy and limits

Read all orders created within the half-open interval, without channel, payment,
cancellation or migration filters. Keep those populations for reconciliation;
the performance report's existing eligibility rules still determine its metrics.
Require an EXACT ordersCount before and after complete cursor pagination, matching
the unique fetched count. Compare native IDs in both directions and compare
source customer links, app/channel evidence, financial status, cancellation,
original shop/presentment gross, presentment currency and shop refunds. Decimal
comparison preserves exact strings rather than converting money to floats.
Warehouse reads deduplicate latest native IDs and include source-only IDs plus
finance/customer/location orphan IDs. Customerless source orders are counted
separately and cannot establish zero repeat purchasing.

Limits are explicit and do not grow automatically:

| Bound | Value |
| --- | ---: |
| Requested interval | At most 380 elapsed days, ending no later than audit start |
| Source/retained orders | 25,000 each |
| Source page size / pages | 100 / 250 |
| GraphQL calls including retries | 320 |
| Minimum interval between calls | 250 ms |
| Retries for throttling/server failures | At most two per request |
| Source response bytes, cumulative | 64 MB |
| Invocation source clock | 15 minutes; external cap 16 minutes |
| Warehouse query | Read-only, 1 GB maximum bytes billed, 15-second job timeout |

Authentication and dataset-location metadata reads are separate from GraphQL call
counts. A terminal page, valid unique native IDs and cursors, required fields,
exact source counts and all local bounds are mandatory. A late-page failure,
interruption, warehouse failure or invalid response emits a sanitized failure;
it cannot produce a successful review result. If the population exceeds a bound,
review explicit shorter date windows. Do not sample, truncate or raise a cap.

## Review and recovery

`review_ready: true` means this bounded source/retained comparison has no detected
population/field differences or source orders updated during the read. It is
**not an automatically approved certificate**. `certified` is always false.
The two source counts can still miss equal-count substitutions; native-ID matching
and field comparison provide additional checks. These are not a transactionally
frozen source export. Orders updated during the read block review. Hard-deleted
orders unavailable from both systems cannot be reconstructed or certified.

If review_ready is false, inspect source-only/retained-only totals, missing table
rows, changed fields, monthly differences and concurrent-change counts. Investigate
and authorize any repair separately. This diagnostic never runs collectors,
backfills, lock takeovers or automatic replays. A failed read has no publication or
watermark to reconcile; repeat only explicitly after resolving its cause.

After successful review, an operator may approve only the exact supported
channel/date intervals in the existing private performance_coverage configuration,
with reviewer/time and an evidence reference to the saved result and its hashes.
Use the existing commerce audit alongside this source comparison. Do not approve
future cohort windows or lookbacks outside the reconciled interval. A cohort's
180-day before window may require an earlier independent audit. The report's
maturity and full-window gates remain unchanged. Return the output for review
before editing the private configuration; do not paste secret contents.

## Official API contract checked 16 November 2026

- https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders
- https://shopify.dev/docs/api/admin-graphql/2026-07/queries/ordersCount

ordersCount defaults to a capped count; this diagnostic explicitly uses limit:null
and requires EXACT precision. Historical order visibility requires the appropriate
access scope; no vendor bulk/export job is created. This audit does not prove
actual reward redemption or that LoyaltyLion caused purchasing changes.
