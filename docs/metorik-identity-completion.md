# Metorik-first identity completion — 20 October 2026

Status: investigation and ingestion design only. No production writes,
collection runs, activation or deployment. Based on latest main `d033d7d`,
including merged #353. This document supersedes the earlier assumption that
warehouse nonzero customer IDs necessarily represent current registered Woo users.

## Demonstrated cause in the current reader

`server.js` requests Metorik `customers` and `orders` without an email field
projection. `requestMetorikResource` accepts complete records in `data`, the
resource-named array or a top-level array. `transformMetorikCustomer` explicitly
allowlists analytics fields; its schema comment explicitly excludes emails even
when present upstream. Neither its transform nor `METORIK_CUSTOMERS_SCHEMA`
persists email or the complete raw customer JSON. `transformMetorikOrder` and
`METORIK_ORDERS_SCHEMA` similarly omit billing/customer emails and complete raw
order JSON. Retained `coupon_lines_json`, `shipping_lines_json`, `fee_lines_json`
and `tax_lines_json` are selected subobjects, not full order payloads. Line-item
`metadata_json` is not proof of a customer-email contract.

`oracle/email-linked-history.js` discovers recognized email/raw fields in existing
relations. It does not query Metorik. It groups by `customer_id`, explicitly avoids
assuming `metorik_customer_id` is a Woo ID, and excludes null/zero profiles. Thus
the writer's omission explains absent email columns in collector-managed tables;
the reader's profile model would also exclude guest customer profiles. This proves
an extraction/storage limitation, **not** that Metorik currently exposes the
original email, and not privacy restrictions, deletion or anonymization.

### Verified request contract and repository writer lineage

The probe uses the same `METORIK_UK_API_KEY` and `METORIK_US_API_KEY` environment
variables as `METORIK_STORES`, the same `https://app.metorik.com/api/v1/store/`
base, `Accept: application/json` and `Authorization: Bearer <key>`. It does not
invent a store ID, API-key query parameter or alternative authentication. Like
the historical production customer collector, it omits discovery analytical
date parameters. Both production and probe accept a top-level array, `data`
array or resource-named array. Pagination metadata precedence is `pagination`,
`meta`, then `links`. The probe now honors all three aliases, validates supplied
page metadata, and stops when pagination is absent rather than guessing another
page. Page/request/byte/deadline caps and no retries remain intentional diagnostic
differences from full production collection. Tests execute the production request
and response helpers extracted from `server.js` against the same fake transport
as the probe, without booting the credential-dependent server or sync routes.
This verifies compatibility with repository code, not live provider access.

These are traced code paths, rather than origins inferred from dataset names:

| Destination | Repository writer path | Persisted email/raw behavior |
|---|---|---|
| `metorik_uk.orders`, `metorik_us.orders` and their `order_line_items` | `/sync-metorik-{uk,us}-orders` → `syncMetorikOrders` → `fetchAllMetorikOrders` → `transformMetorikOrder` / `transformMetorikLineItems` → `safelyReplaceMetorikTables` → expiring staging tables → transactional DELETE/INSERT into `store.dataset` selected by `METORIK_STORES` | Explicit schemas and transforms omit order/customer emails and complete raw payloads. Line metadata and selected financial JSON subobjects are retained. |
| `metorik_uk.customers`, `metorik_us.customers` | `/sync-metorik-{uk,us}-customers` → `syncMetorikCustomers` → `fetchAllMetorikCustomers` → `transformMetorikCustomer` → `safelyReplaceMetorikCustomers` → staging table → transactional DELETE/INSERT | Positive Metorik ID retained separately from nullable/zero Woo ID; email and complete raw customer JSON omitted. |
| `woocommerce_uk.orders_api` | `/sync-woo-uk-orders` → `syncWooUKOrders` → native REST v3 orders with Basic auth from `WOO_UK_*` → `transformWooUKOrder` → `ensureWooUKOrdersTable` and page `table.insert` after initial TRUNCATE | Full original native response is serialized as `raw_json`; billing email can exist there even without a selected email column. This writer is separate from Metorik. |
| `commerce.order_geography` | `metorik/geography.js` CSV import → validated expiring stage and promotion | Selected shipping geography only; does not replace original Metorik orders or preserve a complete email export. |
| Other discovered tables, including any `woocommerce_us` payloads or external migration exports | No origin established by this investigation | Treat as unknown until writer/job/import provenance is verified. A matching dataset or table name is insufficient. |

