# Square semantic discovery and proposed contract

## Status and evidence boundary

This phase is deliberately read-only. The repository contains no Square API client, Square sync
route, Square endpoint constants, or `square_data` table definitions. A repository-wide search of
the current tree finds Square only in finance-facing explanatory copy. Consequently the sync entry
points, API resources, pagination, extraction windows, write strategy, and raw table contract
**cannot be established from this checkout**. They may live in another service or in infrastructure
not committed here. This absence is itself an important finding: do not infer ingestion behaviour
from table names.

No production credentials are available in the development environment, so this document does not
claim production row counts, dates, locations, states, currencies, or relationship quality. The
diagnostic added with this document gathers that evidence without writing data or calling Square.

## Repository findings

The application initializes one BigQuery client from `GOOGLE_SERVICE_ACCOUNT_JSON`. Its runtime
sync routes in this checkout concern Shopify and WooCommerce, not Square. Oracle's finance tools
read `finance.accountant_transactions`; the accountant export describes that view as derived from
`finance.sales_master` and treats the latter as the financial source of truth.

The only persisted Square semantics stated in code are finance methodology notes:

* currencies stay in their original transaction currencies with no GBP conversion;
* sales and refunds are separate ledger rows and refunds are negative;
* UK Square VAT may be derived from VAT-inclusive taxable sales because source tax was considered
  unreliable;
* identified Square gift-card issuance is separated and excluded from taxable/ex-VAT Square sales;
* the POS migration from Square to Shopify was staggered through early 2026, while residual Square
  Wedding, Gold, and legacy activity is expected.

These are descriptions of the existing finance contract, not proof that similarly named raw Square
fields carry those meanings. In particular, a new retail model must not silently replace the VAT,
gift-card, or refund treatment in `finance.sales_master`.

## Diagnostic

`diagnostics/square-semantic-discovery.js` first reads `INFORMATION_SCHEMA`, then builds only
`SELECT`/`WITH` queries for the tables and scalar columns it actually finds. It reports:

* every table and complete top-level schema;
* row count, candidate primary ID, distinct IDs, duplicate-ID rows, timestamp bounds, and important
  identifier null counts;
* state/status, currency, tender/payment-method, and location distributions;
* counts and sums of numeric money-like fields, labelled by their persisted column names (not given
  invented business meanings);
* discovered relationship cardinalities and orphan counts for orders, lines, payments, refunds,
  catalog items/variations, customers, team members, locations, and inventory;
* monthly order/payment row counts by raw location ID and per-location date/amount coverage;
* schemas and view SQL for `finance.sales_master` and `finance.accountant_transactions`, when those
  objects are views.

Table roles, primary IDs, and relationships in the output are explicitly **candidates inferred from
names**. A missing relationship result means the expected scalar keys were not discovered; it does
not prove that the entities are unrelated. Nested/repeated fields remain visible in the schema but
are not flattened or profiled automatically.

### Exact Render production command

Run from the deployed repository root in a Render production shell. The service-account JSON used
by the application is accepted directly; Application Default Credentials also work when the JSON
variable is absent.

```bash
node diagnostics/square-semantic-discovery.js \
  --project "${GOOGLE_PROJECT_ID:-gf-full-data}" \
  --dataset square_data \
  --finance-dataset finance \
  > /tmp/square-semantic-discovery.json
```

Confirm the safety declaration and retain the full artifact:

```bash
node -e 'const r=require("/tmp/square-semantic-discovery.json"); console.log(JSON.stringify({safety:r.safety,scope:r.scope,tables:r.tables.map(t=>t.table)},null,2))'
```

The command does not invoke an ingestion endpoint, call the Square API, or execute DDL/DML.

## Questions requiring the production artifact

The following remain unanswered until the diagnostic output is reviewed:

1. Exact `square_data` inventory, physical schemas, grains, and canonical keys.
2. Earliest/latest trustworthy order, line, payment, refund, and inventory dates; sync freshness;
   gaps or suspicious monthly/location periods.
3. Duplicate and null rates, currencies, complete raw location list, persisted names, and whether
   each location has recent activity.
4. Actual states (including cancelled/open/incomplete), tender types, and whether customers or team
   members are persisted.
5. Join coverage and cardinality for every requested relationship, including whether line-item
   catalog identifiers refer to items or variations.
6. Whether transaction-time product names, variation names, SKUs, prices, categories, and discounts
   are captured on lines or require present-day catalog joins.
7. Whether partially/fully refunded orders can be identified, whether refunds post after the sale,
   and whether payment collections reconcile to order totals.
8. The exact Square sources, filters, transformations, VAT/gift-card rules, and reconciliation in
   `finance.sales_master`. If it is a physical table rather than a view, its creating pipeline must
   be located separately because BigQuery cannot recover application transformation code from it.

## Preliminary financial semantics

No formula should be approved merely because a column contains `total` or `amount`. Candidate
definitions must be selected from the production schemas and state distributions:

| Business concept | Evidence required before adoption |
|---|---|
| Gross sales | Persisted order/line gross field and its documented inclusion of tax, discounts, service charges, tips, and cancelled lines. |
| Discounts | Persisted order and/or allocated line discount fields; prove whether either double counts the other. |
| Tax, tips, service charges | Their persisted components and currency; prove whether they are included in each total. |
| Refunds | Refund entity amount and state, with refund timestamp and links to payment/order/line where available. Never assign it to original-sale month by default. |
| Net sales | Prefer an explicit persisted Square field with demonstrated meaning. Otherwise leave undefined pending an approved component formula. |
| Amount collected | Completed/successful payment amount net of payment refunds only after payment-state and refund reconciliation. It is not automatically order total or net sales. |
| Order/transaction count | Count distinct canonical order IDs under an explicit completed-state rule. Payments are a separate grain and may be multiple per order. |
| Average order value | Numerator and eligible distinct-order denominator must use the same state, period, location, and currency rules. Never average mixed currencies. |

