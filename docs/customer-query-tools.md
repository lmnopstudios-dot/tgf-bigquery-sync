# Governed Customer Query Tools

## Discovered source architecture

Historical Woo evidence is split between `metorik_uk` (WW) and `metorik_us`
(USD). Their `orders.customer_id` values link stable identified customers to
orders, while `order_line_items.order_id` links products. Customer exports may
contain useful source summaries, but governed calculations deliberately derive
first/latest purchase, counts, refunds, and value from qualifying orders so the
definition is consistent across platforms. Numeric customer IDs can collide
between WW and USD and are never treated as global.

Shopify order identity and migration classification come from
`shopify_data.order_locations`; customer/order linkage and financial status come
from `shopify_data.order_customers`; source-native value/refunds come from
`order_financials`; and products come from `order_line_items`. Matrixify app ID
`gid://shopify/App/1758145` identifies migrated Woo representations. These are
not Shopify-native purchases and are excluded everywhere in the customer layer.

There is no approved deterministic cross-platform customer bridge in the
repository. Consequently WW, USD, and Shopify people remain separate even when
source IDs or hidden PII happen to match. This deliberately prefers unresolved
identity to a false merge. Canonical finance remains authoritative for company
financial totals; this layer exposes operational source-native order evidence.

## Identity, guests, and qualifying orders

`customer_ref` is `c_` plus a SHA-256 digest of platform, governed store, and
stable source customer ID. It is opaque to Oracle: the source ID is never
returned. WW, USD, and Shopify namespaces therefore cannot collide or merge.

Woo null/zero customer IDs and Shopify null/blank customer IDs are unresolved
guest identities. Their orders remain available to order/finance analysis but
are excluded from customer populations, repeat denominators, cohorts, timing,
and affinity. Guest orders are never linked using email, name, phone, address,
postcode, or other hidden PII.

A qualifying observed purchase is a distinct identified-customer order that:

* is Woo `completed` or `processing`, or Shopify `paid`, `partially_paid`, or
  `partially_refunded`;
* has positive order value remaining after source refund value;
* is not cancelled, failed, pending, zero-value, or fully refunded; and
* is not a Matrixify Shopify representation.

A repeat customer has at least two such distinct orders within their governed
source-qualified identity. “New” means the first qualifying **observed** order;
“returning” means an observed order with at least one earlier qualifying order.
Available source history may start after a person's true first-ever purchase,
so outputs must not claim lifetime acquisition.

## Tools

* `search_customers` supports platform/store, first/latest observed date ranges,
  minimum/maximum order count, repeat status, per-currency minimum/maximum
  operational lifetime order value, exact product ID, exact SKU, controlled
  title substring, direct shipping country, inactive-before date, and limit.
  It defaults to 20, caps at 100, returns the total match count, and sorts
  deterministically.
* `get_customer_history` accepts one exact `customer_ref`, returns at most 100
  qualifying orders in explicit chronological direction, and includes safe
  product/SKU and direct-country evidence.
* `get_customer_summary` returns first/latest observed purchase, active span,
  order/repeat metrics, per-currency values, products, and observed countries.
* `get_customer_metrics` provides bounded population, repeat, new/returning,
  lapsed, order, and source-native per-currency metrics for explicit dates.
* `get_customer_cohort` measures identified customers first observed in a
  cohort window who purchased again in a return window. The denominator excludes
  unresolved guests and is explicitly returned.
* `get_first_to_second_purchase_timing` returns customer count, median, average,
  p25, and p75 days for customers whose first observed order is in the range.
* `get_product_purchase_sequence` aggregates products on the next observed
  qualifying order after the first selected product order. This is association,
  not causation; it is distinct from same-order co-purchase.

Source-native lifetime order/refund values remain separated by currency. No FX
conversion is invented, and these values are not called canonical LTV or
canonical sales. Country uses `commerce.order_geography` only; unresolved
geography is not estimated and historical Woo coverage is incomplete.

## Privacy and safety contract

Tools are parameterized, read-only, explicitly projected, deterministically
ordered, and bounded. They expose no name, email, phone, street address,
postcode, city, payment information, notes, marketing content, raw JSON, or
reversible source customer ID. They do not modify customers, perform outreach,
or provide CRM actions. Oracle uses finance tools for company totals, order
tools for transaction drill-down, and customer tools for customer analytics.

No BigQuery object is created: the semantic layer is a controlled query CTE.
This avoids persisting another customer dataset or unnecessary PII.

## Validation and production acceptance

Run in the Render Shell from the deployed repository root:

```sh
npm run validate:customers
```

The validator reports source identified/guest counts, discovered safe schema
evidence, namespace collisions, Matrixify/native counts, direct geography
coverage, line-item orphans, a semantic smoke count, and static PII/read-only/
bounded checks. It emits counts and schema names, never customer PII.

Recommended acceptance prompts:

```text
/agent What percentage of customers whose first observed purchase was in 2024 purchased again in 2025? Explain the identity, guest, observed-history, and denominator limitations.
/agent Show five pseudonymous customers with at least five qualifying orders, then summarize each history without returning customer PII or combining currencies.
/agent For customers who bought SKU GFR041R, what did they most commonly buy on their next observed order? State the Matrixify exclusion and avoid causal language.
```
