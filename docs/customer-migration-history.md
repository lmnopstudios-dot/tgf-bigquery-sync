# Woo to Shopify migration history investigation

## Demonstrated repository findings

Based on latest origin/main a57b788 (merged PR #347), fetched on 20 October
2026. These are repository findings, not assertions about warehouse contents.

* `server.js` Shopify GetOrders requests `customer.id/displayName`, `createdAt`,
  app ID/name and line `customAttributes`. `transformOrderCustomers` and
  `ensureOrderCustomersTable` persist Shopify order/customer IDs, order name,
  order creation time, guest/cancellation/financial status and source app.
  They do not persist an explicit Woo customer/store key, customer metafields,
  customer tags, or customer email. Customer recovery uses the same identity
  fields and also does not retrieve migration metafields.
* `order_line_items.custom_attributes_json` retains arbitrary line attributes.
  This is a possible persisted provenance carrier requiring inspection. A
  placeholder/missing product ID is not a historical collaboration identity.
* Metorik orders retain customer ID, order ID/name/number and original order
  creation/paid/completed timestamps; WW and USD live in separate datasets.
  Metorik customer IDs are not interchangeable with Woo customer IDs. Its
  analytics customer schema explicitly excludes names/email/notes. Names or
  email cannot silently establish certified identity.
* Knowledge seeds define Matrixify orders as Woo copies, not additional sales.
  Governed product identity and reporting-family approvals are product records,
  not customer approvals. No customer bridge mechanism was found in repository
  code; this does not prove absence of a warehouse/import-manifest bridge.
* Neither the source collector nor import totals establish whether customer-only,
  complete-order, or partial/placeholder migrations took place. Original date
  preservation, provenance, imported history completeness and customer linkage
  remain unverified until persisted evidence is read.

## Actual implementation

`oracle/customer-history.js` supplies an explicit shared evidence contract to
journey semantics and retention evidence. It separates identity, migration
provenance, transaction inclusion, prior history, follow-up and classification.
It replaces the unsupported categorical claim that no persisted key exists with
an accurate verification limitation. It does not introduce a mapping table,
activate candidates or add collection. Ambiguous customers remain source-specific.

All order/classification SQL, Matrixify exclusions, source-qualified deduplication,
original Woo dates, strictly-later purchase rules and decomposed execution remain
unchanged. The continuous observation coverage rules from PR #347 remain in force:
without certificates, mature rates are unavailable and observed repeats survive.
A customer bridge would not itself certify order collection or first-ever status.
Anonymous POS populations remain outside any company-wide claim.

A shared follow-up defect found during acceptance was fixed: explicit requests
such as “Show 180 days instead” or “Use 90-day rates” now switch the ranking window
while preserving retention scope. This is not a collaboration-question exception.

## Compact Render diagnostic

Using Render's existing identity from the checkout containing this change:

```sh
timeout 55s node diagnostics/customer-migration-history.js
```

This performs only bounded warehouse reads (45-second overall deadline,
15-second audit-query caps, 1 GB billed cap per audit query; source reads retain
existing decomposed bounds). No Shopify/Metorik collection API, backfill, persistent
write, permission change or deployment is invoked. Independent audit/source errors
survive. Output is aggregate-only, plus table/column/type metadata.

The report includes:

* Bounded schema discovery in shopify_data, metorik_uk, metorik_us,
  oracle_knowledge and commerce. A missing dataset is a failed component, not
  proof of no evidence. Extra governed datasets/manifests still require review.
* Imported order/customer totals, raw/unique order reconciliation, missing
  Shopify customer IDs, exact order-name/number candidate counts, unmatched
  references, one-to-many candidates, namespace collisions, multiple Shopify
  profiles per Woo customer, reverse conflicts and original-date agreement.
* Counts of imported product lines, missing product IDs and line attributes with
  candidate provenance keys. Keys/values and customer/order identifiers are not
  emitted. Presence of a provenance-like key is not proof of its meaning.
* Actual ordinary retention-path rows for all three sources, cohort sizes,
  verified mature denominators, observed repeats, classification/history coverage
  and independent failures, for the last three years through London yesterday.
* Unverified customer mapping coverage and cross-migration repeat count as null,
  not zero. Candidate order names/numbers are never certified customer mappings.

This diagnostic does **not** certify reference candidates, placeholder product
identities, complete migration, cross-platform first-ever status or a company-wide
ranking. A successfully matched reference may still be ambiguous or accidental.

## Missing evidence and proposed next step

Review an already retained import manifest, migration customer metafield export or
approved customer identity record with: Woo store (`ww`/`usd`), original Woo
customer and order IDs, Shopify customer and imported order IDs, original purchase
timestamp, original product IDs, import batch/provenance reference, and explicit
import scope/completion evidence. Check changes/shared addresses, duplicate Shopify
profiles, both-direction collisions, source order counts/dates/products and
placeholder lines. Email alone and fuzzy names cannot certify links.

If these fields are absent from persisted evidence, propose a separately governed
review/import of the retained migration manifest; do not activate collection.
Only verified deterministic conflict-free links could justify a future bridge.
Original Woo orders would remain transaction authority; imported copies could
support identity/history lookup only, preserving later genuine Shopify purchases.
Continuous prior/follow-up coverage needs its own evidence and certificates.

## Tests and live verification

The migration suite executes the actual candidate SQL with a small SQLite dialect
adapter over synthetic duplicate rows, WW/USD collisions, conflicting profiles,
changed/missing dates and an unmatched partial import. This verifies candidate
counts and reconciliation, not BigQuery dialect/schema or actual identity.
Transport tests cover the supplied acceptance question, ordinary 180-day follow-up,
shared evidence validation and durable polling/recovery. The persistent gate
includes this suite. Existing coverage/classification/transaction suites protect
strictly-later purchases, source-specific results and Matrixify exclusions.

The 20 October workspace live attempt failed at OAuth token acquisition:
`oauth2.googleapis.com`, HTTP 403. No warehouse schema/query/result was verified.
This is a workspace OAuth/egress access failure, not demonstrated Render failure.
No matched/unmatched customer totals or cross-migration repeat counts are claimed.
