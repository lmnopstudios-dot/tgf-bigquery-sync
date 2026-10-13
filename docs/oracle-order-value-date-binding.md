# Order-value date-scope investigation after PR #316

The reported live trace has non-null dates and 11,944 all-component snapshot
orders, but no September period orders or date-scope survivors. The demonstrated
failure is in the shared production query binding, also used by the diagnostic.
It is not evidence of absent September sales or incomplete September collection.

For the requested command, validated input is `start_date=2026-09-01` and
`end_date=2026-09-30`. The diagnostic maps start/end directly into the shared
options; the provider validates real ISO dates, ascending order and 1–366 days.
Neither path swaps or defaults these values. The production predicate is
`order_date BETWEEN DATE(@start_date) AND DATE(@end_date)`, where `order_date`
is `DATE(l.created_at,'Europe/London')`. Every trace period counter uses the
same requested parameters; UTC counters use `DATE(timestamp)`.

Previously the shared options explicitly declared DATE types while passing plain
strings. The installed @google-cloud/bigquery SDK treats DATE as a custom type,
extracts `value.value`, and therefore serializes both parameters as
`{"parameterType":{"type":"DATE"},"parameterValue":{}}`. The actual bound date
value is absent. This is reproduced without credentials using the SDK's own
query parameter builder. Null/missing bounds cannot pass BETWEEN. Earlier tests
asserted types only and the SQL fixture bypassed wire serialization.

The fix declares these plain strings STRING. The wire now contains
`{"parameterType":{"type":"STRING"},"parameterValue":{"value":"2026-09-01"}}`
and the equivalent end date. Existing SQL converts these strings to DATE.
This matches the working `createOnlineCountrySalesService` binding: its date
strings are inferred as STRING and its Shopify date predicate uses
`DATE(f.created_at)` and `order_date BETWEEN DATE(@start_date) AND DATE(@end_date)`.
That report uses financial dates in UTC, whereas order values use location dates
in London. Their eligibility and financial measures remain distinct.

The original diagnostic now exposes validated bound dates and its SQL predicate.
The additional `diagnostics/oracle-order-value-date-scope.js` accepts the same
validated --start/--end range. It submits one dry run and one read, each with a
1 GB byte ceiling and 30-second server/client timeout. It returns exactly eight
aggregate rows (raw/latest for four components), no order IDs or financial
measures. Each row compares requested literal DATE bounds, shared STRING bounds,
and correctly wrapped DATE control parameters for UTC and Europe/London. The
server echoes the bound dates and parameter types. It also counts the shared
production `scoped` CTE before eligibility filters and reports financial UTC
counts that reproduce the sales report date predicate before eligibility.

The SQL fixture now passes parameters through the real SDK before execution.
Regression coverage reproduces zero bound counts with the previous binding while
literal/DATE controls remain nonzero, and verifies the corrected production scope,
September UTC/London boundaries, null dates, all four raw/latest components,
invalid/swapped/missing bounds, and existing provider/dispatcher/delivery paths.
Fixture execution is not live GoogleSQL acceptance.

Validation: 73 focused tests passed, no failures or skips, with loopback access
for existing HTTP polling tests; `git diff --check` passed. A live probe attempt
in this workspace failed before returning any BigQuery counts. No Render shell
is attached. September date-scope reconciliation and collection completeness
remain unverified. No merge or deployment was performed.

## Render verification

Use an isolated checkout of this PR with the existing Render environment and
node_modules. Pin its commit to the SHA supplied with the PR. Run:

```sh
timeout 90s node "$oracle_probe_root/src/diagnostics/oracle-order-value-date-scope.js" --start 2026-09-01 --end 2026-09-30
timeout 300s node "$oracle_probe_root/src/diagnostics/oracle-order-values.js" --start 2026-09-01 --end 2026-09-30
```

Require both reconciliation booleans from the probe to be true. Verify echoed
start/end and types, compare each raw/latest literal, bound and DATE-control
count within each timezone, and compare latest location London counts to shared
production date-scope counts and the original trace's date_scope stage. Financial
UTC counts give the working sales predicate comparison; timezone counts may
differ at midnight. Positive reconciled counts verify the date-binding correction,
not authoritative coverage or complete sales population.
