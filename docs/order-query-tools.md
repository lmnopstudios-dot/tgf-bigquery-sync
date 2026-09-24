# Governed Order Query Tools

## Shopify direct shipping geography

`search_orders` joins `shopify_data.order_shipping_geography` to the stable Shopify
`order_id` and defensively selects one geography row per order. For an EU example,
call it with `source_platform: "shopify"`, `eu_status: "eu"`, the requested date
bounds, and `limit: 1`; repeat with `eu_status: "non_eu"`. Membership is evaluated
from the validated direct shipping ISO-2 code at the order date, so the UK is
non-EU during the Shopify period. Missing and invalid evidence is returned as an
explicit status for unfiltered lookups but cannot satisfy a country or EU filter.
Billing address, currency, market, IP, and POS location are never substitutes.

The first read-only Render validation command is:

```sh
npm run diagnose:shopify-shipping-geography
```

It checks exact-ID join coverage, one-row-per-order cardinality, Matrixify leakage,
sales preservation, and executes a bounded one-EU/one-non-EU example without
customer or address PII.

## Governed Metorik shipping geography

Historical Woo shipping geography is loaded from one-row-per-order Metorik CSV
exports into `commerce.order_geography`. Its primary key is
`source_store + source_order_id`: `ww + 169587` and `usd + 169587` are different
orders. Existing canonical datasets establish `ww -> metorik_uk.orders` and
`usd -> metorik_us.orders`, both by Metorik `order_id`. Each import loads an
invocation-owned stage and transactionally replaces only the selected store, so
a validation or load failure leaves prior production rows intact.

Required headings are discovered at runtime. Accepted equivalents are:

| Meaning | Accepted CSV headings |
| --- | --- |
| Order identity | `Order ID`, `order_id`, `id` |
| Human order number | `Order Number`, `order_number`, `number` |
| Direct shipping country | `Shipping Address Country`, `Shipping Country`, `shipping_country`, `Shipping Country Code`, `shipping_country_code` |

The minimal export is exactly `Order ID`, `Order Number`, and `Shipping Address
Country`, with one row per order. Order Date is intentionally not required in
the CSV: after identity and order-number reconciliation, the importer derives
it from the canonical `orders.order_created_at` timestamp in `metorik_uk` (WW)
or `metorik_us` (USD). A missing canonical timestamp fails before promotion.

All other columns—including names, emails, phones, streets, postcodes, cities,
notes, and raw customer/address fields—are dropped and never included in row
errors. Country values must be ISO alpha-2 or an explicit governed country-name
mapping. Blank values stay NULL/unresolved. No postcode, billing, currency,
shipping-method, customer, platform, or store inference occurs.

Observed rows use status `observed`, provenance
`direct_metorik_export_shipping_country`, and tier `direct`. Blank rows use
status/provenance `unresolved`, NULL normalized country, and tier `none`.

### Production commands (Render Shell)

CSVs are ignored by Git. Use the Render Shell file-upload control to place the
files at `/tmp/metorik-ww.csv` and `/tmp/metorik-usd.csv`. Where Render SSH is
enabled, the exact local equivalents are:

```sh
scp /local/path/metorik-ww.csv <RENDER_SSH_HOST>:/tmp/metorik-ww.csv
scp /local/path/metorik-usd.csv <RENDER_SSH_HOST>:/tmp/metorik-usd.csv
```

Then run at the deployed repository root in Render Shell:

```sh
npm run import:metorik-geography -- --store ww --file /tmp/metorik-ww.csv
npm run import:metorik-geography -- --store usd --file /tmp/metorik-usd.csv
npm run validate:metorik-geography
npm run validate:orders
rm -f /tmp/metorik-ww.csv /tmp/metorik-usd.csv
```

The importer reports direct coverage and canonical reconciliation. The
validator rejects duplicate store-qualified identities, invalid semantics,
inferred provenance, and canonical missing/extra IDs, while reporting each
store's coverage and cross-store numeric collisions.

