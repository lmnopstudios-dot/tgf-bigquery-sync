# Oracle durable-job contention recovery

## Demonstrated chain

For request `160f7b8f-b4a4-46b2-a03e-2327473b7b10`, the supplied production
log demonstrates only that one claim transaction received BigQuery
`invalidQuery` with “Transaction aborted due to concurrent update”. It does
not demonstrate that this claimant owned the job, ran analysis, or wrote the
terminal failure. The four later ShopifyQL successes cannot be attributed to
this request from those uncorrelated log lines alone. The authenticated job
row and correlated worker/provider logs are the authority; do not infer a
failure chain merely from temporal proximity.

The former queue made every claimant update all expired running rows inside
the same transaction. Replicas could therefore contend on the shared table,
and the recognised abort was misclassified because BigQuery reported reason
`invalidQuery`. A lease timestamp by itself was also not a unique ownership
credential, and successful evidence was written only with the terminal state.

## Fix

Claims now conditionally transition one queued job and assign an unpredictable
claim token plus worker ID. Completion, failure and evidence-checkpoint writes
require the current token, exact lease and an unexpired lease. Only the
specific concurrent-update abort is retried, a bounded three times with
exponential jitter; unrelated `invalidQuery` failures escape immediately.
The result is checkpointed before terminal completion, so a later persistence
failure does not require repeating successful provider calls. Worker,
provider and persistence logs contain request ID, job ID and attempt, but no
prompt, evidence values, owner key or credentials.

## Read-only production acceptance

1. Deploy all replicas with this revision and allow startup to add the two
   nullable lease-ownership columns. Do not truncate, reset, backfill, collect,
   or alter schedules.
2. Run `node diagnostics/oracle-job-request.js 160f7b8f-b4a4-46b2-a03e-2327473b7b10`.
   This performs one parameterised `SELECT`. Record the job ID, attempts,
   status, worker ID, result presence and evidence section count.
3. In the normal authenticated Oracle UI, request
   `GET /api/oracle/jobs/request/160f7b8f-b4a4-46b2-a03e-2327473b7b10`, then
   request the returned `GET /api/oracle/jobs/{job_id}`. If a checkpointed
   answer exists, this path returns it even if the old terminal status is
   failed, marked `recovered_persisted_result: true`.
4. Filter application logs by the request ID. Require the same job ID and
   attempt on `claimed`, each of the four ShopifyQL provider outcomes,
   `evidence_checkpoint`, and `finish`. This is the only acceptable basis for
   attributing those calls to the request.
5. Submit the exact sales-baseline prompt from
   `test/oracle-baseline-overview.test.js` through `/api/oracle/jobs` with a
   fresh request ID. Poll only the authenticated job-read endpoint. Accept
   exactly four evidence sections: August Online Store, August Point of Sale,
   September Online Store and September Point of Sale. Repeat the submission
   with the same request ID and require the same job ID and no additional
   provider calls.
