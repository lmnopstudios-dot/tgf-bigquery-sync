# Cohort script failure evidence

The reported Render result from merged #345 was `499`. That number alone does
not establish a timeout, cancellation initiator, failed statement, or warehouse
terminal state. The old CLI catch dropped `errors`, stage timings and job IDs;
child-job inspection was reachable only after result retrieval and validation.

## Production path and demonstrated defect

`answerCohortRetention` in `oracle/cohort-retention.js` starts the independent
source-qualified Woo UK, Woo US and Shopify reads concurrently, with shared
absolute request ownership. Each invokes the bound customer-journey factory.
For retention groups that factory builds `customerJourneySql`, materializes the
six existing boundaries and aggregation in one transactional script, commits,
and selects the aggregate result. `boundedQuery` submits one jobs.insert job,
owns polling and pagination, checks ownership between responses, and cancels
an allocated job on failure/deadline/abort (including late allocation).
The production path does not perform a preliminary dry run.

#345 supplied `jobTimeoutMs:15000` to the entire script while the client could
wait longer. Decomposition does not restart that timer at each statement.
The installed BigQuery SDK places numeric `jobTimeoutMs` in the top-level job
configuration. Google's [Job API](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobconfiguration)
defines that job-wide limit separately from
[ScriptOptions](https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/Job#scriptoptions),
which provides a statement timeout and statement byte budget. The server timeout
is best effort; the client ownership fence remains necessary.

The shared production/diagnostic execution settings now give the script its
existing client budget (further clamped to remaining ownership by boundedQuery),
and explicitly retain the 15-second limit per statement. The diagnostic still
allows 25 seconds for execution; normal production uses its caller's existing
budget. The 2.5 GB per-data-statement billing ceiling remains: eight data
statements cannot exceed the existing 20 GB execution allowance. No expression,
join, ranking, cohort definition, governance traversal, source identity, or
transaction snapshot changed. No persistent destination or provider retry was
introduced. This fixes the demonstrated budget mismatch; it does **not** prove
that mismatch caused the reported 499.

## One bounded Render acceptance command

Run from the checkout containing this change, using Render's existing identity:

```sh
timeout --signal=TERM --kill-after=2s 50s node diagnostics/oracle-cohort-decomposed.js
```

It tests the same Woo UK production SQL and shared script settings for the
fixed 2026-10-19 acceptance scope. It first validates every expression using the
original relational query (script dry runs stop at CTAS), then executes the
transactional script. No collection, backfill, source mutation, deployment,
persistent table, or durable analytical job is requested. Temporary tables and
transaction setup are part of the existing execution mechanism.

The command exits nonzero unless validation, execution, evidence scope and
complete terminal warehouse-stage evidence all pass. On success it returns
completed cohort rows, retention, coverage, child job IDs and elapsed times.
If only metadata inspection fails after successful execution, completed rows
remain available but `production_success` stays false.

On failure inspect:

- `failure`, `failure_layer`, and `client_stages`: dry-run, submission, retrieval,
  or evidence validation; safe machine reason/category and SQL line/column.
- `events`: local deadline, caller abort, or failure cleanup provenance. Cleanup
  after a 499 does not establish that this client initiated the original failure.
- `warehouse.parent`: final observed state, safe error reason and elapsed time.
- `stage_outcomes`: transaction setup, every CTAS, aggregation, temporary cleanup,
  commit and result SELECT, with observed outcome, elapsed time and job ID.
  `not_observed` means unknown, never successful or proven unexecuted.
- `warehouse.inspection_errors` and `children_truncated`: limits on the evidence.

The metadata reads run on either execution outcome, concurrently within a
separate four-second inspection bound. They cannot admit late rows or extend
query ownership. Query cancellation cleanup adds at most one second, so the
40-second combined validation/execution budget plus cleanup and inspection fits
within 45 seconds before the outer shell watchdog. The output excludes SQL,
parameters, raw messages, customer identifiers, credentials and headers.
A warehouse `stopped` reason alone does not identify who cancelled the job.

## Verification boundary

A live read from this workspace returned HTTP 403 during dry-run submission,
without a job ID; script execution was not attempted. This is distinct from the
reported Render 499 and cannot explain it. The revised output reports that
boundary instead of collapsing it to a numeric code. Render warehouse acceptance
remains outstanding. Fixture/SDK transport tests verify contracts and ownership,
not production completion or actual warehouse relational equivalence.
