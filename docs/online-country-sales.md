# Governed cross-platform online country sales

Oracle routes historical country-ranking requests covering WooCommerce and
Shopify to `get_online_country_sales`. The tool reads BigQuery only, establishes
one row per source order before joining the latest direct shipping-country
evidence, excludes Matrixify Shopify representations, and ranks at most ten
countries independently inside each source-native currency. It reports the
unknown-country denominator and source coverage (including each source's first
and last eligible order date) alongside the rankings.

The metric is source-native operational order total less refunds. Woo eligibility
uses completed/processing status; Shopify uses paid, partially paid, or partially
refunded non-cancelled Online orders. Those operational systems have different
status and refund-capture semantics, so the combined ranking is directional and
must not be labelled canonical accounting revenue. No exchange rate is applied.
Native Shopify synchronized history starts on 16 November 2025; a four-year
request therefore has four-year Woo scope but only available native Shopify
history from that date.

## Production validation

The first Render command is:

```bash
npm run validate:online-country-sales-production
```

It is read-only and capped per query. It checks bounded rank/output cardinality,
source/currency coverage, unknown-country bounds, and duplicate country rows
that would indicate a multiplying join.

## Oracle acceptance exchange

1. Ask: `Rank Shopify Online Store sales by direct shipping country, separately in GBP and USD, for 24 September 2022–24 September 2026.`
2. Follow up exactly: `Include WooCommerce as well — I want this data for all online sales from the last 4 years.`
3. Accept only an answer whose resolved period remains **24 September 2022–24 September 2026**, uses WooCommerce and native Shopify, states direct shipping country and operational net sales, separates currencies, reports unknown-country and source coverage, discloses the 16 November 2025 native-Shopify history start, and explains source comparability.
4. Confirm `tools_used` contains `get_online_country_sales` and contains no ShopifyQL tool. Confirm no converted or combined-currency total appears.
