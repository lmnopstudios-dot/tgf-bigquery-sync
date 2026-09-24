# Square customer-attribution evidence audit

## Safe production run

The **first Render command** is exactly:

```bash
npm run diagnose:square-customer-attribution -- --project "${GOOGLE_PROJECT_ID:-gf-full-data}" --dataset square_data > /tmp/square-customer-attribution.json
```

This command reads `INFORMATION_SCHEMA`, then runs three schema-aware aggregate queries (customer
table profile, ID integrity, and annual attribution). It submits no DDL or DML, makes no Square API call, writes no
production data, and outputs no order, payment, customer, email, phone, name, address, or reusable
person hash. Keep the artifact access-controlled nevertheless. The queries use IDs internally but
emit only counts, length bounds, and broad character-shape counts. `eligible_sales` is persisted
Square operational order evidence, in its original currency and source unit; it is not a
replacement for governed `finance.sales_master`.

On success, stdout is one JSON object with `safety`, `persisted_schema`, `customer_table`,
`id_integrity`, `money_contract`, `annual_evidence`, and ownership/next-task assessments. Each `annual_evidence` item is an
aggregate year/currency row of counts and sales, never an order or customer record. On failure the
process exits nonzero, writes no JSON to stdout (so the redirected artifact is empty rather than a
plausible success report), and writes one bounded stage/reason/code summary to stderr.

Interpret `persisted_schema` and `customer_table` before reading coverage. An absent table/field or
zero rows means only that the evidence was not found in this BigQuery dataset. It does **not** mean
Square never held the evidence. Each `annual_evidence` row uses the latest persisted row per order ID and COMPLETE or
COMPLETED orders when a state field exists. Review `eligible_order` when no state field exists.
Counts are overlapping sets. The exact, trim-only, and case-fold-only match stages distinguish a
query-format problem from a genuinely absent customer namespace; none of the relaxed stages is
used to attribute an order.

## Expected production evidence

The first run should establish, without exposing an ID:

1. `customer_table.customer_rows`, the discovered stable-ID column names/types, distinct IDs, and
   duplicate rows. This distinguishes an empty/missing dimension from a broken join.
2. Exact order-to-payment agreement and exact/trim/casefold transaction-to-customer match counts,
   plus the final unmatched count. Length bounds and broad character-shape exceptions show whether
   the sources plausibly use the same representation; exact matches are the namespace proof.
3. Distinct transaction IDs, IDs used on at least two eligible orders, multi-payment IDs,
   order/payment disagreements, duplicate customer IDs, and order/payment IDs whose customer value
   changed across persisted versions.
4. The exact persisted amount/currency columns and annual currency-separated totals. Currency is
   now recovered from `total_money.currency` when it is nested rather than incorrectly requiring a
   top-level `currency` column.

The previous audit had a proven query defect: it only searched for a top-level order `currency`,
although Square's order total is a `Money` object. The corrected query reads `total_money.currency`
from persisted JSON or the paired flattened `total_money_currency`/`currency_code` field. It reads
`total_money.amount` (or its flattened amount field) from that contract. Square defines
[`Money.amount`](https://developer.squareup.com/reference/square/objects/Money) in the currency's
smallest denomination, normally the minor unit; therefore integer values must not be presented as
major-unit sales. If the selected persisted amount is not recognizably derived from Square Money,
the result labels its unit unknown rather than guessing from magnitude. Original currencies remain
separate.

## Evidence meanings

| Output evidence | Meaning | Attribution treatment |
|---|---|---|
| `orders_with_explicit_order_customer_id` | A nonblank customer ID is persisted directly on the order. | Direct stable Square evidence. |
| `orders_with_one_payment_customer_id` | Exactly one distinct nonblank customer ID exists across payments joined by persisted order ID. | Direct stable Square evidence unless it conflicts with the order or another payment. |
| `orders_joinable_to_customer_record` | The stable transaction customer ID joins to the separate customers table. | Customer details are enrichment available only after the ID join, not transaction-captured evidence. |
| `missing_stable_customer_id` | Neither the order nor its payments provides one unambiguous customer ID. | Absent direct customer evidence. |
| `conservatively_attributable_orders` | One stable Square customer ID is present and order/payment evidence does not conflict or contain multiple payment customer IDs. | Safe candidate for a later Square-only journey identity; no cross-platform merge is made. |
| `*_matches_only` | IDs match only after trimming or case folding. | Diagnostic explanation only; relaxed values are not used for attribution. |
| `*_change_over_time` / `duplicated_customer_ids` | A persisted entity key has multiple customer values, or a customer ID has repeated dimension rows. | Collision/change evidence; count and escalate rather than resolving it. |

Duplicate customer rows, multiple payment customer IDs, and order/payment disagreement are counted,
not resolved. Sales and counts stay grouped by currency and calendar year. The diagnostic does not
read or emit customer contact fields and does not use receipt destinations as purchaser identity.

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
In particular, the diagnostic does not read `buyer_email_address`, receipt destinations, or other
contact fields and therefore cannot accidentally turn them into purchaser identity.

Historical backfill is **unproven from this checkout**. Before claiming it is possible, locate the
owning ingestion service and record: API version; permissions; endpoint and response object;
location/time pagination; retention limits; whether Orders and Payments are both fetched; and a
small aggregate-only historical completeness run. Do not infer availability from this diagnostic's
candidate-column allow-list.

## Ownership conclusion and smallest next task

This repository has the read-side diagnostic and semantic views, but no Square API client, raw
table DDL, extraction cursor, or customer sync. Consequently:

* nonzero trim/casefold-only matches with missing exact matches support a read-query normalization
  fix (after confirming the owning contract); and
* an absent/empty customer table, missing customer ID field, or zero exact **and** format-only
  matches supports work in the owning ingestion service, not a journey join in this repository.

The smallest production-supported next implementation is: run the command above; if the expected
zero exact and zero format-only match result persists, locate the owning Square ingestion service
and add an aggregate Customers endpoint/table completeness check plus explicit mapping for
`Customer.id`, `Order.customer_id`, `Payment.customer_id`, and `Order.total_money`. Do not backfill
until endpoint scope, pagination, history, deletion, and retention behavior are recorded.

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
