# Bounded Shopify finance refresh

This supported collector reads Shopify orders by **`updated_at`**, not creation date. Consequently a newly recorded refund or transaction on an older order is selected. The window is half-open (`start <= updatedAt < end`), every order page is consumed, and invalid/repeated cursors, page-limit exhaustion, out-of-window records, duplicate identities, and possibly truncated nested refund collections fail the run.

The collector stages `order_locations`, `order_financials`, and `order_refunds`, then uses one BigQuery transaction to replace only the selected order identities and advance the watermark. It never truncates a destination. Retrying a window is idempotent; unrelated historical identities remain. Native shop/presentment money and currencies, transaction and refund IDs/payloads, source app, and retail location are retained. Matrixify app ID `gid://shopify/App/1758145` remains recorded so the existing canonical finance exclusion continues to work; it is not reclassified.

## Deployment and incident refresh

Use the same service-account and Shopify client-credentials environment variables as the application. First deploy the committed revision normally. Preflight is read-only and inventories destination storage plus finance objects:

```bash
npm run refresh:shopify-finance -- --mode preflight --project gf-full-data
```

The exact collection for **25–30 September 2026 inclusive** uses an exclusive 1 October bound:

```bash
npm run refresh:shopify-finance -- --mode collect --start 2026-09-25T00:00:00Z --end 2026-10-01T00:00:00Z --project gf-full-data
```

Only after it reports `status: succeeded`, reconcile source and the finance projection:

```bash
npm run refresh:shopify-finance -- --mode reconcile --start 2026-09-25T00:00:00Z --end 2026-10-01T00:00:00Z --project gf-full-data
```

The preflight deliberately does not rewrite finance objects. It obtains each dataset's location from BigQuery metadata, runs the destination `TABLE_STORAGE` inventory in that region with `table_schema = @dataset`, and runs the dataset-scoped finance `TABLES` inventory in the finance dataset's own location. Every exact statement is dry-run before its read-only execution. Logical views immediately see the atomic source promotion; materialized views retain their configured refresh policy. Review the dependency inventory and reconciliation rather than issuing an unnecessary rebuild.

## Scheduling (prepare only; do not activate here)

After the explicit seed succeeds, configure the platform scheduler to run the following command at the desired cadence (for example hourly), with the existing secrets. The default two-hour overlap safely replays boundary changes. **Create the job disabled and obtain owner approval before enabling it.**

```bash
npm run refresh:shopify-finance -- --mode scheduled --overlap-minutes 120 --project gf-full-data
```

Each attempt is recorded in `shopify_data.finance_refresh_runs`, including the selected window and counts. Only promotion success updates `shopify_data.finance_refresh_state`; collection, staging, validation, or transaction failure records a failed run without advancing it.

## Explicit non-goals

The unresolved historical Square component/tax issue remains open. This command does not query or alter Square data, change Square tax, or reactivate Square collection.
