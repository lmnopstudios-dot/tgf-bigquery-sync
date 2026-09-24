# Shopify direct shipping geography

## Source trace and contract

Shopify orders are owned in this repository: authenticated `POST /sync-shopify` calls the Shopify Admin GraphQL API, then rebuilds `shopify_data.order_locations`, `order_line_items`, `order_customers`, `order_financials`, and `order_refunds`, and rebuilds `order_shipping_geography`. It is not a Coupler feed (Coupler is used by the separate Woo path). The stable key is Shopify's GraphQL `Order.id`; `retailLocation` supplies the existing Online/POS classification, financial tables retain presentment money/refunds, and Matrixify is identified only by app ID `gid://shopify/App/1758145`. The production schedule is an external Render cron/request schedule: there is no Render blueprint, cron expression, GitHub Actions schedule, or other schedule definition in this repository, so its frequency and last-run state must be checked in Render rather than inferred from application code.

The exact existing manual invocation is:

```sh
curl --fail-with-body --request POST \
  --header "Authorization: Bearer ${SYNC_SECRET}" \
  "${SERVICE_URL%/}/sync-shopify"
```

Set `SERVICE_URL` to the deployed service origin and use its configured `SYNC_SECRET`; do not print either value. The route accepts no body. A successful response reports the fetched and written aggregate counts. This is a full-source replacement, not an incremental finance mutation: rerunning the same complete Shopify snapshot produces the same stable order/refund identities and table cardinalities. Its expected write scope is exactly the six tables named above. Matrixify representations remain in the parent tables for historical classification, but replacement cannot append duplicates, the geography rebuild excludes app ID `gid://shopify/App/1758145`, and downstream finance rules continue to exclude that ID. Do not use the geography-only command to repair stale parents.

The same order query now requests the direct, nullable `shippingAddress.countryCodeV2` and Shopify-supplied `country`. Only those two country fields are persisted in `shopify_data.order_shipping_geography`; no address, city, postcode, recipient, phone, or raw payload is stored. The table retains the raw country-code string, a validated uppercase ISO-2 value, optional Shopify-supplied readable name, provenance, and one of `valid`, `missing_address`, `missing_code`, or `invalid_code`. A merge on stable `order_id` makes address changes updates rather than new orders.

The normal `/sync-shopify` full refresh backfills this table alongside its existing full order refresh. The dedicated command supports a one-time full backfill and a daily-overlap incremental query by `updatedAt`; overlap makes boundary updates idempotent. Neither path changes finance tables or classification semantics.

## Production runbook (Render Shell)

Run this **first** (the exact first Render Shell command); it is read-only and establishes through BigQuery metadata whether the destination exists:

```sh
npm run diagnose:shopify-shipping-geography
```

The command executes only read-only, PII-free `SELECT` checks and never creates the destination. If the destination is absent, it exits successfully with `phase: "pre_backfill"` and `destination_present: false`. That report includes source order totals, the Matrixify exclusion, Online/POS expected-write counts and any direct shipping-country columns found in persisted schema metadata. Coverage, integrity and parent/sales comparisons are explicitly `not_yet_measurable`; those values are not zero and are not passed checks. If the destination exists, the command retains the full monthly coverage, cardinality, Matrixify-leakage and sales-integrity checks and returns at most one authorized order example for each EU status.

Proceed to the backfill only when the first command succeeds, its contract remains `read_only`, `aggregate_only` and `pii_free`, its source scope reconciles (`expected_write_orders = source_shopify_orders - matrixify_excluded_orders` and Online plus POS equals expected writes), and either (a) it reports the expected pre-backfill state (`phase: "pre_backfill"`, `destination_present: false`, and all three destination checks `not_yet_measurable`) or (b) an existing destination's full report is understood and a deliberate replacement backfill is intended. Stop rather than backfill if the diagnostic errors, scope does not reconcile, Matrixify is not separately excluded, or unexpected persisted direct-field evidence needs investigation.

To validate the generated SQL without reading table data, copy each named query from `diagnosticQueries()` into the BigQuery editor and use **More > Query settings > Dry run**, or run `bq query --use_legacy_sql=false --dry_run` with the query and a string `matrixify` parameter. The local test suite guards the named `STRUCT` syntax, but it is not a substitute for BigQuery's production parser when local credentials and the `bq` CLI are unavailable.

Then run the exact historical write (all orders visible to the existing Admin API token, with no date cutoff):

```sh
npm run sync:shopify-shipping-geography -- --backfill
```

The recurring incremental command fetches orders updated since the persisted maximum `order_updated_at` minus one day and merges them by `order_id`:

```sh
npm run sync:shopify-shipping-geography
```

Post-backfill, rerun:

```sh
npm run diagnose:shopify-shipping-geography
npm run validate:orders
npm run validate:report-v2-production
```

The geography diagnostic returns monthly/channel coverage statuses, eligible EU/non-EU sample counts after 20 September 2025, parent/order cardinality, Matrixify leakage, joined sales equality, latest source/sync timestamps, unmatched rows grouped by safe categories, and a bounded one-order-per-status acceptance result. The acceptance rows contain only the authorized order reference, date, channel, direct country/code, EU status and source-native finance fields—never customer or address PII. Financial state is explanatory evidence only because `/sync-shopify` has no financial-status ingestion filter. EU membership is evaluated against order date (including the UK's departure) and is never persisted as a permanent order flag.

After refreshing parents, run `npm run diagnose:shopify-shipping-geography` once and review its read-only evidence in this order: (1) `source_scope` confirms the latest eligible parent created timestamp is current (and the orphan assessment is `no_orphans`); (2) `integrity` confirms geography row count equals distinct geography orders and `orphan_rows` is zero; (3) `integrity.matrixify_rows` remains zero; (4) `parent_sales.joined_rows` equals its distinct-order count and `joined_sales` remains equal to `expected_sales`. Stop on any failure: do not delete geography rows, weaken the zero-orphan validity gate, or change finance exclusions.

## Follow-on wiring (out of scope)

Oracle order lookup should left join `shopify_data.order_shipping_geography` by exact `order_id`, project only normalized code/name/status/provenance, and enable its existing country predicate for Shopify while retaining Matrixify exclusion. Report v2 geography should add native Shopify orders joined once by `order_id`, use presentment currency and existing Online/POS classification, and join a governed date-ranged EU-membership dimension on country code plus order date. Until that wiring lands, it must continue to report Shopify geography unavailable rather than infer it from billing, currency, market, IP, or POS location.
