# Cohort provider execution and completed days

The incident question is retained unchanged in
`test/fixtures/oracle-cohort-provider-question.txt`. The supplied answer has no
request reference, so this work cannot correlate its original production calls.
No original correlation ID, production counts, classification coverage, or
warehouse error is inferred.

## Findings

| Component | Demonstrated locally on latest main | Live diagnostic in this environment |
| --- | --- | --- |
| Woo UK | Real production factory binds and invokes journey service; SDK drops plain-string DATE parameter values; generated SQL also contains unsupported `raw_orders(...) AS` / `lines(...) AS` CTE column lists | Credential exchange denied with HTTP 403 before BigQuery validation; deployed query, coverage and incident cause unverified |
| Woo US | Same DATE serialization and SQL defects; previously coupled to UK in a single Woo read, preventing independent success/failure accounting | Same independent 403 at authentication; not evidence of empty data or missing binding |
| Shopify | Same DATE serialization and CTE defects; source-isolated first projections previously relied on the removed CTE column list for column names | Same independent 403 at authentication; deployed schema and coverage unverified |
| Dates | Shared resolver applies “latest completed day” but misses “through yesterday”; exact question produces entry end and observation end 2026-10-19 | Reproduced locally at incident runtime; corrected to 2026-10-18 |
| Delivery | Catch-all erases stage and error category, labels failure as no classified cohorts, and claims retained results even when no rows exist | No original production trace available |

GoogleSQL CTE syntax is `cte_name AS (query_expression)`; PostgreSQL-style column
lists are not supported. The repair uses explicit aliases in every union branch,
including branches that become the first projection after source isolation.
This is a demonstrated query construction defect, **not** a claim that an
uncorrelated original production request returned that exact warehouse error.
An installed-SDK regression also demonstrated that supplying a string with
`types: {observation_end: 'DATE'}` produces `parameterValue.value === undefined`
in the installed @google-cloud/bigquery 8.3.1. All five journey date parameters had this shape.
The journey service now reuses `bigquery/date-parameters.js` and supplies real
BigQueryDate objects; the test intercepts the SDK's actual createJob request and
asserts the serialized DATE values, typed nulls and empty arrays. It performs no
network calls. This defect was missed by string-only fixture transports.

Local syntax/fixture inspection is not a successful BigQuery dry run.

Fetched latest `origin/main` at 19a58de and branched fresh. Inspected merged work
through #336, including retention #334, basket #333, durable #335 and named-event
#336. Connected GitHub open-PR search returned #123 (mapping diagnostics).
CLI GraphQL and REST listing were denied; the connector search is the available
open-work evidence. No merged feature branch was reused.

## Shared changes

- `oracle/customer-journey.js`: SDK-compatible BigQueryDate values via the existing date helper; valid CTE projections; validated internal store
  selector isolates UK, US and Shopify table references; existing factory forwards
  options; bounded query helper provides cancellation, deadlines and safe job IDs.
  Existing typed dates, null filter types, empty string-array types and per-query
  20 GB maximum remain intact. No speculative table/identity mapping is added.
- `oracle/cohort-retention.js`: independent source/store/group outcomes; evidence
  validation still rejects wrong stores, denominators and classifications. Results
  survive other source failures. Missing bindings, not attempted, retrieval failed,
  successful empty, unclassified populations and classified cohorts are distinct.
  Errors retain allowlisted stages/status/reason/location only. Future request
  references persist with evidence and survive recovery. No private rows, exception
  bodies, customer references or credentials are included.
- `oracle/component-outcomes.js`: terminal delivery reports executed source outcomes
  as delivered, failed or not attempted instead of conflating failure and unsupported.
- `oracle/report-natural-period.js`: completed-day qualifiers apply to shared date
  resolution; explicit date ranges precede relative windows; explicit relative
  cutoffs bind the end date. Day windows retain the requested inclusive day count.
  Sales, conversion, campaign, basket and cohort context consumers share this resolver;
  direct execution and retained durable results use the resolved dates.
- `diagnostics/oracle-cohort-providers.js`: unchanged question, real factory, separate
  store dry runs, optional bounded aggregate execution, sanitized failures/coverage.
- Acceptance suite registry, transport fixtures and desktop/mobile browser gate
  cover independent calls and the unchanged incident question.

At 2026-10-19 Europe/London the rolling-year convention remains entry start
2023-10-19; entry end and observation cutoff become 2026-10-18. The provider still
reads earlier available source history to identify first-observed entries. Runtime
`date_cutoff`, cohort dates, observation end and 90/180-day maturity are separate
fields; history lookback has no invented three-year lower bound.

## Supported capabilities and limits

Named collaboration cohorts use current governed product classifications and
approved source-product/reporting-family links. Generic “collaborations” is excluded
from ranking; conflicting names cannot manufacture named membership. The coverage
query additionally counts customers with conflicting named entry classifications
(an overlapping coverage indicator, not a new partition). Counts absent from evidence
remain unknown. Named/generic-only/unknown partition validation is preserved.

