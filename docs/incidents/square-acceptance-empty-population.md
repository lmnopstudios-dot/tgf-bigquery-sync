# Square acceptance compiled but returned an invalid empty population

The supplied Render output starts midway through stage rows but contains all
three complete aggregate reports and the final summary. The diagnostic reported
all cases as successful and billed **1,393,557,504 bytes**. Every report returned
`reporting_coverage: []`; the product reports returned zero-valued overall rows,
and retention returned only a supplemental/header row. These are not accepted
zero-customer results and do not supersede #400's successful source evidence.
The compact aggregate fixture preserves this false-success case without names,
emails, customer/order IDs or the unrelated catalogue labels.

## Confirmed cause

`selectedParameters` declared calendar parameters as `DATE` but passed plain
JavaScript strings. The installed BigQuery SDK obtains `value.value` for explicit
DATE scalars. A string has no `.value`, and JSON serialization omits the value:

```json
{"parameterType":{"type":"DATE"},"parameterValue":{}}
```

The missing `observation_end` cutoff makes date comparisons select no eligible
history. Missing entry bounds likewise prevent entry assignment. The query can
compile and run successfully while these predicates evaluate against NULL. This
was reproduced with the real SDK, its REST request serialization/result decoding,
and the generated report-history SQL against populated synthetic persisted inputs.
The exact same source inputs and SQL retain native Square and online history when
the DATE bindings are repaired. No production query replay was needed to establish
this defect. It is not a warehouse timeout, missing profile/email finding or a
reason to change eligibility, product mappings, dates, identity or resource limits.

The normal report provider already uses `bigQueryDateParameters`; its date binding
and the three report generators are unchanged. This fix repairs the standalone
acceptance diagnostic.

## Fix and validation boundary

The diagnostic now uses the existing `bigQueryDate` helper for non-null calendar
bounds. Unverified `coverage_start`/`coverage_end` remain intentionally null. A
local preflight records the actual installed SDK's encoded DATE values and rejects
missing non-null calendar bounds before any data job. Parameter scanning masks
literals, identifiers and comments rather than mistaking email-like fixture values
or system variables for query parameters. Calendar dates are the only scalar
values printed in this preflight; it does not print credentials or source data.

A single cached aggregate checkpoint follows `ranked_orders`, before classification
and cohort work. It requires populated native Square customer history from the
already materialized relation. Empty or missing Square history halts dependent
work and reports skipped cases, not successful zeros. The checkpoint prints only
source/store order and analytical-record counts. It reads a temporary relation,
not the original directory or a repeated discovery/coverage query.

Terminal acceptance also rejects empty full-history coverage and missing native
Square coverage. A genuinely empty channel/date-filtered cohort remains valid
when the underlying history and reporting coverage are present. Thus the fix does
not manufacture positive cohort counts or exclude unsupported/unknown channels
to make a check pass. All native-ID, shared/conflicting-email, import, classification,
channel, chronology and snapshot safeguards remain unchanged.

Billing remains one **5,000,000,000-byte shared execution ceiling** across every
stage, checkpoint and report. The added checkpoint is charged from that same
allowance and reused across cases. Dry runs, authoritative accounting, allocated
job inspection, 60-second job/240-second orchestration/270-second outer bounds,
aggregate-only output and session cleanup remain in place. Temporary storage is
separately metered until cleanup/expiry. The prior session was successfully cleaned
up, so its temporary tables cannot be reused for a corrected run.

The supplied run establishes compilation/execution of its SQL shapes, not correct
population/DATE semantics. Its zero report counts are **unknown/invalid** for
business reporting; the separately successful #400 evidence remains preserved.
No source recollection, mapping/IAM change, identity publication, replacement
snapshot, activation, production write or automatic report rerun was performed.

## Corrected bounded Render acceptance

From a checkout containing this fix, with existing Render credentials and v2
snapshot configuration, run the same command once:

```bash
timeout --signal=TERM --kill-after=3s 270s node diagnostics/square-reporting-acceptance.js
```

Look for non-null SDK-encoded `observation_end`/entry dates, a successful populated
`population_check`, non-empty full-history reporting coverage, and independently
validated case outcomes. Zero filtered cohorts must be interpreted using channel
provenance, mapping coverage and cohort dates. New production counts remain pending
this corrected validation; publication/activation remain separately gated.

Local verification: **923 acceptance tests passed, zero skips**. Desktop/mobile
browser acceptance also passed, including durable refresh. The SDK regression uses
the real installed client for request serialization and result decoding; only the
REST server is substituted, with generated SQL evaluated on synthetic data through
the documented local dialect adapter. This verifies the fix and the old failure
mechanism locally; corrected production report counts remain unverified until the
bounded Render command is run. No automatic production replay was performed.
