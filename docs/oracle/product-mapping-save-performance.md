# Product-mapping batch save performance

The Woo bulk panel uses the shared `bulkReview` service, also used by the older review UI. This change reduces repeated warehouse work in that service without changing the batch size or starting parallel governance writes.

## Before and after

The same eight distinct reporting-family assignments were executed against the old and new service with the stateful warehouse fixture in `test/helpers/product-mapping-save-fixture.js`.

| Work for eight family rows without preview tokens | Before | After |
| --- | ---: | ---: |
| Query jobs | 66 | 36 |
| Full product-catalogue reads | 8 | 1 |
| Initial submission-receipt MERGEs | 8 | 1 |
| Current family-history reads | 8 | 8 |
| Persisted family assignments | 8 | 8 |

These are measured query counts from mocked warehouse transport, not production latency measurements. Dataset/table metadata setup calls are excluded and unchanged. Query caching and warehouse load affect real timings; 45% fewer query jobs does not establish a 45% reduction in elapsed time.

## Changes

- Load the product catalogue once per submission and discard the snapshot when that submission finishes. Replays whose rows are already terminal need no catalogue read.
- Write all initial `submitted` operation receipts in one atomic, parameterized JSON-array MERGE before any approvals. Terminal receipts remain per row. Stable event IDs and operation recovery are preserved.
- Read only the current decision histories required for the action. Outcomes read outcome history; family assignments read family history; identities and token-bearing family requests also read mapping history.
- Use the same family allowance as the interactive preview for family-only saves. A reporting family does not merge identities, so rebuilding a hypothetical identity graph is unnecessary. Full graph validation remains for identity decisions; supplied global preview tokens still receive full current-governance validation and stale-token rejection.
- Reuse the batch catalogue during identity extension validation rather than fetching it again.

Current relevant governance and operation receipts are still read before each row. Earlier decisions in the batch and decisions appearing between rows are visible. Conflicts and invalid targets remain blocked/failed independently; previous successes survive. No new cross-request cache, schema change, reporting SQL change, parallel-write path or production-data mutation is part of this implementation.

The new catalogue log records operation ID, batch size and catalogue load duration only. Existing router logs record total operation duration and per-status counts. No customer values or SQL are logged.

## Verification and deployment

Eight regressions exercise catalogue/query counts, fresh conflicting family decisions, identity namespace conflicts, matching/stale preview tokens, partial success, variant rejection, initial-receipt failure, interrupted terminal-receipt recovery, idempotent replay and catalogue isolation between operations. Existing interactive and durable-report browser gates remain required.

The stateful fixture does not execute the new receipt SQL against BigQuery. Its parameterized array projection follows the existing decision/family MERGE shape. Live warehouse execution and elapsed-time improvement remain unverified until deployment.

After normal review/CI and deployment, use the existing Woo panel to save a reviewed batch normally. Inspect the per-row receipt; an interrupted response must recover the same operation rather than be resubmitted. No separate diagnostic, snapshot work or mapping reapproval is required by this change.
