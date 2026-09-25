# Production GA4 semantic layer

GA4 property `291532339` is read through the Google Analytics Data API using `GA4_PROPERTY_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`. Native GA4 BigQuery export is unavailable. This layer persists bounded, aggregate evidence only—never client IDs, pseudo IDs, full URLs/query strings, credentials, or raw events.

## Objects and semantics

Dataset `ga4` contains partitioned tables `daily`, `acquisition`, `landing_pages`, `device_geo`, `conversion_breakdown`, and `ecommerce_funnel`, plus `tracking_eras`. `daily` and the funnel have one row per requested date. Dimensional tables have one row per daily dimension key. Landing values are paths with query strings and fragments removed.

`conversion_breakdown` keeps GA4 sessions, ecommerce purchases, and purchasers at one shared `device category × session channel × session source/medium` grain. Its conversion rate is recomputed as `SUM(ecommerce_purchases) / SUM(sessions)` for the requested slice; it must not be reconstructed by joining the separate acquisition and device/geo aggregates or by using Shopify/finance orders as the numerator.

Validation treats this table as a first-class aggregate: it checks semantic-key uniqueness, non-negative/finite metrics, a row for every active GA4 date, and exact daily reconciliation of its summed sessions and purchases to `daily.sessions` and `ecommerce_funnel.purchase`. A passing validation therefore covers the joint dimensional table rather than only the older five aggregates.

Traffic, users, engagement, acquisition, landing-page and device/geo metrics are GA4 behavioural evidence. GA4 `purchase` is **not** transaction or revenue truth. Shopify is order truth, `finance.sales_master` is money truth, Square is retail truth, and Metorik/Woo provides historical ecommerce continuity. No Shopify value is substituted into a GA4 field.

WooCommerce ecommerce evidence begins with GA4 coverage on 2022-08-18, but the exact WooCommerce → Shopify migration boundary is deliberately unresolved. Current Shopify ecommerce tracking was absent through 2026-09-06. From 2026-09-07, `view_item`, `add_to_cart`, `begin_checkout`, and `purchase` are observed, but status is `ecommerce_observed_provisional`, never reliable. Consequently missing tracking is stored as `NULL`, while an observed zero in the provisional era is `0`; mixed-era ecommerce queries fail closed and return comparability metadata.

## Production operation

The protected `POST /sync-ga4` route accepts optional JSON `start_date` and `end_date`; otherwise it refreshes the latest seven complete days. Requests are capped at 93 days and 100,000 rows/report, retry transient API failures, validate the entire range, and transactionally replace only that range. CLI equivalents:

```sh
npm run sync:ga4 -- --start 2026-09-07 --end 2026-09-13
npm run validate:ga4 -- --start 2026-09-07 --end 2026-09-13
```

Schema creation is part of sync and is idempotent. Historical work uses the bounded, resumable driver. It performs at most three 31-day chunks by default, prints a `resume_after` cursor and the exact next command, and each chunk remains an atomic range replacement. Render Shell commands are:

```sh
# WooCommerce period: replace the placeholders only with separately verified dates.
npm run backfill:ga4 -- --start <verified-woo-start> --end <verified-woo-end> --chunk-days 31 --max-chunks 3
# Resume from the last successful JSON cursor (the cursor date itself is not repeated).
npm run backfill:ga4 -- --start <verified-woo-start> --end <verified-woo-end> --resume-after <resume_after> --chunk-days 31 --max-chunks 3
# Shopify period: the launch boundary must come from a governed record, never this repository's provisional event date.
npm run backfill:ga4 -- --start <verified-shopify-start> --end <verified-shopify-end> --chunk-days 31 --max-chunks 3
npm run validate:ga4 -- --start <chunk-start> --end <chunk-end>
```

Do not substitute `2026-09-07` (the first currently observed complete event chain) or the diagnostic's November–December search window for a launch date. The governed Oracle tool `compare_device_source_conversion_around_launch` requires an explicit launch date and evidence reference. It uses only GA4 sessions and ecommerce purchases from the joint grain. Today, Shopify-native Online Store conversion is governed only at overall/time-series grain; a native joint device × traffic-source conversion source has not been established, so those cells are named as unavailable. Provisional GA4 rates may be returned as diagnostics, but are not labelled a like-for-like platform effect and Shopify orders are never divided by GA4 sessions.
