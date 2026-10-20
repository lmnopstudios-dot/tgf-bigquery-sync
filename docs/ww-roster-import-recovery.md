# WW roster import recovery — 2026-10-20

This change starts at `742d6f8f29eb5fd0a1d657e78d23042a193d49a3`, the merged
#354 on main. It preserves that implementation, the existing tables, all
committed rows, the private progress cursor, and revision `history-20261020-v2`.
No production writes, deployment, merge, source reruns or revision reset were
performed during development.

## Production evidence supplied by the operator

Dataset `customer_identity`; adapter `roster`; source WW has 39,176 originals.
Shopify and USD roster jobs are complete. WW is incomplete. Several invocations
saved about 6,100–6,700 rows each. Two later `--batches=600` invocations failed;
`--batches=1` then saved 100 rows; later `--batches=600` and `--batches=10` failed.
`status` and WW `plan` succeed. Collector failures disclose only
`failure_category=access_or_storage`. A separate Render worker log reports
`stage=lease_recovery`, `code=ORACLE_AGENT_DEADLINE`, and the same string in
`bigquery_reason`. These observations are preserved as reports, not reclassified
as provider evidence. Roster collection makes zero Shopify/Metorik/Woo requests.

## Demonstrated defects and changes

* The CLI maps only message substrings to four categories and drops the error
  code, BigQuery reason, query ID, failed stage, elapsed time, and prior committed
  batch count. Provider text mentioning `customer_identity` can also incorrectly
  select the old source-contract category. Fixed internal classifications and
  provider reason allowlists now replace that broad substring matching. In particular the local `ORACLE_AGENT_DEADLINE` error's message
  (`Bounded aggregate evidence read ended`) falls into `access_or_storage`.
* Staged writes used `table.load()` and `bigquery.query()` without owning the
  client wait/cancellation. `jobTimeoutMs` alone is not a client deadline.
  A baseline probe and regression simulate a lost MERGE response: the old
  `finally` deleted its one input table (the fixed path deletes zero), although the transaction outcome could be unknown. The fix owns
  query/load deadlines, cancels allocated and late-allocated jobs, and keeps
  failed/uncertain stages under their original one-hour TTL. Successful stages
  are cleaned up as before. Temporary local files remain mode 0600 and are removed.
* The roster performed one source query, table creation, file upload/load,
  two-table transaction and stage deletion per 100 orders. This is demonstrated
  write amplification, **not proof of a quota breach**. The replacement
  materializes the bounded source population once inside BigQuery and performs
  one roster MERGE and one checkpoint MERGE in a transaction. No customer rows
  travel through Node, no file upload or permanent stage is needed, and requests
  remain zero. Only aggregate results return.

The bulk path retains the original job-key computation and string keyset cursor.
It selects only the tail after the saved cursor; completed jobs return before
reading the source. `--batches=N` still permits at most `N*100` roster rows,
capped at 60,000. The complete bounded population is materialized once (at most
60,001 rows to detect overflow), validated, and used for both tail selection and
completion. Empty/oversized/invalid populations fail before the transaction.
The existing cursor compare-and-swap assertion runs before either MERGE; the
original COALESCE rules preserve known customer IDs, dates, currency, statuses
and cancellation evidence. The checkpoint and rows commit together. Email
observations and published identity snapshots are untouched. Existing 1 GB and
20-second job limits remain; there is no automatic retry or larger timeout.

`batches` in a successful roster result remains the number of 100-row units;
`warehouse_commits:1` states the physical transaction count. Failure diagnostics
count acknowledged commits in the current invocation only. `commit_outcome:
unknown` explicitly means that a lost response/deadline cannot establish rollback.
A later invocation must read the stored checkpoint; it must not reset or assume
that the ambiguous transaction failed.

## Hypotheses still requiring production evidence

The exact cause of the reported WW failures is **not established** by the old
output. A successful single batch does not eliminate a later quota, schema,
transport, query deadline, or contention failure.

| Hypothesis | Evidence needed |
| --- | --- |
| Quota / repeated DML | Provider `quotaExceeded` or `rateLimitExceeded`, failed stage and job metadata; successful small runs alone prove neither. |
| Concurrent warehouse work | Overlapping job times, queue/slot timing, `aborted` or concurrent-update classification. Roster and queue use different destination tables. |
| Expired stage | `notFound` at load/MERGE plus the recorded job and stage lifetime; newly generated stages have a one-hour TTL. Bulk roster uses job-local temporary tables. |
| Schema mismatch | `invalid` / `invalidQuery`, sanitized type/field category and statement location; inspect schema metadata separately, never payloads. |
| Checkpoint conflict | Fixed `checkpoint_conflict` classification from the cursor assertion, or duplicate progress detection. Stop the competing collector rather than reset progress. |
| Client/server deadline | `ORACLE_AGENT_DEADLINE` is local; provider `jobTimeout` / `stopped` and job state/times are separate evidence. |

Sanitized failures include operation, stage, known code/HTTP status, allowlisted
BigQuery/transport reason, fixed category, statement line/column, job ID,
stage/run milliseconds, confirmed commits/records and cancellation state. No
messages, stacks, SQL, credentials, parameters, customer values or raw bodies are
emitted. Newly submitted query/load IDs are generated locally for correlation.

## Lease recovery is a separate investigation

