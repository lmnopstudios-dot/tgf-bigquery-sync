# Production GA4 semantic layer

GA4 property `291532339` is read through the Google Analytics Data API using `GA4_PROPERTY_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`. Native GA4 BigQuery export is unavailable. This layer persists bounded, aggregate evidence only—never client IDs, pseudo IDs, full URLs/query strings, credentials, or raw events.

## Objects and semantics

Dataset `ga4` contains partitioned tables `daily`, `acquisition`, `landing_pages`, `device_geo`, `conversion_breakdown`, and `ecommerce_funnel`, plus `tracking_eras`. `daily` and the funnel have one row per requested date. Dimensional tables have one row per daily dimension key. Landing values are paths with query strings and fragments removed.

`conversion_breakdown` keeps GA4 sessions, ecommerce purchases, and purchasers at one shared `device category × session channel × session source/medium` grain. Its conversion rate is recomputed as `SUM(ecommerce_purchases) / SUM(sessions)` for the requested slice; it must not be reconstructed by joining the separate acquisition and device/geo aggregates or by using Shopify/finance orders as the numerator.

Traffic, users, engagement, acquisition, landing-page and device/geo metrics are GA4 behavioural evidence. GA4 `purchase` is **not** transaction or revenue truth. Shopify is order truth, `finance.sales_master` is money truth, Square is retail truth, and Metorik/Woo provides historical ecommerce continuity. No Shopify value is substituted into a GA4 field.

WooCommerce ecommerce evidence begins with GA4 coverage on 2022-08-18, but the exact WooCommerce → Shopify migration boundary is deliberately unresolved. Current Shopify ecommerce tracking was absent through 2026-09-06. From 2026-09-07, `view_item`, `add_to_cart`, `begin_checkout`, and `purchase` are observed, but status is `ecommerce_observed_provisional`, never reliable. Consequently missing tracking is stored as `NULL`, while an observed zero in the provisional era is `0`; mixed-era ecommerce queries fail closed and return comparability metadata.

## Production operation

The protected `POST /sync-ga4` route accepts optional JSON `start_date` and `end_date`; otherwise it refreshes the latest seven complete days. Requests are capped at 93 days and 100,000 rows/report, retry transient API failures, validate the entire range, and transactionally replace only that range. CLI equivalents:

```sh
npm run sync:ga4 -- --start 2026-09-07 --end 2026-09-13
npm run validate:ga4 -- --start 2026-09-07 --end 2026-09-13
```

Schema creation is part of sync and is idempotent. For controlled history from 2022-08-18, invoke `sync:ga4` in 31-day (or smaller) chunks; do not run the full backfill as a routine refresh. Query consumers should use `ga4/query.js`, which exposes traffic summary/comparison, acquisition, landing, device/geo, funnel, coverage, and metric-comparability methods with provenance, rather than unrestricted SQL. Wiring these methods into the Oracle tool registry is intentionally a later task.
