# Order-value empty population investigation

Base: latest origin/main d5671d2037f1e6156937d5f7688ef89bb9d7bdd0,
merged PR #314, also the supplied live Render revision.

## Demonstrated findings and limits

The supplied September run succeeds at bindings, US dataset metadata, schema,
SQL dry runs and query execution. Its `scoped` join has zero rows, and coverage
has zero represented location orders. This locates the loss at latest
`order_locations` snapshots and their London creation-date filter, before any
eligibility predicate. LEFT JOINs cannot remove the location anchor. Later
country/currency/status/online/Matrixify/cancellation exclusions cannot explain
zero anchor rows. The old reported date/collection ranges only described scoped
rows: null ranges there do not establish empty base tables.

There is insufficient live evidence to choose among empty location storage,
missing/null location creation dates, dates outside September, or snapshot date
changes. Nor does the supplied run establish a gap in financials, status or
geography. Do not describe September sales as zero or name a missing component
without the new raw/latest component aggregates. Local live execution stopped
at `dataset_location`, HTTP 403, with no allowlisted BigQuery reason; no SQL ran.
BigQuery dry-run acceptance of the new trace remains pending Render execution.

The calculation defect is reproduced: an empty input formerly accumulated zero
shipping charges and hypothetical fees and returned `charge_total_complete:true`
without population verification. Empty unknown coverage now yields null financial
effects, false charge completeness, explicit unverified population status, and
unavailable presentation without scenario tables or zero charts. Retrieved count
zeros remain counts of retrieved evidence. A verified empty eligible population
requires both `complete:true` and `population_complete:'verified'`; the production
stored-component provider deliberately never asserts that reconciliation.
Known charges with zero affected orders do not establish overall evidence
completeness. Unknown observed values also prevent charge-total completeness.

A second demonstrated shared coverage defect counted a NULL financial status as
neither eligible nor excluded. The shared coverage query now counts NULL statuses
as exclusions. This does not admit additional orders.

## Population trace and provider audit

1. Scan `shopify_data.order_locations`, `order_financials`, `order_customers` and
   `order_shipping_geography` in the selected project. Raw diagnostics count rows,
   distinct order IDs, business-date nulls/ranges, collection timestamp
   nulls/ranges and September rows/orders before snapshots or joins.
2. Select one snapshot per `order_id` over all collected history. Locations and
   finance order by `updated_at DESC,synced_at DESC`; status and geography order
   by `synced_at DESC`. All use explicit governed scalar STRUCT tie-breaks.
   Repeat component aggregates on latest snapshots. Report raw September location
   IDs that disappear from September after snapshot selection.
3. LEFT JOIN latest finance, status and geography to latest locations by
   `order_id`. Report intersections for all latest IDs, IDs whose own component
   dates fall in September, and candidate IDs dated September in any component.
   Report matches on the location-anchored period, unscoped matches, timestamp
   disagreements and financial September dates outside location September scope.
4. Apply `DATE(order_locations.created_at,'Europe/London') BETWEEN start AND end`,
   inclusive. `created_at` is a TIMESTAMP; September uses British Summer Time.
   Null dates do not pass. Neither collection/update timestamps nor another
   component's date supplies a fallback. Components use `created_at` for finance
   and `order_created_at` for status/geography. UTC counts and UTC/London day
   differences reveal boundary effects.
5. Report successive counts after financial match, status match, geography match,
   valid direct geography, requested country, presentment currency, NULL retail
   location, non-Matrixify app, no status/finance cancellation, and paid,
   partially_paid or partially_refunded status. Three-valued unknown predicate
   counts are separate. The histogram, coverage, join diagnostic and trace share
   the same snapshot/population builder and predicate list.
6. Aggregate eligible observed subtotal/total and charges. Stored monetary zeros
   remain ambiguous; neither eligibility nor monetary evidence is relaxed.

The binding diagnostic now exposes the actual factory project/dataset and
compares the server's injected working country-sales project with the diagnostic
factory project, including their different default rules. In this workspace all
resolve to `gf-full-data`; the supplied live schema run uses
`gf-full-data.shopify_data`. That establishes no observed binding mismatch here.
Country sales uses `order_financials.created_at` with BigQuery's default UTC date,
not the order-value location-date anchor. Working Shopify sales KPIs use
ShopifyQL `FROM sales`, shop calendar timezone/currency, and positive Online Store
attribution; they have no BigQuery project/dataset. Different dates, populations
and currencies mean those sales do not reconcile this distribution's coverage.
No evidence supports changing the order-value date anchor or another provider's
existing reporting semantics merely to produce September rows.

