# Order-value retrieval failure and shared presentation

This change starts at main a9a0730 (merge of PR #312). It does not change
routing or Shopify eligibility, collect or backfill evidence, query inventory,
mutate sources or knowledge, change schedules, deploy, or merge.

## Demonstrated defects and remaining uncertainty

The production dependency factory binds `orderValues` to the stored Shopify
component provider. The query reads only `shopify_data` in the configured
BigQuery project (`GOOGLE_PROJECT_ID`, otherwise service-account project,
otherwise `gf-full-data`). The actual existing dataset metadata determines job
location; a creation default is not substituted. All four component joins use
Shopify/shopify/order_id in this single-shop dataset, reducing each component to
one latest deterministic snapshot before joining. Checked-in finance, customer,
and geography schemas contain the referenced columns. Deployed schemas and
population SQL acceptance have not been verified here.

Confirmed implementation defects:

- Population-query rejection discarded all useful BigQuery diagnostic fields;
  dataset-location and coverage failures lacked the same safe contract.
- Query parameters relied on SDK inference. Production and diagnostic now share
  explicit DATE, STRING and NUMERIC types. This hardens the contract; it is not
  evidence that inference caused the reported live rejection.
- Fulfilled null promises made optional, unrequested components look retrieved.
  Evidence now records `attempted` independently, and `not_requested` or
  `unavailable` where appropriate. It does not claim remote call counts from
  Promise settlement.
- The order-value answer appended metadata JSON. Shared presentation kept the
  original answer and generated another summary, date disclosure and JSON dump.
  The answer no longer appends JSON; shared details use bounded readable definition
  and coverage tables, retain unique supporting sections, and remove repeated
  summary/date blocks and raw JSON. Full typed evidence and artifacts remain
  structurally available.
- The shipping-charge wording called a sum a “subtotal,” confusing it with the
  merchandise amount. It now says partial sums of known shipping charges, with
  separate unknown-charge counts. Merchandise subtotal and hypothetical fee are
  separate financial bases.

A September read-only diagnostic was attempted in this workspace. It stopped
at dataset-location retrieval, with no HTTP status or BigQuery reason available;
no live schema, dry run or population query succeeded. The environment reports
credential/runtime readiness as unknown. This does **not** establish the cause
of the original production failure. No live order counts are claimed, and
routing is not offered as a cause.

## Sanitized failure contract

Only bounded stage, allowlisted code, HTTP 400–599 status, allowlisted BigQuery
reason, and numeric statement line/column are retained. Messages, SQL text,
parameter values, arbitrary error locations, credentials and customer records
are excluded. Recovery actions distinguish schema/SQL/typed-parameter validation,
project/table/location checks, read permissions, cancellation and read bounds.
Failures produce no numeric sections or retrieved-share claims. Successful
population with failed coverage retains calculations and discloses the failed
coverage check. Successful empty collected populations remain distinct from
retrieval failures and do not establish zero orders in the source.

The amount basis remains observed discounted presentment merchandise subtotal,
shipping excluded; tax inclusion and the actual shipping-rule basis are
unverified. Stored zero amounts and charges remain unknown because the collector
coerces absent money fields to zero. `retail_location_id IS NULL` remains a
candidate online proxy, not verified Online Store attribution. No historical
exceptions are reclassified as policy errors.

## Exact bounded read-only Render shell commands

Run these from the application checkout in a Render shell that already has the
normal reporting configuration. Run September first. These commands do not
import the server or execute any collector, write, inventory, source, knowledge,
scheduling or deployment operation.

```sh
node diagnostics/oracle-order-value-bindings.js
node diagnostics/oracle-order-values.js --start 2026-09-01 --end 2026-09-30
```

The bindings command makes zero provider calls. The retrieval diagnostic reports
its bounds, dataset metadata/location, required-schema missing/type mismatches,
the typed parameter **types only**, exact population and coverage dry-run results,
source-qualified post-reduction join row/order counts, source snapshot duplicate
counts, missing components, ambiguous zeros, coverage and aggregate calculations.
It uses the real production factory and exact SQL builders. It prints no raw
histogram groups, IDs, parameter values or exception messages. Location failure
stops before queries. Schema/dry-run errors remain separate checks; failures are
not converted into an empty population. Failed checks exit nonzero.

Bounds: 1–366 days, at most six query requests (two dry runs included), 10 MB billed
schema-query ceiling, 1 GB billed ceiling per other query, 30 seconds per check
and query, 200 schema rows, 50,000 aggregate groups (one sentinel detects overflow).
There are no retries at the diagnostic level. SDK transport retries cannot admit
late results into the bounded evidence read. Complete collection coverage remains
unverified even when all queries succeed.

## Validation

The focused regression suite covers the real dependency factory, BigQuery SDK
parameter serialization, schema mismatch detection, actual location propagation,
SQL/parameter/location-shaped errors and safe fields, missing components, genuine
empty populations, ambiguous zeros, duplicate snapshot diagnostics and join
cardinality, financial labels, coverage failure with retained calculations,
optional retrieval status, concise details, and recovery. Authenticated production
composition tests cover direct HTTP, interactive and durable implementations,
persisted failure recovery, September success, scenario follow-ups and XLSX
artifact recovery. Shared presentation and cross-subject date-continuity tests
retain product, country, customer, conversion, email and export behavior.

```sh
node --test test/oracle-order-value-retrieval.test.js test/oracle-order-values.test.js test/oracle-order-value-selection.test.js test/oracle-answer-presentation.test.js test/oracle-relative-date-continuity.test.js
node --test
```

The focused run passed all 74 tests. A first full run found obsolete raw-date
assertions in ambiguous product presentation; those now assert the single readable
date disclosure and the corrected focused suite passes. The final full suite passed 1,151 tests with 3 skipped and no failures (1,154 total).
The diagnostic/delivery check also passed all 33 tests. Mocked failures demonstrate safe propagation and behavior;
they do not prove that deployed BigQuery accepted the query or identify a live SQL
defect.
