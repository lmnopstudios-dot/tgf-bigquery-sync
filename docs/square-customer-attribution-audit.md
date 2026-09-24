# Square customer-attribution evidence audit

## Safe production run

The **first Render command** is exactly:

```bash
npm run diagnose:square-customer-attribution -- --project "${GOOGLE_PROJECT_ID:-gf-full-data}" --dataset square_data > /tmp/square-customer-attribution.json
```

This command reads `INFORMATION_SCHEMA`, builds one schema-aware aggregate query, and prints only
year/currency counts and sums. It submits no DDL or DML, makes no Square API call, writes no
production data, and outputs no order, payment, customer, email, phone, name, address, or reusable
person hash. Keep the artifact access-controlled nevertheless. `eligible_sales` is persisted Square
operational order evidence, in its original currency; it is not a replacement for governed
`finance.sales_master`.

On success, stdout is one JSON object with `safety`, `semantics`, `persisted_evidence`,
`annual_evidence`, and `cross_platform_link_assessment`. Each `annual_evidence` item is an
aggregate year/currency row of counts and sales, never an order or customer record. On failure the
process exits nonzero, writes no JSON to stdout (so the redirected artifact is empty rather than a
plausible success report), and writes one bounded stage/reason/code summary to stderr.

Interpret the resulting `persisted_evidence` booleans before reading coverage. `false` means only
that the evidence was not found in this BigQuery dataset. It does **not** mean Square never held the
evidence. Each `annual_evidence` row uses the latest persisted row per order ID and COMPLETE or
COMPLETED orders when a state field exists. Review `eligible_order` when no state field exists.
Counts are overlapping sets: never add order ID, payment ID, email, phone, receipt, or customer-row
coverage. The explicit overlap/agreement counts show the most important intersections.

## Evidence meanings

| Output evidence | Meaning | Attribution treatment |
|---|---|---|
| `orders_with_explicit_order_customer_id` | A nonblank customer ID is persisted directly on the order. | Direct stable Square evidence. |
| `orders_with_one_payment_customer_id` | Exactly one distinct nonblank customer ID exists across payments joined by persisted order ID. | Direct stable Square evidence unless it conflicts with the order or another payment. |
| `transaction_email_coverage` / `transaction_phone_coverage` | A contact field is persisted on the order/payment record itself. | Contact evidence only; ambiguity/shared-value checks remain unresolved. |
| `receipt_destination_coverage` | A separately named receipt-email destination is persisted. | **Never proof of purchaser identity and never used by the conservative count.** A receipt URL alone is not a destination. |
| `orders_joinable_to_customer_record` | The stable transaction customer ID joins to the separate customers table. | Customer details are enrichment available only after the ID join, not transaction-captured evidence. |
| `missing_stable_customer_id` | Neither the order nor its payments provides one unambiguous customer ID. | Absent direct customer evidence. |
| `conservatively_attributable_orders` | One stable Square customer ID is present and order/payment evidence does not conflict or contain multiple payment customer IDs. | Safe candidate for a later Square-only journey identity; no cross-platform merge is made. |

Duplicate customer rows, multiple contacts per customer, contacts shared by multiple customer IDs,
multiple payments, multiple payment customer IDs, and order/payment disagreement are counted, not
resolved. Sales and counts stay grouped by currency and calendar year. The diagnostic does not
combine coverage categories and does not treat a customer-table email or phone as if captured on
the sale.

## What this repository and Square source establish

This checkout contains Square semantic discovery and read-only retail views, but no Square API
client, endpoint constants, extraction cursor, raw-table DDL, or sync job. Therefore current
ingestion and historical extraction guarantees cannot be established here. The diagnostic uses
only exact columns it discovers; it does not manufacture an API conclusion from a guessed name.

Square's published object references separately document customer IDs on an
[Order](https://developer.squareup.com/reference/square/objects/Order), `customer_id`,
`buyer_email_address`, and `receipt_url` on a
[Payment](https://developer.squareup.com/reference/square/objects/Payment), and email/phone on a
[Customer](https://developer.squareup.com/reference/square/objects/Customer). The
[Customers API overview](https://developer.squareup.com/docs/customers-api/what-it-does) explains
that customer profiles can be created from payment-derived information. These are source
capabilities, not evidence that TGF requested, retained, or can historically retrieve those fields.
In particular, the published Payment object does not by itself label `buyer_email_address` as a
receipt destination, so the audit does not relabel it. Only an explicitly persisted receipt-email
field enters receipt-destination coverage.

Historical backfill is **unproven from this checkout**. Before claiming it is possible, locate the
owning ingestion service and record: API version; permissions; endpoint and response object;
location/time pagination; retention limits; whether Orders and Payments are both fetched; and a
small aggregate-only historical completeness run. Do not infer availability from this diagnostic's
candidate-column allow-list.

## Cross-platform assessment and recommendation

The conservative Square count is an upper bound on Square transactions eligible for a later stable
Square identity. This audit intentionally does not calculate Woo/Shopify links unless separately
governed contact evidence is demonstrated, and it emits neither matches nor hashes. A later
aggregate feasibility audit may count deterministic links only where a normalized email or phone
maps one-to-one on both sides; shared, reused, missing, and conflicting values must remain
unresolved, and receipt destination alone must be excluded.

Next, retain the native order and payment `customer_id` plus their explicit order/payment linkage
and source timestamps/statuses in the raw ingestion contract. If privacy governance approves
contact ingestion, retain each field with its exact Square source path and provenance category
(transaction contact versus separate customer profile); do not create a generic blended contact.
Add receipt destination only if its exact response field and semantics are demonstrated. Govern
access, retention, deletion propagation, uniqueness thresholds, and historical completeness before
building any Woo–Shopify–Square bridge.
