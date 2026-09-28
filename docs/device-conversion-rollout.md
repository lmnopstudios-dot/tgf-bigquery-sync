# Governed device conversion rollout

This capability keeps two different populations visibly separate. WooCommerce device evidence is GA4 `ecommercePurchases / sessions` at a reconciled date × device grain and is named **purchases per session**, not session conversion. Source detail is available only on dates where the date × device × channel × source × medium session total also reconciles. Shopify evidence is native human Online Store sessions and `sessions_that_completed_checkout / sessions`. No order count is used as a GA4 numerator.

## Production evidence gate and commands

Run this **first on Render** (a read-only, 1 GB-bounded query):

```sh
npm run diagnose:conversion-evidence
```

The governed public launch is **20 November 2025** (confirmed by Stuart): WooCommerce reporting runs through 19 November and Shopify reporting starts on 20 November. The first native order on 16 November remains source evidence, but is pre-launch and must not be described as a public-launch session. Then run the existing focused GA4 diagnostic and inspect its change points and ecommerce completeness:

```sh
npm run diagnose:ga4-shopify-transition
```

The first Shopify backfill chunk is deliberately a seven-day production pilot. It establishes whether historical `FROM sessions` accepts both dimensions, the actual returned coverage, and operational ShopifyQL cost/throttling before a broad run:

```sh
npm run backfill:shopify-conversion -- --start 2025-11-20 --end 2025-11-26 --chunk-days 7 --max-chunks 1 --max-sources 40 --timezone Europe/London
npm run validate:conversion-history -- --start 2025-11-20 --end 2025-11-26
```

Only after that pilot validates, run backfills in this order (replace dates only with the approved boundary/coverage dates and use the printed `next_command` until `complete: true`):

```sh
npm run backfill:ga4 -- --start 2022-08-18 --end 2025-11-19 --chunk-days 31 --max-chunks 3
npm run backfill:shopify-conversion -- --start 2025-11-20 --end 2026-09-27 --chunk-days 7 --max-chunks 2 --max-sources 40 --timezone Europe/London
```

These small invocations preserve the normal incremental GA4 sync, do not bypass Oracle's request/job controls, and ensure historical work cannot monopolise ShopifyQL or Render. Failed or empty dates are listed as `incomplete` and are not promoted. Writes replace a bounded date range transactionally using stable date × device × source identities. `unknown` is a real missing dimension; sources beyond the top 40 per device-day are summed into `__other__`, preserving additive funnel totals.

After each completed backfill, run:

```sh
npm run validate:ga4 -- --start 2022-08-18 --end 2025-11-19
npm run validate:conversion-history -- --start 2025-11-20 --end 2026-09-27
npm test
```

The read-only validator checks duplicate keys, missing days, impossible funnel counts, and reconciliation of device × source to device totals. Output is aggregate and missing-date examples are capped at 50. Do not claim historical coverage until it returns `REPORTABLE`. September 2026 is marked as a Shopify session-measurement era change and must not be narrated as changed customer behaviour.

## Oracle acceptance questions

Ask these exactly, then repeat questions 2 and 3 with a different pair of equal windows to confirm follow-up period retention:

1. **What was the desktop versus mobile conversion rate during the WooCommerce era?**
2. **Compare desktop and mobile conversion before and after the Shopify launch.**
3. **Break that comparison down by traffic source.**

Acceptance requires sessions, numerator, correctly named rate, native source, actual covered/expected days and missing coverage. The comparison must use equal windows, disclose Black Friday/Christmas seasonality, show Woo GA4 and Shopify-native figures side by side, and omit a percentage-point delta unless production evidence establishes comparable populations. Source results must be unavailable—not guessed—when the joint source table is incomplete.
