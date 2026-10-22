# Failed durable collaboration acceptance: investigation remains open

The deployed PR #367 revision is `7c9d02b91a1780c120ab8aa93fecd90e90d3abf5`.
The supplied sequence establishes a successful claim at attempt 1 followed by an
analysis-stage `INVALID_ANALYSIS_CONTEXT`, with no saved answer/evidence/artifact.
It does not identify the rejected field or attribute the earlier claim-stage
400/invalidQuery to that job, attempt or worker.

The retained full report currently passes planning and repeated context validation,
JSON serialization/hydration, durable worker execution, evidence validation and
owned polling locally. Its context requests collaboration_piece, 90/180/360,
sitewide baselines and second-order products, ranked by repeat_rate_90. The new
regression uses the production BigQuery queue implementation, including MERGE
serialization, ordinary claim, JSON hydration, lease fences and terminal writes.
Only the queue's SQL transport and provider warehouse responses are doubles.
This cannot verify BigQuery SQL execution or the actual persisted production row.
Browser acceptance uses this same queue transport double for the full report.

The requested existing-job inspection was attempted read-only. The configured
proxy rejected the BigQuery destination as `EGRESS_FORBIDDEN`. No production job
was created, replayed, claimed or modified. No raw payload was retrieved. The
production rejected invariant therefore remains **unidentified**; this change
preserves all scope validation and contains no speculative parser exception.

The incident inspector now reads the stored context, validates it internally and
returns only the validator revision and rejected field/rule. It never emits the
stored context. Future worker failures preserve existing validation field/rule
metadata in the terminal failure and logs. This cannot retroactively recover
metadata that was discarded by the deployed worker.

## Read-only completion procedure

From an environment already authorized to reach BigQuery, using existing runtime
configuration and credentials, run the inspector with the supplied request and
job IDs (do not submit the report):

```
node diagnostics/oracle-analysis-incident.js REQUEST_ID JOB_ID --inspect-query
```

Record execution revision and worker ID separately from the inspector revision.
If the stored context fails, its field/rule identifies the current validator's
rejection; compare against the deployed validator before declaring root cause.
If it passes, inspect the deployed worker/provider transformations and correlated
logs rather than assuming serialization was responsible.

Investigate claim separately: correlate each claim error by timestamp, worker,
revision, query job ID and retry number. Inspect that query's metadata/error and
exact submitted SQL privately. `invalidQuery` alone does not distinguish syntax
from a concurrent-update abort; only the latter is eligible for the existing
bounded contention retry. A later attempt-1 successful claim establishes neither
identity nor cause for the earlier failure. No available logs establish whether
it was another worker. Do not change claim SQL speculatively.

## Same-submission recovery after a verified fix

There is currently no supported requeue endpoint for a failed terminal job.
Resubmitting the original message with the same owner and correlation ID returns
the existing failed job; a new correlation creates a duplicate submission.
Refreshing/polling cannot recover this job because no evidence was persisted.

After identifying and fixing the invariant, validate the existing stored payload
read-only using the deployed fixed validator, then review an explicit one-job
requeue operation. It must fence on original job ID, request ID, owner, failed
status, error code, attempts and absence of saved evidence/artifacts; preserve
payload and identifiers, retain an audit of the original terminal failure, and
require an affected-row count of exactly one. Only then allow one worker claim
and poll the original job from the original owning browser. Inspect the saved
result and refresh without a further calculation. Stop on any fence mismatch.
This document authorizes and performs no requeue. A concrete supported recovery
operation is still outstanding and must accompany the actual fix.

No collection, publication, snapshot repair, IAM or identity-setting changes.
The customer snapshot was untouched. This is a diagnostic/regression draft,
not a certified fix or successful live acceptance.
