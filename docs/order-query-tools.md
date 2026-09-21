# Governed Order Query Tools

## Sources and identity

`metorik_uk.orders` and `metorik_uk.order_line_items` are the operational authority for historical UK WooCommerce orders. Woo identity is `woo` plus Metorik `order_id`; number and name remain lookup attributes. The original `woocommerce_uk.orders_api` snapshot is deliberately not queried because no additional safe field is required and it is not financial authority.

Current Shopify evidence uses `shopify_data.order_locations` for stable order ID, source/channel and retail location, `order_customers` for operational status and safe internal customer ID, `order_financials` for source-native order/refund values, and `order_line_items` for products and SKUs. Shopify identity is `shopify` plus its stable order ID. The namespaces never merge.

Matrixify's deterministic app ID (`gid://shopify/App/1758145`) classifies migrated Woo representations. They are excluded from unified Shopify search so the Metorik transaction is not counted twice. Migration evidence is classification metadata, not a second sale.

No deterministic order-level link to `finance.sales_master` is asserted. Canonical finance tools remain authoritative for business totals.

## Tools and supported filters

`search_orders` supports inclusive start/end date, platform (`woo`/`shopify`), channel (`online`/`pos`), exact order number/name, exact source order ID, exact status, currency, minimum/maximum source order total, directly observed shipping country, exact product ID, controlled product-title substring, exact SKU, exact location, refund status (`any`, `none`, `partial`, `full`), and safe internal customer ID. Human order-number input accepts deterministic `#123`, `123`, `order #123`, and `order 123` forms and compares only the exact bare/prefixed values; it never treats that value as a source order ID or performs fuzzy matching. Original source-native numbers are returned unchanged. Results default to 20, have a hard maximum of 100, and sort by date descending then platform and ID. A window count reports all matches while only the bounded sample is returned. A number shared by Woo and Shopify produces separate platform-qualified candidates.

`get_order_details` and `get_order_line_items` require an exact `{source_platform, source_order_id}` identity. Line items are capped at 100. All SQL is read-only, parameterized, explicitly projected, and never exposes raw JSON.

`get_order_history_context` performs a bounded exact-identity classification when migration evidence is explicitly requested. It can identify a Shopify row as a Matrixify/Woo representation without returning it as a second sale or claiming timestamped event history.

## Privacy, geography, and money

Outputs exclude customer names, email, phone, street/full addresses, postcode, payment credentials, notes, and raw payloads. A safe internal customer ID may filter a search but is not emitted and cannot navigate to PII.

Woo country is returned only from directly observed `metorik_uk.orders.shipping_country`, with field provenance. Missing means unresolved: billing country and inference are never substituted. Every country-filtered response warns that historical Woo coverage is incomplete. Shopify country is unavailable in the governed persisted order schema and remains null.

Money fields are named `source_order_total`, `source_discount_total`, and `source_refund_total`. They are source-native operational values in the returned currency, not canonical accounting sales. Canonical finance linkage is null unless a future deterministic bridge is governed.

## Validation

Run `npm run validate:orders` on Render. It checks source identity uniqueness, Matrixify classification counts, line linkage, direct-country coverage, PII/projection safety, read-only SQL, money labels, parameterization, bounded limits, and a dynamically sampled prefixed Woo number through both prefixed and bare lookup forms while separately verifying its source ID.
