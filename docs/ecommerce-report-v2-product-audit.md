# Ecommerce Report v2 — governed product identity audit

Report v2 uses persisted Woo WW, Woo USD, Shopify Online, Shopify POS, and Square POS line items. Shopify and Square have no meaningful deterministic SKU coverage, so SKU is not the primary migration bridge.

The governed hierarchy is explicit mapping, exact unique non-empty SKU, exact unique conservatively-normalized product title, then source-specific unresolved. Exact-title mapping is product-level: source variants are preserved, not treated as distinct canonical products. A normalized title must identify exactly one product in every participating platform namespace. Any collision is ambiguous and is never merged. Fuzzy similarity, embeddings, edit distance, stemming, and manual title exceptions are prohibited.

The Report query exposes product title, units, source-native sales/currency, Online/In-store, source, current/comparison rows, mapping method/status, source product ID, variant IDs, and provenance. Resolved Woo/Shopify and historical Square/Shopify products can therefore be compared across platforms; unresolved products remain useful source-specific rankings without asserting equivalence.

`npm run validate:report-v2-production` emits structured `product_identity` evidence for catalogue counts and, more importantly, resolved/source-specific/ambiguous **line-item** coverage and resolved sales by currency. This supplies the actual Woo ↔ Shopify and Square ↔ Woo/Shopify coverage after deployment without embedding production values in code.
