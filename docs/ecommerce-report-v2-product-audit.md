# Ecommerce Report v2 — governed product identity

## Semantic boundary

The governed hierarchy is **canonical product → source product → source variant/option**. Product reporting uses the parent product; variant/option reporting is a separate grain. A Woo variation, a Woo selected option, a Shopify variant, or a Square variation never creates a canonical product.

Source products use `woo:<store>:<product_id>`, `shopify:shopify:<product_id>`, and `square:square:<item_id>`. Thus Woo WW and USD IDs cannot collide, and Shopify Online/POS deliberately share a namespace. Canonical references are graph component identifiers based on stable source references—not normalized titles. Every edge records method, status, and provenance.

## Base titles and mappings

A persisted catalogue title keyed by product ID is preferred when available. The currently persisted Woo evidence is historical order lines rather than a governed catalogue snapshot, so the fallback is the most frequent nonblank title for the stable product ID, with most-recent sale and then lexical title as deterministic tie-breakers. Renames and order options therefore do not fragment identity.

Normalization happens only after that consolidation: Unicode NFKC, lowercase, trim/whitespace collapse, ordinary apostrophe and dash normalization, and relevant entity decoding. It never strips materials or size-looking words. Pairwise mappings are evaluated independently for Woo WW ↔ Shopify, Woo USD ↔ Shopify, Woo WW ↔ Woo USD, and Square ↔ Shopify, in precedence order: governed edge, exact unique SKU, exact unique normalized base title. There is no fuzzy matching. A Square collision cannot invalidate a Woo/Shopify edge.

## Source findings and production audit

The known 1,875 Woo WW historical titles over 792 stable product IDs proves that historical line-title grain is finer and/or more mutable than product grain. The precise per-ID causes (rename, option rendering, or other line snapshot differences) cannot honestly be asserted without production rows. The read-only `woo_product_audit` validator now returns the highest-volume 100 multi-title/option-evidence product IDs with bounded title patterns, variation count, first/latest sale, modal governed title, line count, and aggregate option-field coverage—no order/customer PII.

Woo option discovery uses the complete persisted line struct (`TO_JSON_STRING`) and searches aggregate evidence for size, ring-size, option, attribute, and metadata keys rather than assuming a column name. This establishes whether size survives, where candidate keys occur, and coverage on the first production run. The application normalizer accepts explicit UK alpha/half-size **values** only; it does not parse product titles. Product identity remains valid if option coverage is zero. Historical size reporting is feasible only for lines whose explicit option metadata survives and normalizes; the validator must disclose the resulting incomplete coverage.

Shopify `product_id` is product identity, `variant_id`/variant title are child detail, and channel is transactional context. Square order evidence distinguishes the explicit JSON `item_id`, `catalog_object_id`, `catalog_variation_id`, item title, and variation title. The audit reports how much evidence has an explicit parent item, how much requires a catalogue parent lookup, and how much is custom/unidentified. A fallback ID remains source-specific; it must not be represented as a proven Square parent.

## Validation and reporting contract

`product_identity_previous` preserves the former line-title coverage benchmark. `product_identity` emits stable products, governed base-title coverage, unique/colliding normalized base titles, resolved/ambiguous/unmatched products, all three line percentages, and resolved-sales percentage. `pairwise_product_coverage` emits matched/ambiguous/unmatched products plus line and sales coverage for each required pair. `unresolved_products` emits only the 100 highest-volume aggregate product IDs/titles and reasons. Values are deliberately not invented in development.

Report v2 Products now aggregates units and source-native product sales by product reference, channel, currency, period, and source provenance. Variants are retained as child IDs; unresolved/source-specific products remain in rankings, so sales are not dropped. Currency remains separate. Variant/size questions use the explicit variant/option grain and disclose source and coverage.

## First production validation

Run this first on Render:

```sh
npm run validate:report-v2-production
```

Then use the aggregate output to answer the two acceptance questions. No production access was used during development.
