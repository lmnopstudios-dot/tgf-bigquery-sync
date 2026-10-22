# Customer-history readiness billing and verification

The operator reports that the identical-duplicate repair committed and its
post-validation passed. The original marker at `2026-10-22T07:31:49.447Z`, all
58,465 distinct mappings, WW/USD/Shopify counts 39,176/4,322/14,967 and retained
backups are accepted evidence. No collection, checkpoint reset, publication,
repair replay, backup write or activation is part of this change.

The subsequent deployed probe established that `snapshot_read` was rejected with
`bytesBilledLimitExceeded` at `maximumBytesBilled=10000000`, before coverage or
analytics. The generic fallback hid this cause when its own query timed out.
This is a billing precondition failure, not evidence that analytical execution
needs a longer timeout or that the repaired mapping is wrong.

## Scoped ceilings

[BigQuery's documented minimum](https://docs.cloud.google.com/bigquery/docs/troubleshoot-queries#bytes_billed_limit_exceeded)
is 10 MiB (10,485,760 bytes) per referenced table. Snapshot readiness references
one physical table, `identity_snapshots`, and reads the same four metadata fields
for the same snapshot with `LIMIT 2`. Its ceiling is now exactly **10,485,760**,
not a generic multi-gigabyte allowance. This fixes the verified floor violation;
a future larger marker scan still fails closed at that explicit bound.

Coverage retains its existing **1,000,000,000-byte** ceiling. V2's query reads
`identity_order_links` and the marker table through `orderSnapshotGuardSql`, so
its per-table billing floor is at least 20 MiB (20,971,520 bytes). Its existing
cap already covers that floor; no coverage ceiling increase or speculative
reduction is made without provider scan statistics. V1 also retains its existing
source-history bound. The diagnostic reports uncached processed/billed bytes for
each actual query to verify requirements on Render. No production byte estimate
or successful post-fix execution is claimed from local tests.

Both readiness waits remain **five seconds**, the overall check remains bounded,
and every date, marker-count, mapping-count, duplicate, key/reference, resolution
and coverage-partition integrity assertion is preserved.

## Mode label versus routing

`identityConfiguration` incorrectly returned `mode: email_candidate_v1` for a v2
request while correctly setting `orderLinks: true`. Mapping SQL, coverage SQL,
guest handling, original-order joins and the integrity guard select their path
using `orderLinks`; the incorrect `mode` was returned in `identity_evidence`.
The configuration now preserves the requested version. Tests distinguish v1/v2
routing and check mode metadata through direct, interactive and durable recovery.

The older `coverage.identity` and `customerHistoryContract.identity` values use
`email_candidate_v1` as a compatibility family label; they do not select SQL and
are unchanged here. Detailed `identity_activation[].mode`, `order_email_v2`
version metadata and the reader's mode now identify v2 accurately. No running
service identity setting is changed by this PR or the diagnostic.

## Corrected aggregate audit and error privacy

The earlier supplied audit used `COUNT(*) rows`, but
[`ROWS` is a reserved GoogleSQL keyword](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/lexical#reserved_keywords).
The corrected audit uses `row_count`, explicit deployed marker/link columns,
separate marker/link aggregates and a typed TIMESTAMP parameter. It never assumes
a `status` field: marker state is `state`. It reads only the two output tables,
checks their actual metadata names/types against the owning schema definitions,
and stops the audit on schema drift. It does not query or rewrite backups or
collection evidence.

Failures expose an allowlisted reason/category, HTTP status, numeric SQL
line/column, known schema identifier (if applicable), known unexpected `ROWS`
keyword, stage and query hash. Raw messages, SQL, parameter values, provider
bodies, emails, customer/order identifiers and canonical references are excluded.
`bytesBilledLimitExceeded` is now preserved by the shared error sanitizer too.
The keyword defect is established from the supplied SQL; without that failed
job's provider position it is not claimed to be its only possible error.

## Exact verification after separately authorized deployment

From the deployed Render `~/project/src`, run once:

```sh
timeout --signal=TERM --kill-after=3s 60s node diagnostics/customer-history-readiness.mjs
```

This probes the actual deployed wrapper with the same per-invocation v2/dataset/
snapshot overrides as `history.js check`. Its catch is observed in memory; no
file or process environment is changed. Both analytical service paths are stubbed,
so neither fallback analytics nor identity analytics executes. Cache use is
explicitly disabled only in this diagnostic to verify uncached billing. There
are at most two readiness queries plus one independent 15-second aggregate audit;
no analytical query budget is increased. It makes only targeted table metadata
and own-job metadata reads, never a broad inventory or IAM audit. Owned read-job
cleanup uses the installed SDK's `cancel()` signature.

Require exit zero, `reader_mode_label=email_candidate_v2`,
`reader_decision.readiness_passed=true`, no fallback, and summary
`readiness_verified=true`, `audit_verified=true`. Audit evidence must retain one
original marker, 58,465 links/keys, zero duplicate/conflicting/invalid keys and the
source totals above. `query_statistics` records actual uncached billing; a
missing/failed metadata read remains unknown and does not erase the independent
readiness/audit outputs. Any current rejection is emitted before the suppressed
fallback, with sanitized location details if applicable. A current pass cannot
recover or disprove a previously swallowed transient error.

Local fixture/relational checks are not GoogleSQL engine or production validation.
No mutation, deployment or activation is authorized by this verification command.

## Local validation

The required acceptance gate passed **697 tests**, zero failures/cancellations,
including the 12 new readiness/audit regressions. The required browser gate passed
21 conversations on desktop/mobile with durable and identity-fixture refresh.
Delivery regressions preserve the requested v1/v2 mode through recovery. The
aggregate SQL was evaluated against SQLite fixtures with narrow GoogleSQL
function translations; this checks relational logic, not BigQuery syntax/runtime.
The reserved-alias regression also checks the original GoogleSQL lexical defect.
Syntax and whitespace checks passed. Local gates used permitted subprocess and
localhost fixture access; restricted attempts were not counted as passes.
Production execution of the corrected readiness/audit remains post-deployment
verification, not a local test result. Nothing was deployed or activated.
