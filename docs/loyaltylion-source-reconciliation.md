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

## Prepare the targeted repair preview (no warehouse writes)

If the reconciliation reports differences, use this explicit mode after review
and deployment. It repeats the bounded source/warehouse comparison, captures the
current affected set, and writes only exact native order IDs plus differing field
names to a private local temporary plan:

```bash
timeout --signal=TERM --kill-after=5s 16m \
node diagnostics/loyaltylion-source-reconciliation.mjs \
  2025-11-16T00:00:00Z 2026-11-16T00:00:00Z --prepare-repair-plan
```

The final aggregate JSON adds affected_orders and repair_preview with the private
file path and expiry. The plain --execute-read-only mode still creates no file.
No IDs or raw/customer payloads are printed. The plan directory is mode 0700 and
the file is mode 0600, created exclusively under a new temporary directory. The
plan expires 30 minutes after preparation and is preview_only/apply_supported:false.
This is a local file write only: no Shopify or BigQuery writes, watermark change,
collector replay, schedule change or coverage certification occurs.

The plan refuses more than 100 affected orders, duplicate/invalid IDs, inconsistent
field totals, detected concurrent source updates and stale audit results. Source
pagination/read failure prevents preparation. If there are no differences, it
creates no file. Retained-only IDs require investigation; never automatically
delete historical records merely because Shopify no longer returns them.

Send only the final aggregate JSON for review, not plan contents. A repair writer
must separately validate source freshness, expected warehouse state, concurrent
collectors and schema-safe atomic publication before any approved apply. This PR
does not enable that writer. The temporary file can disappear on deployment; in
that case regenerate a fresh preview instead of reconstructing or trusting a stale
plan. Do not copy it into the account secret or enable collection flags.

The retained population count/hash now includes only IDs actually represented in
at least one warehouse table. Source-seeded join placeholders are still checked
for missing rows but cannot inflate retained counts or make the ID hashes agree.
