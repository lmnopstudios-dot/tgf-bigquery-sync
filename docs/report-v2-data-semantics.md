# Report v2 final data semantics

## Canonical finance reconciliation

All finance surfaces now consume `finance/canonical.js`, the single governed query semantic. It retains non-Shopify accountant-ledger rows (including residual Woo refunds after migration), removes legacy Shopify ledger rows, and reconstructs native Shopify evidence. Shopify sales are one row per order at the order creation date in presentment currency. Shopify refunds are one row per persisted `order_refunds.refund_id`, dated by `refund_created_at`, in the refund/order presentment currency and using the authoritative event-level `refund_total_presentment`. Component subtotals are not added to that total, avoiding double counting partial, shipping, line-item, or adjustment refunds.

Canonical refund amounts are negative. A presentation may expose their absolute magnitude only when it labels that convention. “Refund count” means persisted refund events (one Shopify refund ID, or one governed legacy refund ledger row); `distinct_refunded_orders` is separately available, so multiple partial refunds on one order do not silently change the count definition. Currencies remain separated and are never converted.

The root cause of missing Shopify USD was currency selection in the existing canonical finance materialization: Shopify rows were represented in shop currency, although `shop_currency` describes the store and not the customer's transaction currency. Report v2 now replaces the Shopify portion of `finance.accountant_transactions` with one source-native order row in `presentment_currency`, using `original_total_presentment`, plus a negative refund row using `total_refunded_presentment`. It retains non-Shopify canonical rows. It neither converts currency nor emits the order in shop currency as well.

Shopify Online is conservatively `retail_location_id IS NULL`; Shopify POS is `retail_location_id IS NOT NULL`. The deterministic Matrixify app ID remains excluded. Removing the old canonical Shopify component before adding native Shopify evidence prevents intra-Shopify duplication; the Matrixify rule prevents duplication with migrated Woo evidence. Residual Woo remains canonical finance evidence.

The production validator reports three disjoint/related labels:

* `full_period`: 1–30 November 2025;
* `campaign_window`: 27–30 November 2025;
* `outside_campaign_window`: 1–26 November 2025.

The old `november` label meant the **outside-campaign remainder**, not the full month. That explains why campaign USD could exceed the row misleadingly labelled `november`. The validator now returns native Shopify, residual canonical components, and their resulting Online total separately by currency. The already-observed campaign evidence is 880 GBP orders / 178254.69 net sales and 88 USD orders / 47640.74 net sales; the validator is the governed mechanism for returning the remaining full-period and residual-Woo values without hard-coding production results.

## Shopify shipping geography

The persisted Report v2 Shopify order, financial, customer, and line-item models used by this repository have no governed direct shipping-country field. The validator now audits `shopify_data.INFORMATION_SCHEMA.COLUMNS` for shipping/destination/address candidates and reports Shopify period coverage as `unavailable_not_persisted`, alongside valid Woo direct-shipping coverage. It does not substitute billing country, currency, Market, `/us/`, store, location, or IP.

The smallest ingestion addition is `shipping_country_code` (nullable ISO-2) on a governed order-level Shopify table, sourced specifically from `order.shippingAddress.countryCodeV2` (or the current Shopify Admin GraphQL equivalent), plus provenance such as `direct_shopify_order_shipping_address`. It must be joined by order ID, with null retained for POS/no-shipping orders. Until that exists, Report v2 accurately displays Woo geography and the explicit Shopify gap.

## Product identity

The bounded semantic layer is produced in the Report query rather than persisted as a customer/order table. Its grain is source product, with source variants retained as an array. It exposes canonical product reference/title, source platform/store/product ID/variant IDs/title/SKU, normalized title, mapping method/status, provenance, channel, currency, units, sales, and line-item counts. This is small, reproducible, and avoids persisting customer data.

Mapping precedence is:

1. explicit governed/source mapping (supported by the application identity contract when supplied);
2. exact unique non-empty normalized SKU;
3. exact unique normalized title;
4. source-specific unresolved identity.

A title or SKU resolves only when it identifies exactly one product inside each participating platform namespace and occurs in more than one namespace. Namespace collisions are `ambiguous` and never merged. Variants remain attached to the source product and do not become independent canonical products. Source-specific and ambiguous products remain reportable and rankable.

Normalization is deterministic and conservative: Unicode NFKC; safe decoding of ordinary apostrophe and dash entities; ordinary apostrophe/dash variant normalization; locale-independent lowercasing; trim; and repeated-whitespace collapse. It does not stem, remove product words/materials/sizes, fuzzy-match, embed, or special-case titles.

The production `product_identity` evidence returns catalogue and line-item measures per Woo WW, Woo USD, Shopify Online, Shopify POS, and Square POS: distinct products/titles, blanks, normalized/unique/colliding titles, exact SKU/title mapped products, ambiguous/unmatched products, resolved/source-specific/ambiguous line-item percentages, sales coverage by native currencies, and therefore Shopify and Square mapping coverage. Actual coverage is intentionally read from production by the Render validation command rather than asserted from development.

## Search Console

November 2024 is a confirmed source-coverage limitation: both the Domain and www governed properties returned no rows, and canonical evidence is unavailable. Governed Search Console coverage begins 6 May 2025. November 2025 canonical evidence is available. No further November 2024 backfill should be proposed.

User-facing wording is: “Governed Search Console coverage begins 6 May 2025, so November 2024 organic-search evidence is unavailable. November 2025 evidence remains available for current-period analysis.”

## First production validation

Run this first on Render, with its existing production service-account environment:

```sh
npm run validate:report-v2-production
```

No production access is required or permitted from development for this change.
