# Shopify direct shipping geography

## Source trace and contract

Shopify orders are owned in this repository: `POST /sync-shopify` calls the Shopify Admin GraphQL API, then rebuilds `shopify_data.order_locations`, `order_line_items`, `order_customers`, `order_financials`, and `order_refunds`. It is not a Coupler feed (Coupler is used by the separate Woo path). The stable key is Shopify's GraphQL `Order.id`; `retailLocation` supplies the existing Online/POS classification, financial tables retain presentment money/refunds, and Matrixify is identified only by app ID `gid://shopify/App/1758145`. The production schedule is the external Render cron/request schedule; no schedule definition is checked into this repository.

The same order query now requests the direct, nullable `shippingAddress.countryCodeV2` and Shopify-supplied `country`. Only those two country fields are persisted in `shopify_data.order_shipping_geography`; no address, city, postcode, recipient, phone, or raw payload is stored. The table retains the raw country-code string, a validated uppercase ISO-2 value, optional Shopify-supplied readable name, provenance, and one of `valid`, `missing_address`, `missing_code`, or `invalid_code`. A merge on stable `order_id` makes address changes updates rather than new orders.

The normal `/sync-shopify` full refresh backfills this table alongside its existing full order refresh. The dedicated command supports a one-time full backfill and a daily-overlap incremental query by `updatedAt`; overlap makes boundary updates idempotent. Neither path changes finance tables or classification semantics.

## Production runbook (Render Shell)

Run this **first**; it is read-only and will establish whether the table exists/has prior coverage after deployment:

```sh
npm run diagnose:shopify-shipping-geography
```

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

The geography diagnostic returns aggregates only: monthly/channel coverage statuses, eligible EU/non-EU sample counts after 20 September 2025, parent/order cardinality, Matrixify leakage, joined sales equality, and latest source/sync timestamps. EU membership is evaluated against order date (including the UK's departure) and is never persisted as a permanent order flag.

## Follow-on wiring (out of scope)

Oracle order lookup should left join `shopify_data.order_shipping_geography` by exact `order_id`, project only normalized code/name/status/provenance, and enable its existing country predicate for Shopify while retaining Matrixify exclusion. Report v2 geography should add native Shopify orders joined once by `order_id`, use presentment currency and existing Online/POS classification, and join a governed date-ranged EU-membership dimension on country code plus order date. Until that wiring lands, it must continue to report Shopify geography unavailable rather than infer it from billing, currency, market, IP, or POS location.
