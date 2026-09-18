# Historical WooCommerce geography discovery

## Repository findings

This work is discovery-only. It does not alter a schema, synchronize an order,
or persist geography.

### Metorik ingestion

The historical Metorik sync reads `GET https://app.metorik.com/api/v1/store/orders`
without a field projection and paginates the response. Consequently, the null
columns in BigQuery do **not** establish that geography was absent upstream.
`transformMetorikOrder` accepts both top-level `shipping_country` /
`shipping_state` and nested `shipping.country` / `shipping.state` (and the
equivalent billing fields). It does not retain the complete order response or
postcodes. The country columns are active mappings, not intentionally null
placeholders. The older generic discovery endpoint redacts an entire address
object, so it could not answer whether a nested country existed.

The repository establishes access to Metorik `orders`, `customers`, `products`,
and `refunds`, but contains no contract or captured response proving that the
current Metorik order-list endpoint supplies address geography. This remains a
production question. The new opt-in probe requests only three orders and emits
only order identifiers, dates, country/state, and postcode-presence booleans.

### Original WooCommerce evidence

The strongest repository evidence is the existing UK WooCommerce integration.
Production is configured for the WooCommerce `wc/v3` API, and the full-history
import requests `orders?status=any&orderby=id&order=asc`. Its `orders_api`
normalizer persists `order.id`, `order.number`, `billing.country`, and
`shipping.country`. It also persisted the complete response in `raw_json`,
which means state/postcode availability may be recoverable without another
network extraction. Raw JSON must not be printed because it can contain PII.

The repository also contains Woo US and JP credentials and refund readers, plus
Coupler-derived `woocommerce_us` and `woocommerce_jp` order tables. It does not
establish their geography schema or the continued historical reach of those API
credentials; those stores are outside the default UK diagnostic dataset list.

### BigQuery and Matrixify

The diagnostic inspects only `INFORMATION_SCHEMA.COLUMNS` and submits aggregate
`SELECT` queries for candidate tables. By default it covers `metorik_uk`,
`woocommerce_uk`, and `shopify_data`; `--datasets` can supply additional known
datasets. Candidate output records date bounds, distinct order keys, populated
country count and percentage, geography semantics, key candidates, and a small
distinct country-value sample used only to classify representation.

Repository code records Matrixify by immutable Shopify app ID
`gid://shopify/App/1758145` and documents 2,158 imports. The persisted Shopify
order, customer, financial, and line-item schemas shown in this checkout do not
retain shipping country. Therefore the migration slice is not presently a
BigQuery geography source, and the repository does not prove a deterministic
original-Woo-ID mapping. Matrixify remains bounded corroboration only.

## Provisional evidence hierarchy

1. Original Woo order `shipping.country`, first from the existing
   `woocommerce_uk.orders_api` snapshot after production coverage validation,
   then from a bounded read-only `wc/v3` request if snapshot evidence is absent.
2. Metorik order shipping geography only after its bounded probe establishes
   that the returned resource actually supplies it.
3. Shopify Matrixify shipping geography only for a deterministically matched
   overlap, never as historical coverage authority.
4. Billing or customer country only as separately labelled fallback evidence,
   never as shipping country.

The safest proposed canonical match is the numeric original Woo `order_id` to
`metorik_uk.orders.order_id`, with order number and date used as validation—not
as an unproved substitute identity. Future canonical data should retain source
value, normalized ISO alpha-2, and normalization provenance. No normalization
is performed here.

## Required production diagnostic

Run in the Render service shell, where existing read credentials are available:

```bash
npm run diagnose:woo-geography -- --project gf-full-data --datasets metorik_uk,woocommerce_uk,shopify_data --live-apis
```

This performs BigQuery metadata/aggregate reads, up to three Metorik order
reads, and one Woo order read. It performs no API write and no BigQuery DDL or
DML. Its JSON has the required discovery sections followed by a concise
conclusion. Production output is still required to supply defensible dates,
counts, percentages, representation, and join coverage; repository evidence
alone cannot manufacture those values.