The trace's `cause_assessment.absent_period_components` names each component
whose latest snapshots have no business-dated orders in the requested period,
with exact period, date field, raw/latest ranges and null counts in the trace.
It localizes observed coverage loss rather than certifying complete source sales.

## Bounds and exact read-only Render commands

Bindings makes zero provider calls. The September diagnostic uses at most eight
query submissions including three dry runs: schema inspection, histogram and
coverage dry runs, trace dry run/read, join read, histogram and coverage reads.
Schema: 100 MiB ceiling, 200 rows. Data queries: 1,000,000,000-byte ceiling each;
30-second per-call bounds, histogram limit 50,001 with >50,000 rejected; trace one
row with eight component aggregates, three seven-element intersection arrays,
and eleven filter stages. All-history aggregate scans are intentional so absent
September data does not hide actual collection/date ranges. If a query exceeds
its ceiling it fails; no limit is automatically increased.

Run in Render's existing `~/project/src` shell. To use this PR's diagnostics
without changing the deployed checkout, use a temporary read-only source clone
and its existing dependencies (requires the shell's existing repository read
access). This writes only temporary diagnostic code, never production data:

```sh
oracle_live_src="$PWD"
oracle_diag_root="$(mktemp -d /tmp/oracle-order-value.XXXXXX)"
git clone --depth 1 --single-branch --branch fix/oracle-empty-population https://github.com/lmnopstudios-dot/tgf-bigquery-sync.git "$oracle_diag_root/src"
ln -s "$oracle_live_src/node_modules" "$oracle_diag_root/src/node_modules"
git -C "$oracle_diag_root/src" rev-parse HEAD
node "$oracle_diag_root/src/diagnostics/oracle-order-value-bindings.js"
node "$oracle_diag_root/src/diagnostics/oracle-order-values.js" --start 2026-09-01 --end 2026-09-30
```

The printed source commit should match this PR's head. `RENDER_GIT_COMMIT` in the
binding output still identifies the deployed service. No collection, backfill,
inventory, knowledge/source-data mutation, schedules, deployment or merge is
performed by either diagnostic. No collector or server entry point is imported.

## Validation

The new production-shaped SQL fixture tests execute the generated SQL through the
real provider factory and shared dispatcher, rather than returning precomputed
histograms. A test-only SQLite adapter handles the used SQL subset and London
TIMESTAMP conversion. It is not BigQuery SQL acceptance; native SQL-fixture tests
require Node's SQLite support (Node 22+), while source runtime retains Node >=20.
Other calculation/binding tests run on older supported Node versions.

Coverage includes London month boundaries, NULL dates, every missing component,
disjoint order IDs, own-date versus candidate intersections, snapshot date loss,
every cumulative predicate, unknown statuses, empty coverage failure, verified
versus unverified emptiness, monetary calculations, and persisted evidence
validation. Additional empty-result regressions cover direct delivery, presentation
recovery without provider replay, lease-owned worker persistence, authenticated
polling, browser polling recovery and XLSX null financial effects. Existing
scenario, product enrichment, cross-subject conversation, selection and delivery
regressions are retained.

Actual validation in this workspace:

- `npm test`: 1,168 tests; 1,165 passed, 3 skipped, zero failed/cancelled (exit 0).
- Final focused tests for population, retrieval, scenarios and delivery: 56 passed,
  zero failed/skipped. These include the final date-gap classification regression.
- `node diagnostics/oracle-order-value-bindings.js`: exit 0; zero provider calls;
  all projects gf-full-data, expected shared route and follow-ups.
- Live September diagnostic: exit 1 at dataset metadata HTTP 403; no SQL ran.
- `git diff --check`: passed.

A component's own-date September gap is reported separately from its required
ID matches on location-dated September orders. Such a date disagreement can
coexist with an eligible population; it is not automatically a missing join or
an explanation for an empty result.
