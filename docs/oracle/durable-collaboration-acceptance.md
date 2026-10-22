# Mixed-revision durable collaboration failure

## Confirmed trace

The exact existing job was inspected read-only in Render, with no resubmission.
The shell revision was `7c9d02b91a1780c120ab8aa93fecd90e90d3abf5` (PR #367).
The job is failed, attempts=1, with `INVALID_ANALYSIS_CONTEXT` at analysis.
Its recorded execution revision is
`1fdab55313a3f46d02a515bb2cb32503887b1ff9` (PR #366).
Dataset metadata reports US. Stored and previous contexts pass the deployed #367
validator. Reconstructed planning passes and has no differing fields.

Running the exact #366 validator from Git against the retained full report's #367
planned context reproduces `INVALID_ANALYSIS_CONTEXT`, validation_field
`unknown_field`, validation_rule `recognized_field`, with rejected key
`retention_windows`. #366 lacks all three new retention fields. Because #367's
empty context includes these fields, the incompatibility also affects other
subjects serialized by #367, not just this report or its exact wording.

Planning/serialization were consistent with #367. The queue's ordinary lookup and
atomic claim had no execution-revision compatibility predicate. A #366 worker
claimed the #367 payload, recorded its revision, hydrated JSON and entered analysis.
The dispatcher's first strict context validation rejected the new key before any
provider calculation or delivery checkpoint. This explains the empty answer,
evidence and artifact. The validator is correct and remains unchanged.

New durable submissions record their producer execution revision. Ordinary
candidate selection and the atomic claim UPDATE require that revision (or an
explicit recovery revision) to match the worker's actual build revision. Both
ordinary and targeted claims enforce the same predicate. Legacy unpinned payloads
retain existing behavior; explicit recovery pins them in lifecycle metadata.
Claim logs now retain worker ID and execution revision after tick cleanup.

This is deliberately exact revision routing, not a claim that arbitrary builds
are analytically compatible. Drain revision-pinned queued work on its producing
build before retiring it. A replacement build does not silently reinterpret it.
Workers deployed before this fence do not honor it: retire those processes before
recovery. Merely deploying a new web instance does not prove worker retirement.

## Separate claim error

The earlier claim-stage HTTP 400/invalidQuery is still not attributable to a
specific worker, revision, query or retry from the available logs. It may be a
separate attempt; this is not established. It did not prevent this job's successful
attempt-1 claim and is not the cause of its validator rejection. No claim SQL
syntax defect or concurrency abort is asserted. The queue implementation is identical
between #366 and #367 (`git diff` for `oracle/analysis-jobs.js` is empty).
The fix adds revision eligibility
to existing claim SQL, not a speculative repair for that 400. Correlating the
original error still requires its historical worker/query diagnostics; the exact
job-row inspection alone cannot supply them.

## Explicit same-submission recovery (not performed)

The tool defaults to a bounded SELECT-only plan. It reads only the supplied request
and job, uses dataset metadata for location, validates stored and previous contexts
with its deployed validator, and returns sanitized metadata plus a row fingerprint.
It refuses active/cancelled jobs, saved content, repeat recovery, invalid contexts,
and failures not matching this mixed-revision pre-analysis failure.

After reviewing/deploying this fix and **retiring all pre-fence workers**, run from
that fixed Render build with existing credentials (use the original private IDs):

```
node diagnostics/oracle-context-job-recovery.js REQUEST_ID JOB_ID
```

Review its eligible state, original failed execution revision and required current
revision. Then, only when explicitly authorized to recover the original job:

```
node diagnostics/oracle-context-job-recovery.js REQUEST_ID JOB_ID --execute --legacy-workers-retired --fingerprint=FINGERPRINT_FROM_PLAN
```

Do not run the execute command during investigation. The retirement flag is an
explicit operator attestation, not an automated check of Render deployments.
Execution makes one transaction with no automatic application or SDK retry. It
asserts a singleton row, fences its complete original state (including owner,
payload, failure, attempts and lease) and target build revision against the reviewed fingerprint and asserts
exactly one updated row. It clears terminal failure/old lease ownership, requeues
that row, and pins execution to the fixed build in lifecycle recovery metadata.
It preserves original payload, owner, request ID, job ID and attempt count, and
archives the original result/lifecycle in the recovery audit. Subsequent heartbeats
preserve that audit; the next successful claim increments attempts from 1 to 2.

The tool neither submits a report nor calls a provider/worker itself. After an
explicit requeue, the ordinary compatible worker performs the calculation once.
Poll the original job from the original owning browser and refresh after completion;
verify saved evidence, all windows, baseline/product results, identity/coverage and
no further calculation. On timeout or uncertain transaction outcome, inspect the
original row read-only; never automatically retry execution. Same-ID POST remains
idempotent and must not be used to create a replacement report.

## Verification boundary

The retained report passes real HTTP enqueue, production BigQuery queue
serialization/hydration, claimed worker analysis, strict scope/evidence checks,
authenticated polling and browser refresh. Tests cover all windows, linked identity,
named collaborations and items, comparable baselines, second products, independent
component failures and disconnect/same-ID recovery. Queue SQL transport and warehouse
responses are doubles; no live BigQuery SQL or recovery UPDATE was executed.
The historical #366 validator reproduction used its actual archived Git tree.

No production mutation, provider replay, new report, collection, publication,
snapshot repair, IAM or identity-setting change occurred. The verified customer
snapshot remains intact. Successful live acceptance after recovery remains pending.
