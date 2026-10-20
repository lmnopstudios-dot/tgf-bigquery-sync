# Exact-email customer history audit

Run from the checkout containing this change on Render with its existing warehouse
identity:

```sh
timeout --signal=TERM --kill-after=3s 100s node diagnostics/customer-email-history.js
```

No new credentials, connector, collection, backfill, inventory scan, schema change,
source mutation, scheduled job, deployment or persistent customer mapping is needed.
Default stdout is one compact aggregate JSON object. A failed component gives a
nonzero exit status and preserves independent source results. SIGINT/SIGTERM cancel
owned queries, including allocation that completes after cancellation.

The audit owns a 90-second total deadline, 20-second per-job deadline, at most 11
warehouse jobs and 200 returned aggregate rows per job. Four jobs inspect only
known customer/order table columns (at most 200 metadata rows each; no inventory
is printed). Each data statement is capped at 1 GB billed. Two conditional linked
calculations reuse the existing eight-statement temporary-table cohort plan, so
conservatively allow 25 GB total across all data statements. Temp tables are job
session data, with no persistent destination. Query/result pagination and late
cancellation use the shared boundedQuery ownership mechanism. The external timeout
allows cleanup; it does not grant extra query ownership.

## Demonstrated repository evidence

* `server.js` Metorik WW and USD customer schemas and transformations deliberately
  omit emails. Metorik order schemas/transformations retain customer IDs and
  geography but omit billing/customer email. Their absence in those tables does
  not establish absence in Woo or the warehouse.
* `server.js` direct Woo WW collector retains the original order in
  `woocommerce_uk.orders_api.raw_json`. Woo `billing.email` can therefore be
  present in already stored raw orders. The diagnostic evaluates it by original
  WW customer ID, alongside all customer/order evidence, without invoking Woo.
  Actual presence and coverage remain live questions. No corresponding USD raw
  order collector is established by this repository.
* Shopify's order collector requests customer ID/display name, and the recovery
  collector requests customer ID. Neither requests/persists customer or order
  email. `shopify_data.order_customers` alone cannot establish that no other
  customer email evidence exists. The diagnostic separately checks the known
  `customers` table for compatible customer-ID/email evidence if present.
* No normalized-email hash contract or approved Woo–Shopify customer mapping is
  established by these collectors. Product mapping approvals govern products.
  Unreviewed hashes are counted as metadata and never joined. A generic `id` or
  Metorik profile ID is not assumed to share the canonical Woo/Shopify customer-ID
  namespace. Extra or externally governed evidence remains outside this bounded
  audit; its absence is not asserted.

Supported plain-text email paths are top-level `email`, `billing_email`,
`customer_email`, nested `billing.email`
and `customer.email`, including the retained raw Woo order payload. Stored values
are normalized with trim/lowercase. Pre-normalized fields and hash fields are
reported as contract-unverified metadata and are not used as link evidence;
unknown prior alias transformations cannot be undone by normalizing again. Plus suffixes, dots and aliases are
preserved. Missing, malformed and explicit placeholder addresses do not link.
This is an explicit supported-path contract, not a search for PII in arbitrary
notes, line attributes or free text. Alternate fields need a reviewed contract.

## Population and ambiguity rules

All source/customer IDs remain private and source-qualified. Order eligibility,
original purchase timestamps, product classifications and Matrixify exclusion
come from the shared customer-journey SQL. Customer counts refer to identified eligible online customer profiles through
the observation cutoff. Eligible online orders include guests, with separate
identified and anonymous order denominators and order-email availability. Collaboration
entry coverage uses the same last-three-years-through-London-yesterday scope as
the existing retention path. Hash/source identifiers never leave warehouse SQL.

Each customer profile must have exactly one usable normalized email across all
observed customer and order evidence. Multiple usable emails, including
customer/order disagreements, exclude that profile. Every address seen on a
conflicted profile is excluded across evaluated sources, even if another evaluated profile uses it. An
address belonging to multiple profiles within any source is also excluded
across evaluated sources. Multiple sources may each contribute one profile. No arbitrary first
profile wins. Shared addresses, email changes and unknown aliases remain limits.

