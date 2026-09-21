# Ecommerce Report v2 — focused product evidence audit

This audit is intentionally limited to persisted product evidence needed by Report v2.

| Channel | Persisted evidence | Coverage / identity finding |
| --- | --- | --- |
| Historical Woo Online | Metorik `order_line_items`, queried by order date | Quantity, order count, subtotal/total, currency, Woo product/variation IDs and SKU are available. Product names are not selected by the current adapter. |
| Shopify Online | `shopify_data.order_line_items` joined to governed orders | Product/variant IDs, titles, SKU, quantities and allocated financials are persisted; Matrixify and retail classification must continue to use governed order semantics. |
| Historical Square POS | `square_semantic.retail_order_items` | Persisted product-level sales exist: transaction item/variation names, catalogue object ID, transaction SKU, quantity, amounts, currency, location and date. Returns are separately governed. |
| Current Shopify POS | `shopify_data.order_line_items` plus governed order channel/location | Persisted POS lines exist for synchronized orders and do not require a live Shopify API request. Coverage is limited by the current persisted maximum order date. |

## Cross-source governance conclusion

No governed bridge currently proves that a Woo product ID, Square catalogue object, and Shopify product/variant represent the same sellable product. SKU can be missing, reused, or changed and is therefore descriptive rather than a universal key. Report v2 must rank each source/channel separately until an explicit product identity map is approved.

The smallest remaining semantic gap is a read-only, effective-dated product identity map (source system + source product/variant identifier → canonical product identifier), with unresolved items retained. No new historical ingestion is required for Square or synchronized Shopify POS; the report query adapter and identity governance are the focused next steps.