None of these writer routes was called by this task. Repository writer capability
does not prove which job last populated a live table, or exclude older/manual
imports. Production job/audit provenance and schema reads remain unavailable.

## Live attempts and remaining unknowns

The bounded probe attempted WW customers/orders and USD customers/orders: four
requests, zero response bytes, all unavailable. All five warehouse schema reads
were unavailable. No actual customer payloads, retained raw values or persisted
production schemas could be inspected here. The configured proxy is unreachable;
git transport also failed. A separate Metorik transport check returned `EAI_AGAIN`
before receiving an HTTP response. GitHub connector reads work. Environment variable
presence is not proof of provider authorization. No upstream null/redacted/absent
classification is justified. Registered **and** Metorik guest-customer strata
remain untested, as do correspondence and ID semantics.

Run once on the existing authorized production executor:

```sh
timeout --signal=TERM --kill-after=3s 900s node diagnostics/metorik-email-evidence.js
```

The diagnostic has no arguments or write mode. Per store: at most three customer
pages and two order pages, ten records/page, five requests, 45 s source deadline,
2 MiB/response and 8 MiB decoded bytes, no retries, no hidden pagination, no guessed
guest filters or field projection. Explicit null, empty, omitted, malformed,
placeholder and usable fields are counted separately. Successful pages lacking
either ID stratum do not demonstrate coverage of both types: obtain the documented
Metorik filter/lookup contract before expanding the sample; never guess one.

Warehouse discovery covers `metorik_uk`, `metorik_us`, `woocommerce_uk`,
`woocommerce_us` and `commerce`. Missing dataset access is unavailable evidence,
not a finding that the relation does not exist. Each discovery has 500 columns
plus an overflow sentinel. Per dataset, at most five discovered order/customer/
raw/export/migration relations receive twenty deterministically selected retained
rows; JSON/raw subobjects are parsed in memory and only aggregate states leave.
Retained payload parsing additionally rejects over 2 MiB/row or 8 MiB/table.
Every read retains 1 GB/20 s limits. The maximum is thirty warehouse queries;
the outer timeout bounds the whole process. Unvisited tables are reported.
This is bounded discovery, not an exhaustive export inventory. In particular,
USD native raw evidence being unconfigured in #353 says nothing about retained
Metorik payloads, migration files or exports outside these datasets. Check the
existing export inventory and access-controlled object storage before concluding
absence; no such inventory/access is available in this executor. Do not print
customer values, source identifiers, provider bodies or credentials.

## ID correspondence gate

The customer collector requires a positive `metorik_customer_id`, permits a
null/zero `customer_id`, and deduplicates on the Metorik ID. These are distinct
fields, not interchangeable lookup keys. `orders.customer_id` alone has no
demonstrated relationship to a Metorik customer in the live samples available here.
For both stores and both customer types, obtain the provider's documented order
relationship and compare exact order IDs within the same store, original order
timestamp, currency and order number. Preserve duplicate/conflicting rows for
review. A coincidentally equal numeric ID is insufficient. Check native Woo orders
against the same facts before comparing their current `customer_id`. Count exact
correspondences, mismatches, ambiguous relationships and unavailable lookups.
Never look up Woo customers using a Metorik ID. Never discard a positive Metorik
customer ID because the corresponding native order now returns `customer_id=0`.
Until this gate succeeds, historical registered/guest status and explanations
such as deletion/anonymization remain unknown.

## Additive ingestion design

If usable Metorik emails are demonstrated, prepare an additive restricted evidence
relation; do not retrofit a native Woo ID into the existing order history. Its
logical key is store + original order ID + provider + source record ID + field
path + observation revision. Preserve the source-qualified Metorik customer ID,
original Woo customer ID (if verified), provider customer type, verified
relationship, original timestamps, retrieval timestamp, raw email, conservative
normalized email, evidence state and origin (API, retained raw or migration
export). A guest Metorik customer remains a Metorik customer; a billing email with
no customer relationship is an order-level email-linked record.