Source JSON includes eligible denominators, usable/missing/malformed/placeholder
and conflicting customer/order evidence, distinct usable addresses, duplicate
profiles, customer/order disagreements and collaboration coverage. Some error
buckets overlap. Distinct-address and exact-overlap counts include usable values
on conflicted profiles; unique candidate counts exclude those conflicts. Pair
results include explicit eligible-customer, unevaluable and unmatched counts.
Unmatched means one usable email with no exact usable counterpart; an ambiguous
match is separately reported. Unevaluable means no unique usable address, not
zero purchases. Candidate coverage is distinct from the conditional analytical population: its
counts report eligible source profiles, email-linked records and records with
observed eligible histories in multiple sources. Persisted customer mappings
remain zero: this diagnostic persists nothing.

A failed source is unknown. Supported independent pairs can still be evaluated;
WW is excluded from linkage when its additional raw-order evidence could not be
evaluated. `email_field_available: false` describes supported stored fields in
successfully inspected relations. It does not describe upstream email availability
or prove no alternative table exists.

## Conditional linked calculations

When an evaluated pair has unambiguous candidates, the diagnostic executes shared
email-linked cohort SQL and a separate overall baseline. The output label is
**email-linked customer records**, never verified unique people. It includes
profiles with usable unambiguous email, including unmatched profiles; their
histories remain source-specific unless another profile shares the same exact
address. The query retains original transaction namespaces and IDs and joins
email evidence before recomputing first observed history. An earlier linked
purchase can change entry date, collaboration or eligibility.

Original Woo transactions contribute once. Imported Shopify Matrixify copies
never count as second purchases; genuine later Shopify purchases do. Original
Woo lines supply historical product classifications. The second eligible purchase
must be strictly later than entry, with deterministic timestamp/platform/store/
order-ID ties. Collaboration cohorts may overlap; the independent overall
baseline counts distinct entry records rather than summing cohorts or averaging
rates. Baseline and collaboration rows span the same linked population, entry
dates, eligible sources and 90/180-day windows. Original source-specific ordinary
Oracle retention remains available through its existing execution/delivery paths.

Cross-migration repeat counts describe linked records with an observed eligible
Woo transaction followed by a genuine Shopify transaction, through the cutoff
across available history. Their explicit denominator is linked records with an
eligible Woo transaction. These are separate from cohort-window repeat counts.

Email identity does not certify complete source collection or earlier history.
This diagnostic supplies no new observation certificates. Mature denominators
and rates remain null; observed repeats and cohort counts remain useful. There
is no first-ever or complete-migration claim, no 365-day addition, and no change
to saved/chat identity evidence. The new analytical SQL is exercised by the
read-only diagnostic; ordinary Oracle chat is not silently upgraded to assert a
live bridge before warehouse evidence has been demonstrated.

## Validation and live status

The new fixture suite executes production normalization/conflict/degree/link SQL
and linked entry/second-order sequencing through a documented SQLite syntax
adapter. It covers case/whitespace, plus suffixes, missing/malformed/placeholders,
duplicate profiles, shared emails, customer/order disagreement, WW/USD ID and
transaction collisions, earlier linked entries, imported copies, strictly later
timestamp ties, partial sources, provider bounds, aggregate output and baseline
SQL. Existing retention tests cover classification ambiguity, overlapping cohorts,
complete 90/180-day calculations, incomplete observation coverage, fresh/retained
answers and direct/interactive/durable/recovery delivery. Local adapters do not
verify BigQuery dialect or deployed schema.

The 20 October 2026 workspace attempt failed with HTTP 403 before warehouse
results. No live source availability, email overlap, unique candidate counts,
linked cohorts or repeat counts have been demonstrated. This is not evidence of
a Render failure. Run the command above in Render to establish those findings;
missing evidence remains unknown and no migration spreadsheet is required first.
