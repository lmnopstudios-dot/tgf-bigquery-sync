# Square retail semantic layer

## Contract

This layer is for Oracle's operational product and location analysis. Monetary values are persisted
Square transaction evidence in their original currency. They are **not** company revenue, VAT, or
ledger measures. `finance.sales_master` remains the authoritative business-wide financial source;
the installer neither reads nor modifies finance, Shopify, Metorik, or Ecommerce Report objects.

The idempotent installer discovers only enough schema metadata to render the views and then uses
`CREATE OR REPLACE VIEW`. It does not call Square or mutate source data.

| View | Grain and identity |
|---|---|
| `square_data.retail_locations` | One row per raw `location_id` observed on orders. The raw ID is the identity and is never merged by name. Persisted metadata is optional; the ID is the fallback display name. |
| `square_data.retail_orders` | One row per persisted order, identified by `order_id`. Child lines are scalar subqueries, so they cannot multiply the order. |
| `square_data.retail_order_items` | One row per persisted line, identified by `(order_id, line_item_uid)`. Transaction-time JSON supplies names, quantity, IDs, price and monetary components. Lines require no catalogue match. |
| `square_data.retail_returns` | One row per persisted return line, identified by `(containing_order_id, return_uid, return_line_uid)`. Return time remains separate from sale time. |
| `square_data.retail_payments` | One row per persisted `payment_id`, when a payments source exists. Its order link is nullable and is never repaired or required. |

`transaction_order_total_amount` and line/return amount fields retain source operational meaning;
they are deliberately labelled as operational in the order view. Currency is retained rather than
converted. `transaction_item_name`, `transaction_variation_name`, and `base_price_amount` are the
historical transaction snapshot. The first production layer deliberately includes no current
catalogue join, preventing current names or prices from rewriting history. Customers are omitted.

The returns view expects the production-discovered `orders.returns[].return_line_items[]` shape. If
production has a direct `return_line_items` column, the installer supports that shape as well. The
return timestamp falls back from the persisted return timestamp to order update/create timestamps;
consumers should treat that fallback as operational evidence, not a finance refund-posting date.

## Deploy

From the production repository root, using the same service-account configuration as the app:

```bash
npm run deploy:square-retail -- --project "${GOOGLE_PROJECT_ID:-gf-full-data}" --dataset square_data
```

## Validate

```bash
npm run validate:square-retail -- --project "${GOOGLE_PROJECT_ID:-gf-full-data}" --dataset square_data \
  > /tmp/square-retail-semantic-validation.json
```

The validator is SELECT-only. Its integrity row checks raw/semantic order, line and return counts;
order/line/return uniqueness; raw location-ID coverage; currencies; and retention of lines without
catalogue IDs. Additional result sets show orders and monthly activity by location, lines and units
by location, transaction-time product performance, returns by location/product, and coverage
bounds. Amount summaries remain grouped by currency and are validation evidence, not KPIs.

Limitations: no customer model, fuzzy identity, VAT reinterpretation, gift-card accounting,
currency conversion, current-catalogue enrichment, payment/order repair, or finance refund merge is
performed. The model does not infer whether open/cancelled states are sales; Oracle must apply an
explicit operational state filter appropriate to its question.