`customer-identity/historical-evidence.js` prepares such evidence in memory and
keeps each observation and both ID namespaces. It performs **no ingestion or
linkage publication**. Missing, placeholder and malformed incoming values cannot
erase usable history because observations are additive. Different usable values
produce a conflict and no selected address. Do not use a latest-value overwrite
to hide disagreements. Source observation revisions must participate in global
ambiguity checks, including old usable values. Repeated observations must be
deduplicated by the full evidence key before counts; source transactions continue
to deduplicate by original store/order keys, independently of evidence multiplicity.

Current `order_identity` is a latest-row shape without per-field provenance; its
collector reads native Woo, not Metorik. #353 only retains prior usable email when
an incoming raw email is null. It does **not** protect against every placeholder
or preserve two different usable revisions. Therefore full Woo enrichment remains
blocked until this additive store, schema migration, verification and reader
integration are implemented and reviewed. Do not run the old enrichment commands
and claim they incorporate this design.

Guest orders with usable billing emails can participate in a separate, explicitly
labelled **email-linked records** analysis. Email equality is a candidate analytical
link, not proof of a registered customer or person. Never synthesize customer IDs.
Require global conflict/degree checks before linking Woo evidence to Shopify and
keep registered-profile coverage separate from email-linked order coverage.
The current activation reader does not yet support this guest-order mode.

Coverage must show, per store: distinct original transactions; verified Metorik
relationships; native registered, native guest and unknown status; orders with
usable email; conflicting/placeholder/malformed/missing/unavailable evidence;
matched, unmatched, ambiguous and unevaluable profiles **and orders**. Use an
exclusive order-resolution partition so matched + unmatched + ambiguous +
unevaluable equals the original transaction denominator, with separate overlapping
evidence-quality flags. Report both counts and denominators, retain all original
transactions, and never improve the rate by dropping guests or unmatched orders.
Live matched/unmatched totals are unknown here, not zero.

## Bounded completion sequence

1. Run the read-only Metorik probe above. Resolve transport/access first; verify
   both customer strata with documented provider queries and exact ID semantics.
   Inventory and sample existing USD exports/raw evidence before any new collection.
2. Reconcile retained WW evidence with API observations. Operator findings: 56
   sampled WW orders, 52 placeholders, 54 native guests, two unavailable; five have
   retained usable evidence, two agree and three survive unavailable/unusable API.
   USD: 56 samples, 51 placeholders, 56 native guests and five usable API emails.
   These are purposive samples, not population match rates. Preserve all five WW
   retained records and all five USD usable records regardless of guest status.
3. Re-preview the exact Shopify parent gaps with the existing read-only command:

   ```sh
   timeout --signal=TERM --kill-after=3s 120s node diagnostics/customer-identity-gaps.js --source=shopify
   ```

   Operator-verified expected preview: 865 exact gaps, 688 attached relationships,
   177 explicit null customers, zero unavailable/extraction/request failures.
   A matching count alone does not pin membership: freeze the private exact ID
   set and digest before an eventual write and require exact parent membership
   and eligibility fields. Insert 688 attached and 177 explicit-null relationship
   rows only while absent; never create fake customers or update existing rows.
   There is **no existing missing-only write command** for this population on
   main #353. `shopify/customer-recovery.js` is GBP financial-gap scoped, capped at
   500, updates existing rows and advances watermarks. It cannot safely repair
   these 865 gaps. An exact missing-only writer remains a blocker; do not pass a
   larger cap to the old command. This task ran no Shopify repair.
4. After demonstrated Metorik availability/correspondence, implement and review
   additive evidence ingestion, retain provenance/conflicts, integrate separate
   guest email-linked analysis, and validate exclusive matched/unmatched coverage.
   Existing deduplication, Matrixify exclusion, original order history, currencies,
   classifications, first-observed sequencing and query/runtime budgets remain
   mandatory. No finance/source-history rewrite or transaction duplication.
5. Only a separately authorized future operation may repair, collect, freeze a
   snapshot or activate/deploy. Existing activation commands are not completion
   evidence for the unresolved Metorik/guest path.