`createAnalysisJobWorker()` calls `store.recoverExpired()` before claim. In
`oracle/analysis-jobs.js`, recovery first reads at most one expired queue row,
then conditionally updates it with observed token/lease fencing. It preserves
saved results and does not replay provider calls. The store's `query()` and
`terminalWrite()` have **local 20-second** `boundedEvidenceRead` waits and
15-second server job limits. The local wait produces `ORACLE_AGENT_DEADLINE`;
`bigQueryErrorDiagnostic()` falls back to `error.code` as its displayed reason.
Consequently the supplied `bigquery_reason=ORACLE_AGENT_DEADLINE` is not proof
that BigQuery issued that reason, or that roster collection caused the timeout.
Unlike the collector's new job-owned path, the queue store currently does not
cancel these waits. This behavior is documented separately; this PR does not
change queue leases or Oracle delivery.

To correlate, obtain the Render timestamp and queue query job ID/location from
warehouse job history, then run the existing read-only metadata inspector:

```sh
node diagnostics/oracle-bigquery-job.js --job=JOB_ID --location=LOCATION
```

Compare creation/start/end times, queue time, slot use, `error_reason`, and
cancellation state with the separately recorded roster query. A lease-recovery
failure occurs before a new claim, so it may have no analysis request ID.
Time overlap alone is not causation. No queue jobs, leases or evidence were
mutated in this workspace.

## One bounded WW resume

From a runtime containing the reviewed fix, with its existing production
credentials and a single roster collector:

```sh
timeout --signal=TERM --kill-after=5s 65s node customer-identity/history.js collect --adapter=roster --source=ww --dataset=customer_identity --batches=600 --revision=history-20261020-v2 --apply
```

This can consume the entire remaining WW tail under the unchanged source cap in
one warehouse commit. It never runs USD or Shopify. Inspect the returned status
and `warehouse_commits`. On failure inspect the diagnostic/job metadata before
any further invocation; do not wrap it in a retry loop. If the outcome is unknown,
wait for that job to reach a terminal state and inspect the saved progress before
resuming. No merge or deployment is authorized by this document.

## Expose the actual error on the existing #354 Render runtime

This command imports the existing entrypoint so its guards and commit behavior
remain in force. It runs one invocation at the last reported failing bound (ten batches, at most
1,000 WW orders) and bypasses only the CLI
catch that discards the error. It uses the existing sanitizer from #354; no new
file, deployment, environment dump, credential copying or logging PR is needed.
The old code may not expose a job ID; null is explicit rather than fabricated.

```sh
timeout --signal=TERM --kill-after=5s 650s node --input-type=module <<'JS'
import {main} from './customer-identity/history.js';
import {safeReadFailure} from './oracle/read-failure.js';
const started=performance.now();
try {
  console.log(JSON.stringify(await main(['collect','--adapter=roster','--source=ww','--dataset=customer_identity','--batches=10','--revision=history-20261020-v2','--apply'])));
} catch (error) {
  const safe=safeReadFailure(error,'diagnostic');
  const extra=new Set(['aborted','duplicate','concurrentUpdate','tableUnavailable']);
  const reason=error?.errors?.[0]?.reason;
  const context=error?.history_context||{},d=error?.history_diagnostic||{};
  console.error(JSON.stringify({status:'failed',operation:'collect_ww_roster',stage:['progress_read','roster_bulk','stage_create','stage_load','batch_commit','roster_count'].includes(d.stage)?d.stage:'legacy_collector',code:safe.code,bigquery_code:safe.http_status,bigquery_reason:extra.has(reason)?reason:safe.bigquery_reason,provider_reason:safe.provider_reason,error_category:safe.error_category||null,statement_location:safe.statement_location,job_id:/^[A-Za-z0-9_-]{1,100}$/.test(d.job_id||'')?d.job_id:null,elapsed_ms:Math.round(performance.now()-started),committed_batches:Number.isSafeInteger(context.committed_batches)?context.committed_batches:null,committed_records:Number.isSafeInteger(context.committed_records)?context.committed_records:null,commit_outcome:d.commit_outcome||'unknown'}));
  process.exitCode=2;
}
JS
```

If the outer `timeout` kills the old runtime, that is not proof of rollback;
inspect job history and saved progress before doing anything else. The probe can
successfully commit up to 1,000 rows; success does not reconstruct a historical
failure. The old collector cannot report prior commits on a failed invocation,
so unavailable counts are null. Inspect saved progress rather than assuming
rollback. Do not repeat the probe automatically.

## Tests and live verification

Regressions exercise the real collector/client boundary with controlled warehouse
responses: original job key/cursor compatibility, one bounded write, completed
source no-ops, typed dates/caps, transaction SQL guards, checkpoint conflict with
no retry, uncertain-stage retention, deadline and late-allocation cancellation,
confirmed commit counts, and redaction across quota/schema/concurrency errors.
Existing history linkage, guest/registered identity and publication tests remain.
These tests do not execute BigQuery's transaction dialect.

Live WW `plan` was attempted read-only here. The configured credential binding
returned HTTP 403 at the allowlisted OAuth token endpoint
`oauth2.googleapis.com`; no warehouse result or provider job was observed.
A generated submission ID is an attempted job ID, not proof of allocation.
Shell Git fetch initially lacked sandbox network permission; with that permission
it succeeded through the configured proxy and reconfirmed the exact main commit.
The GitHub connection independently confirmed the same commit. No successful live bulk SQL dry run,
WW completion, quota diagnosis, Render log inspection or lease-recovery diagnosis
is claimed. Production verification remains the bounded runtime commands above.

Validation: 98 history/identity and shared query ownership/cancellation tests pass.
The sandbox's Node synchronous input pipe does not signal EOF to Python, so the
existing Python SQL fixtures were run using an external temporary preload that
passes the identical input bytes through a private regular-file descriptor.
Test files and SQL were unchanged for this workaround. Local HTTP delivery
fixtures also require the sandbox's additional network permission for loopback
listeners. No external provider was called by those fixtures.