Sale time, payment time, and refund time must remain separate. Refund reporting should support both
cash-period refunds and linkage back to the original order without rewriting the original event.
Orders and payments must be reconciled empirically; split tenders, tips, delayed payments, voids,
fees, and post-sale refunds are all possible explanations for differences, not assumptions.

## Proposed minimum semantic contract (not implemented)

All entities below preserve Square IDs as strings and original currency. Names are descriptive
candidates only; final physical names should be chosen after production evidence.

### `retail_locations`

* **Grain / ID:** one row per raw Square `location_id`; never merge or rename IDs.
* **Sources:** persisted location entity, plus observed raw IDs from facts.
* **Dimensions:** persisted name, status, timezone/address attributes if present; distinguish
  persisted metadata from inferred activity.
* **Measures:** none. First/last observed activity may be exposed as diagnostic attributes.
* **Rules:** retain unknown/unmatched location IDs rather than silently dropping them.

### `retail_orders`

* **Grain / ID:** one row per canonical Square order ID, only if diagnostics demonstrate that grain.
* **Sources:** raw orders; payments/refunds only through pre-aggregated one-row-per-order bridges.
* **Dimensions:** raw location ID, order state, currency, customer ID and team member ID when
  persisted, source/fulfilment fields, separate created/closed/updated timestamps.
* **Measures:** persisted order totals and components, each named for its source meaning; any derived
  net measure requires a versioned, approved formula.
* **Rules:** expose cancelled/open/incomplete rows with eligibility flags rather than deleting them.
  Do not count a multi-payment order more than once.
* **Refund/time semantics:** original order measures remain at the order event time. Linked refund
  aggregates are supplementary and must not obscure refund occurrence time.

### `retail_order_items`

* **Grain / ID:** one persisted order line (line ID if stable; otherwise a documented composite).
* **Sources:** raw line items, with order link; catalog enrichment must be separately labelled.
* **Dimensions:** order/location/currency, catalog item ID, variation ID, SKU, transaction-time item
  and variation names, category snapshot if actually persisted.
* **Measures:** quantity and persisted transaction-time unit/gross/discount/tax/net fields.
* **Rules:** transaction snapshots win for historical names/prices. Current catalog attributes may
  be joined only as explicitly current enrichment and must never rewrite historical truth.

### `retail_payments`

* **Grain / ID:** one Square payment ID.
* **Sources:** raw payments and tender/card details that are safe and persisted.
* **Dimensions:** order, location, customer/team IDs, payment status, tender type, card brand,
  currency, created/updated/completed timestamps.
* **Measures:** persisted payment, tip, fee, and refunded amounts where present.
* **Rules:** only an evidence-backed successful/completed state contributes to collected amount;
  exclude/flag failed, voided, pending, or unknown states. Preserve split tenders.

### `retail_refunds`

* **Grain / ID:** one Square refund ID (or demonstrated refund-line grain).
* **Sources:** raw refunds, linked to payment and order where persisted.
* **Dimensions:** order/payment/location, state, reason, currency, created/processed timestamps.
* **Measures:** persisted refund amount, with an explicit sign convention.
* **Rules:** keep pending/failed refunds visible but ineligible for settled-refund measures; report
  occurrence period independently of sale period. Partial/full classification is derived only by
  reconciliation in one currency and with compatible successful states.

### `retail_products_current`

* **Grain / ID:** separate catalog-item and variation grains are preferable; a variation must not be
  collapsed into its parent item.
* **Sources:** current persisted Square catalog entities and category links.
* **Dimensions:** raw item ID, raw variation ID, SKU, current names, category ID/name, current status.
* **Measures:** current catalog price only when available; no historical sales measure.
* **Rules:** explicitly labelled current-state enrichment. Historical reporting remains based on
  line-item snapshots.

An inventory semantic entity should be postponed until diagnostics establish whether the raw data
is a current snapshot, event ledger, periodic snapshot, or count adjustment. Those grains cannot be
safely combined. If supported later, its key must include raw catalog/variation ID, raw location ID,
and the source-effective timestamp or snapshot date.

## Risks and dangerous assumptions

* Inferring endpoint coverage or incremental/replacement semantics from warehouse tables.
* Assuming an ID candidate is unique, or that identical column names guarantee referential integrity.
* Treating orders, payments, and transactions as interchangeable grains.
* Treating order total, gross sales, net sales, or cash collected as synonyms.
* Subtracting refunds twice when a persisted payment/order net field already incorporates them.
* Dating refunds in the sale month rather than their own economic/cash event period.
* Summing currencies or minor-unit integer amounts without currency/exponent normalization evidence.
* Using current catalog names, categories, SKUs, or prices to rewrite historic sold-line attributes.
* Joining inventory at item level when stock is variation-and-location specific.
* Using display names as location identity or merging locations during the Shopify POS transition.
* Assuming source tax is finance truth despite the existing Square VAT adjustment.
* Changing `finance.sales_master` semantics during retail modeling rather than reconciling to it.