Woo UK and Woo US are independent online populations. Shopify eligibility uses
persisted `order_locations.retail_location_id` to distinguish online and in-store
orders and supports both when customer IDs and eligibility fields are present.
Inspected schema/collector contracts in `shopify/finance-refresh.js`,
`shopify/customer-recovery.js` and `server.js`; deployed compatibility remains
unverified. Combined-channel Shopify cohorts are first observed across those
channels, not separately calculated channel denominators. Square is absent from
this provider. No company-wide first-ever claim or cross-platform customer bridge
is supported. None of those capability limits explains a retrieval exception.

90/180-day mature denominators, repeat counts, requested-window ranking, overlaps,
left censoring, migration/cancellation/refund exclusions and non-causal wording are
preserved. A display-only small-sample flag marks fewer than 30 mature customers;
it does not change eligibility or establish significance.

## Bounded Render checks

Run from this branch's checkout in Render with its existing reporting identity:

```sh
timeout 110s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z
timeout 110s node diagnostics/oracle-cohort-providers.js --as-of=2026-10-19T12:00:00Z --execute
```

The first command dry runs all three independently generated, typed queries. The
second dry runs then executes aggregate-only reads, 15 seconds per operation and
90 seconds shared budget; the outer timeout bounds process lifetime including SDK
retries. Each query keeps the existing maximum billed-byte limit. Dry-run success
establishes query/schema/permission compatibility, not coverage. Execution reports
validated aggregate coverage and classified row counts, never customer/order rows.
Check `bound`, `invoked`, `sql_verified`, `state`, `stage`, `host`, HTTP status,
BigQuery reason/location and safe query reference for **each** source. Do not treat
an authentication failure as warehouse schema validation or a zero population.
Commands perform no collection, source writes, DDL, permission changes or deployment.

## Acceptance conversation (synthetic event evidence)

User: [The unchanged production question in the retained fixture.]

Oracle: Among retrieved Woo UK cohorts, Beta has the highest observed 90-day repeat
rate: 100% (2/2 mature customers; small sample). Alpha: entry customers 4; mature
90-day customers 3, repeat 1 (33.33%); mature 180-day customers 3, repeat 2 (66.67%).
Shopify results are source-specific. Entry 2023-10-19 through 2026-10-18; observation
ends 2026-10-18 Europe/London. These are first-observed associations, not proven
first-ever company-wide purchases or causal effects. Square and cross-platform
linkage are unsupported. Request reference and numeric coverage appear in details.

With all reads failing: “Cohort retrieval failed: Woo UK, Woo US, Shopify. No result
was calculated.” One details section identifies failed components and sanitized
stages. No supported-results-retained claim appears. With a single failure,
validated results from the other stores remain available. Refresh recovers saved
results without issuing provider reads again.

These example figures are fixtures, not production findings. See the validation
record below for actual checks and outstanding live verification.

## Validation record

- `npm run test:oracle:acceptance`: **520 passed**, zero failed/cancelled/skipped;
  21 central conversations and 26 registered provider/delivery suites. Direct,
  interactive and durable central conversation assertions report zero failures;
  intentional provider failures are separately asserted in the provider suite.
- `ORACLE_BROWSER_DRIVER=/opt/codex/runtimes/cua/lib/node_modules/playwright-core/index.mjs npm run test:oracle:browser`:
  passed desktop and mobile, including the unchanged production question, persisted
  results, refresh and no provider replay. Local browser acceptance is not a
  deployed browser check.
- Focused cohort/provider/incident suites: **46 passed**. Existing journey,
  production-validator, dependency-factory and relative-date suites: **34 passed**.
  These overlap the acceptance gate and must not be summed as unique tests.
- `npm run validate:oracle-tool-schemas`: validated 46 strict schemas across 61
  tools. `git diff --check` and edited module syntax checks passed.
- An intermediate SDK serialization test failed and exposed the missing DATE
  values; fixed using the existing helper. An intermediate full gate reported six
  failing subtests/parents because a fixture conversion affected campaign parameter
  assertions; confined conversion to retention and the complete rerun passed.
  Initial browser invocation could not resolve Playwright; using the installed
  driver completed the browser gate. No interrupted/skipped runs are claimed as
  successes. The full unrelated `npm test` suite was not run.
- Final independent live dry-run attempt: each source bound/invoked, SQL unverified,
  HTTP 403, host `oauth2.googleapis.com`, stage `authentication`; no warehouse query
  reference allocated. Diagnostic reference `4c9a214d-da7e-4af9-8432-f8f4db578255`
  belongs to this new diagnostic, **not the original incident**. No live aggregate
  execution, production classification coverage or deployed browser result is
  verified. Run the bounded Render checks above to establish them.