Order search joins both Woo stores to governed geography and returns the store,
normalized country, and direct provenance. `get_geography_coverage` reports
total, observed, unresolved, and percentage for an explicit period and optional
Woo store; missing countries are never estimated.

### `/agent` acceptance prompts

```text
/agent Find order #33653. Tell me its shipping country and geography provenance, along with its existing order details and line items. Do not return customer PII.
/agent Give me five Woo orders shipped to Germany between 1 January and 31 July 2025. Use directly observed shipping-country evidence only and tell me geography coverage for that period.
/agent How many directly observed Woo orders were shipped to Germany in 2024? Tell me what percentage of Woo orders in that period have known shipping-country evidence so I understand the limitation.
```

## Sources and identity

`metorik_uk` and `metorik_us` orders/line items are the operational authorities for their respective historical WooCommerce stores. Woo identity is `woo` plus the governed `ww`/`usd` store and Metorik `order_id`; number and name remain lookup attributes. The original Woo snapshots are deliberately not queried because no additional safe field is required and they are not financial authority.

Current Shopify evidence uses `shopify_data.order_locations` for stable order ID, source/channel and retail location, `order_customers` for operational status and safe internal customer ID, `order_financials` for source-native order/refund values, and `order_line_items` for products and SKUs. Shopify identity is `shopify` plus its stable order ID. The namespaces never merge.

Matrixify's deterministic app ID (`gid://shopify/App/1758145`) classifies migrated Woo representations. They are excluded from unified Shopify search so the Metorik transaction is not counted twice. Migration evidence is classification metadata, not a second sale.

No deterministic order-level link to `finance.sales_master` is asserted. Canonical finance tools remain authoritative for business totals.

## Tools and supported filters

`search_orders` supports inclusive start/end date, platform (`woo`/`shopify`), channel (`online`/`pos`), exact order number/name, exact source order ID, exact status, currency, minimum/maximum source order total, directly observed shipping country, exact product ID, controlled product-title substring, exact SKU, exact location, refund status (`any`, `none`, `partial`, `full`), and safe internal customer ID. Human order-number input accepts deterministic `#123`, `123`, `order #123`, and `order 123` forms and compares only the exact bare/prefixed values; it never treats that value as a source order ID or performs fuzzy matching. Original source-native numbers are returned unchanged. Results default to 20, have a hard maximum of 100, and sort by date descending then platform and ID. A window count reports all matches while only the bounded sample is returned. A number shared by Woo and Shopify produces separate platform-qualified candidates.

`get_order_details` and `get_order_line_items` require an exact `{source_platform, source_store, source_order_id}` identity. Line items are capped at 100. All SQL is read-only, parameterized, explicitly projected, and never exposes raw JSON.

`get_order_history_context` performs a bounded exact-identity classification when migration evidence is explicitly requested. It can identify a Shopify row as a Matrixify/Woo representation without returning it as a second sale or claiming timestamped event history.

## Privacy, geography, and money

Outputs exclude customer names, email, phone, street/full addresses, postcode, payment credentials, notes, and raw payloads. A safe internal customer ID may filter a search but is not emitted and cannot navigate to PII.

Woo country is returned only from directly observed `commerce.order_geography.shipping_country_iso2`, with Metorik-export provenance and a store-qualified join. Missing means unresolved: billing country and inference are never substituted. Every country-filtered response warns that historical Woo coverage is incomplete. Shopify country is unavailable in the governed persisted order schema and remains null.

Money fields are named `source_order_total`, `source_discount_total`, and `source_refund_total`. They are source-native operational values in the returned currency, not canonical accounting sales. Canonical finance linkage is null unless a future deterministic bridge is governed.

## Validation

Run `npm run validate:orders` on Render. It checks source identity uniqueness, Matrixify classification counts, line linkage, direct-country coverage, PII/projection safety, read-only SQL, money labels, parameterization, bounded limits, and a dynamically sampled prefixed Woo number through both prefixed and bare lookup forms while separately verifying its source ID.
