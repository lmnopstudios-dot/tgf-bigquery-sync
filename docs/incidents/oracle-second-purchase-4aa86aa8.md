# Oracle second-purchase products — 4aa86aa8-f3bf-4b08-b091-a6abd8830bda

## Evidence and trace boundary

The supplied transcript requests overall second-order product popularity and
first-product → second-product journeys, across linked Woo WW, Woo USD and
Shopify. Entry is 2022-10-19 through 2026-10-19, cutoff 2026-10-19,
Europe/London, configured email_candidate_v2. It explicitly forbids substituting
a collaboration report. The exact request is retained in
`test/fixtures/oracle-second-purchase-4aa86aa8.txt`.

The attachment shows an activated combined identity population, 16 predominantly
collaboration-related product cohorts across three windows, a 48/48 truncated
first-purchase-products component, collaboration report headings, no overall
product ranking and no second-product percentage denominators. Its displayed
identity totals concern snapshot orders across all statuses; they are not the
eligible-customer or returning-customer denominators.

A bounded, read-only lookup was attempted with
`node diagnostics/oracle-analysis-incident.js 4aa86aa8-f3bf-4b08-b091-a6abd8830bda --inspect-query`.
It could not reach dataset metadata: the environment destination policy returned
403 EGRESS_FORBIDDEN. Thus persisted context, execution revision, provider job
arguments and the cause of the terminal “Analysis failed” remain unverified.
The following trace is established from the attached output and repository
mechanisms, not claimed as a recovered production execution log.

## Intent, selected scope, provider, ranking and bounds

1. **Intent:** overall products in each customer's next eligible order, and
   top entry-product journeys. The collaboration mention is a prohibition,
   not a positive collaboration population filter. The old `retentionIntent`
   sees “collaboration” plus “return customers” in the complete request;
   its broad retention branch does not model that distinction.
2. **Selected scope:** that branch sets `journey_intent=retention`, chooses
   `entry_product`, and hard-codes `entry_product_classification=collaboration`.
   `retentionDefinition` also defaults entry classification to collaboration.
   The selected operation is therefore product cohorts within collaboration
   entries, rather than unrestricted overall second-order popularity.
3. **Provider:** `answerCohortRetention` requests
   `retention_product_windows`. With `retentionPopulationScope=linked_tgf`
   the provider uses the identity-aware combined warehouse query, retaining
   transaction namespaces and sequencing linked histories before entry filters.
   The supplied answer describes that combined population. Nothing in the
   evidence establishes a need for recollection or altered identity mappings.
4. **Ranking:** the retention default is `repeat_rate_desc`, at a 90-day
   ranking window. The query selects cohorts by verified repeat-rate/count
   fields, not distinct entry customers. Its second-order product arrays are
   per cohort/window highlights, not an overall ranking. Whole-range ranking
   supplements are projected only for piece/baseline groups, not the chosen
   product-window group; the business renderer reports their absence.
5. **Row handling:** the product component gets 48 window rows; the provider
   computes `cohort_limit=floor(48/3)=16`. Combined reads have one population,
   so this allows 16 cohorts across 90/180/360 days. This is a cohort-window
   budget, not “20 products” or “20 entry products × 5 destinations”. The old
   per-cohort product payload also lacks an explicit product-share denominator.

The semantic failure is substitution of the collaboration-retention contract
for a distinct product-popularity/journey operation, compounded by incompatible
ranking and window-row limits. Increasing 48 alone would preserve the wrong
population, ranking and denominator contract. The attachment alone does not
prove which later delivery/validation failure caused the terminal failure label.

## Implemented contract

`second_purchase_products` has its own shared plan, capability, evidence proof,
provider grouping and renderer. It precedes collaboration-retention recognition.
It requires the configured active v2 order-email snapshot and combined scope;
identity fallback cannot turn this request into a source sum or collaboration
report. Existing collaboration reporting and legacy evidence stay intact.

The provider consumes the existing eligible linked orders and approved
reporting-family lines. It selects the first-observed entry after combining
histories, then the next eligible strictly later order by cutoff. It does not
filter products before sequencing. Imported Matrixify exclusions, source status,
net-positive eligibility, guest handling, ambiguous/unmatched safeguards and
snapshot integrity checks remain owned by the existing provider.

Independent limits are 20 overall second-order products, 20 first products ranked
by distinct entry customers, and five destination products per first-product
cohort. Stable identity-reference tie breaks apply. Each selection has the
primary next-order view and 90/180/360 calendar-day views; window rows do not
consume product slots. Approved identities/families determine grouping; product
titles never join identities. Ring Sizers are separately ranked using an explicit
Ring Sizer reporting label or product-type classification, without changing any
mapping or dropping their customers from population denominators.

Every row retains entry customers, observed returning customers, age-qualified
eligible/repeat counts, verified eligible/repeat counts, missing-line and unknown
product counts. Every destination carries distinct customer count, returning
customer denominator and share. Unknown attribution remains in returning counts.
An open-ended observed return rate is provisional; verified primary rates are
unavailable. Window verified rates require continuous coverage evidence and
boundaries. Product shares can sum above 100%; overlapping cohorts are not added.
Total available products disclose requested-limit truncation. Overall and
first-product sections validate independently and retain successful sections.
Recovery revalidates the same shared contract and does not repeat providers.

## Verification and limits

The regression suite uses the exact supplied request through the production
provider dependency factory and direct, interactive and durable HTTP delivery.
It verifies arguments, SQL scope/limits, 20 entry cohorts beyond the old 16-cohort
bound, explicit product shares, invalid evidence, identity readiness failure,
partial component preservation, subject switching and owned polling recovery.
The browser gate includes desktop/mobile visible tables and serialized recovery.
Existing collaboration acceptance/browser cases remain in the release gates.

Offline fixtures validate composition and contracts; they do not establish
warehouse SQL execution, deployed source availability or production counts.
No collection, mapping changes, production replay or deployment is performed.

Final local results: `npm run test:oracle:acceptance` passed all 862 tests;
`npm run test:oracle:browser` passed desktop/mobile rendering and durable refresh,
including the accepted collaboration report and this incident. The focused
product/collaboration run passed 40 tests. An earlier gate run hit the existing
5 ms customer-history publication deadline test; no publication code was changed,
and the final full run passed that test too.

The complete generated query also parsed as BigQuery SQL with SQLGlot. Its
analytical CTEs were transpiled and exercised in temporary DuckDB fixtures,
checking duplicate lines, same-product repurchases, unknown entry/product lines,
missing return lines, overlapping entry cohorts and delayed next orders.
This additional arithmetic check is not a BigQuery execution or live dry run.
Browser and SQL-check dependencies were installed only under `/tmp`; repository
runtime dependencies were unchanged.
