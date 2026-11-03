# Finish Square coverage review

The 30 October 2026 acceptance run passed all three report shapes and billed
1,470,103,552 bytes. The saved terminal attachment begins inside the final
collaboration report and omits population and coverage sections. It cannot
establish missing counts. Prior identity-preview figures remain historical
preview evidence, not refreshed coverage or a certified retail population.

BigQuery query-result temporary tables normally last up to 24 hours:
https://docs.cloud.google.com/bigquery/docs/writing-results
As of 3 November, recovery of the missing result rows is not guaranteed. Job
metadata can outlive result tables. Do not repeat broad job-inventory loops or
claim that readable job metadata guarantees recoverable rows.

## One coverage-only read

From a checkout containing this change:

```sh
timeout --signal=TERM --kill-after=3s 270s node diagnostics/square-coverage-review.js
```

The final handoff supplies a hash-pinned temporary-checkout command for the
existing Render service, without requiring merge/deployment. The command uses
existing credentials and the accepted `email_candidate_v2`,
`customer_identity/history-20261022-billing-v3` configuration. It fails closed on
scope/project mismatch. It never activates Square or changes the snapshot,
governance decisions, raw data or report defaults.

This is a fresh warehouse read, not a metadata-only recovery. It executes only
the accepted source, identity, channel and classification stages required by the
coverage aggregates. It does not calculate retention rates, returning-product
rankings or replay the three successful business reports. The existing shared
5,000,000,000-byte query billing ceiling and dry runs remain; temporary storage
is separately metered. Stage, total-runtime, row and submission limits are reused.

All events are written incrementally to a private `/tmp/square-coverage-*.jsonl`
file before console output. Successful stages record their job IDs. The terminal
prints only manifest, population checkpoint, final aggregates, summary and
failures, preventing report tails from displacing the important coverage rows.

The aggregates are:

- Source/year/channel eligible transactions, customer-history orders and
  analytical records. These are different denominators.
- Excluded unidentifiable/conflicting-native-ID Square orders and unknown
  channel evidence. Unknown channels are not silently labelled in-store.
- Reconciled product lines, approved identity/family mappings, ambiguous lines,
  governed named-collaboration lines, missing lines and observed date bounds.
- Square eligible-order/record counts by the existing email-linkage outcome,
  preserving unmatched native Square histories.
- First-observed entry counts by source/channel in the original entry interval.
- Governed named-collaboration entry counts by source and collaboration. Items
  and collaborations may overlap. Source entry counts are not the number of
  customers whose later purchase occurred on Square.

Named-collaboration lines divided by all product lines is a **share**, not the
percentage of collaboration products correctly classified. Likewise mapping
coverage is not transaction coverage. Year/channel customer-record counts overlap
and cannot be summed into unique people. Email links remain analytical candidates.
Continuous history/follow-up and first-ever acquisition remain unverified; no
coverage certificate is inferred from populated rows or date endpoints.

## Review before activation

Review the printed population, Square linkage outcomes, source/year/channel
coverage, mapping gaps and named entry contribution. An identified or linked
subset must not be presented as representative of all retail customers. Any
remaining genuine gaps should be stated separately from query/validation errors.

If these aggregates support the intended provisional reporting scope, the next
step is the separately reviewed activation procedure in
[square-channel-reporting.md](square-channel-reporting.md#review-and-activation-boundary).
The diagnostic does not insert the reviewed extension marker or alter environment
variables. Existing legacy reports remain the default. Independently certified
rates remain unavailable until appropriate coverage evidence exists.

## Validation

The new focused tests cover generated coverage-only SQL and DATE serialization,
aggregate/privacy validation, permitted empty named cohorts, execution of shared
stages once, the unchanged cumulative billing ceiling, cleanup and job-ID output.
Existing acceptance-runner tests remain in place. Fixture checks are not live
BigQuery evidence. Live coverage counts remain pending the Render read.
