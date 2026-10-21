# Bounded customer-history resume on Render

From the reviewed checkout in the existing Render service shell, with its existing
protected credentials and project configuration, launch **only WW Metorik orders**:

```sh
nohup node customer-identity/history-runner.js --source=ww --adapter=metorik_orders --dataset=customer_identity --batches=20 --revision=history-20261020-v2 --max-invocations=40 --total-ms=21600000 --invocation-ms=650000 --apply </dev/null >>/tmp/customer-history-ww-metorik-orders.log 2>&1 &
```

Progress (the final JSON line records completion or the reason it stopped):

```sh
tail -n 30 -F /tmp/customer-history-ww-metorik-orders.log
```

The launch survives shell disconnection. A Render deployment, instance replacement,
restart, or eviction can stop it; `/tmp` logs and host locks are ephemeral. This is
not a deployment, a scheduled job, or a promise of execution across replacements.
Do not deploy or replace the instance during collection. Exit 0 means validated
`complete`; bounds and all failures exit 2. `invocation_cap` is a bounded stop,
not completion. The example allows at most 40 sequential invocations, six hours
of collection wall time and 650 seconds per invocation. A stop requests SIGTERM;
up to five additional seconds are reserved for cleanup before SIGKILL. Cleanup
may be uncertain even if cancellation was acknowledged. No next child is started
until the preceding child's streams close, and none starts after a stop.

## Resume the current production work

The operator reports all three rosters and WW retained evidence complete; WW
`metorik_orders` is partial. Preserve dataset `customer_identity` and revision
`history-20261020-v2`. The command above invokes the existing `history.js collect`
with the same source, adapter, dataset, revision and 20-batch selection each time.
Each child rereads the existing atomic warehouse checkpoint. There is no local
cursor, checkpoint reset, revision change, evidence deletion, or replay derived
from log totals. Already complete checkpoints return `complete` without collection.
Do not rerun initial provisioning, roster or retained-evidence instructions.

Only a zero-exit invocation with exactly one valid aggregate result and positive
committed records/batches in `resumable` authorizes another invocation. Complete
may have zero records. No retry follows a nonzero exit, signal, deadline, invalid
or multiple/missing result, failed status, unknown commit outcome, or zero-progress
resumable. Provider output is captured with a 16 KiB ceiling, never passed through.
Logs contain safe aggregate fields: timestamp, source, adapter, invocation number,
result, reported committed records, invocation elapsed milliseconds, and explicitly
**this-run reported committed records**. Failure counts cover earlier committed
batches only, not an uncertain pending commit. Null means unverified. Counts are
not unique evidence-row counts or estimates of the full historical population;
they are never used to select the next page. Roughly 34,000 remaining records is
an unverified operator estimate, not a completion target.

After an invocation-cap stop, rerunning the identical launch command resumes the
same warehouse checkpoint with fresh runner bounds and this-run counters. After
any failure, inspect and resolve it before an operator-authorized resume; this
runner never retries failures. For unknown commit/cancellation outcomes, first
verify the warehouse job is terminal and inspect saved progress; acknowledged
cancellation alone does not prove rollback. Never manually infer or edit a cursor.

## Concurrency and termination

An atomic private directory in `/tmp` on the Linux Render host locks the
dataset, source, adapter and revision independently of project environment aliases,
`TMPDIR`, checkout path and invocation limits. This conservatively blocks matching
selections across projects on the same host. Another runner for that work refuses to start. The
lock is released after normal completion, invocation cap, zero-progress, or a
reported failure with a known commit outcome and no pending cancellation. It is deliberately retained on
termination, timeout, unknown outcome, unconfirmed cancellation, malformed output, or an unexplained nonzero
exit. A runner crash/SIGKILL can also leave it behind. Do not remove a retained
lock until the previous runner/child and its warehouse work are confirmed inactive.
The exact lock path can be computed without printing project configuration:

```sh
node --input-type=module -e 'import {createHash} from "node:crypto"; import {join} from "node:path"; const key=createHash("sha256").update(JSON.stringify(["customer_identity","ww","metorik_orders","history-20261020-v2"])).digest("hex"); console.log(join("/tmp",`customer-history-runner-${key}.lock`));'
```

For the current invocation 9 incident, use the read-only recovery section below.
Do not remove the lock or resume until the unresolved evidence has been resolved.
An operator may remove only the exact empty lock directory after complete
quiescence verification; never use a wildcard or delete checkpoints.
This same-host guard does **not** replace warehouse
checkpoint concurrency assertions. It cannot coordinate different hosts or block
someone invoking `history.js` directly. Avoid all overlapping collectors for the
same work, including during operator recovery.

SIGTERM/SIGINT is forwarded to the child; minimal CLI signal plumbing routes it
into the existing owned warehouse query/load cancellation and API abort paths.
An uninterruptible provider operation can outlast the grace period; the runner
stops and retains the lock rather than claiming completion or safe retry.

## Scope and limits

Required arguments are `--source`, `--adapter`, `--revision`, `--max-invocations`,
`--total-ms`, and `--apply`. Dataset defaults to `customer_identity`, batches to
20, invocation timeout to 650000 ms. Integers must be positive: batches <=1200,
invocations <=1000, total <=86400000 ms and invocation timeout <=650000 ms.
Duplicate/unknown arguments are rejected. Supported adapters are `roster`,
`native`, `metorik_orders`, `metorik_customers`, and `shopify`, with existing source
compatibility. Evidence-table adapters and custom date selections are intentionally
outside this runner's scope. Child arguments use structured `spawn`, without a
shell or eval. No collector API, query, billing, byte or batch ceilings increase.

This orchestration does **not** resolve the intermittent warehouse commit deadline.
The earlier `ORACLE_AGENT_DEADLINE` at batch commit had 42 committed batches/2100
records and an unknown pending commit outcome. Subsequent 20-batch successes do
not establish that smaller invocations fix it. The runner stops on its recurrence.
It does not change transaction deduplication, email provenance, ambiguity handling,
Oracle integration, publish snapshots, activate Oracle, schedule work or select
another adapter automatically. No production collection was run to test this PR.

## 2026-10-21 invocation 9 recovery (read only)

Incident: WW / `metorik_orders` / `customer_identity` / `history-20261020-v2`.
Runner start `2026-10-21T07:41:18Z`; invocation 9 failed at
`2026-10-21T08:12:12Z` with `child_nonzero`, 850 reported committed records,
8,850 this-run reported committed records and unknown pending commit outcome.
The old runner discarded the child stage, code/reason and job ID. Those totals
are preserved evidence, not a cursor or a count to replay.

Run this command once from the reviewed checkout on the **existing production
runner host**, with its existing protected service-account/project configuration:

```sh
timeout --signal=TERM --kill-after=5s 100s node diagnostics/customer-history-recovery.js
```

No arguments, collection, retry, incident-job cancellation, lock removal, checkpoint mutation,
DDL, or adapter restart. Only diagnostic SELECT jobs may cancel their own work on
a read timeout. Exit 2 means recovery remains unresolved. Keep the
sanitized JSON alongside the original log; do not replace the original evidence.
The probe itself has a shared 90-second evidence budget, ten-second individual
reads and SQL jobs, and a 1 GB billed-byte ceiling per aggregate query. It uses
the existing configured service account, refuses an absent explicit identity,
reads dataset location, and lists at most 200 incident jobs with pagination
explicitly disabled. A continuation is reported as incomplete evidence.

The probe reads at most 64 KiB from the tail of the existing fixed runner log.
If exactly one failure record matches the supplied incident timestamp, source,
adapter, invocation, committed counts and outcome, its bounded
`invocation_elapsed_ms` narrows the invocation interval (five-second margins).
Otherwise the entire known runner interval is searched, and the missing invocation
start is reported in `search_scope`. Time never establishes correspondence.

A checkpoint transaction must match the configured submitter, exact unchanged
checkpoint key and source/adapter/revision parameters, and the collector's exact
transaction SQL. Loads are linked only through destination stage tables named
by those verified transactions. Script children link through verified parent job
IDs. Random stage names or nearby creation times alone are insufficient. SQL,
query parameters, identities, source payloads, error messages and private cursors
never appear in the result. Only validated job IDs, state, allowlisted reason,
aggregate evidence counts, checkpoint existence/completion and update time leave
the probe. Evidence counts span revisions for this provider and source; they are
not this-run counts, revision-specific counts, or the checkpoint cursor.

The separate current pending/running job listing is limited to 100 jobs under
that configured identity. Local `/proc` inspection reports only the count of
runner/collector processes, never command lines. Neither read can establish
quiescence on another host or under another identity. Preserve the lock if
metadata is truncated, a read fails, checkpoint rows are missing/duplicated,
corresponding work is nonterminal, or any possible work remains unaccounted for.

Even all-terminal matching transactions cannot recover the suppressed failed
child stage/job ID. A failure may precede submission of its checkpoint transaction,
leaving an unlinked load. The probe therefore always returns `safe_to_unlock:false`
for this incident and describes that unresolved attribution explicitly. Obtain
independent production execution/job provenance to identify the failed work and
confirm **all** previous runners/children and warehouse work are inactive across
hosts and identities. Cancellation acknowledgement does not establish terminal
state or rollback; an unknown transaction may have committed. Inspect persisted
progress after terminal verification; never reconstruct or print a cursor.

Do not run the launch at the top of this document or remove the retained lock as
part of this probe. An exact unlock/resume sequence must be supplied only after
the terminal-job and process evidence is reviewed and no active work remains.
Then resume only this existing WW Metorik selection and revision, using the saved
checkpoint; never rerun completed rosters/adapters or retry a failed collection
automatically.

The new runner forwards a revalidated `failure` object containing stage,
code/reason, job ID, commit outcome, cancellation state and safe statement
location. The outer `child_nonzero` status still records process failure. Earlier
committed records remain separate from the failed operation's exact
`not_committed` / `committed` / `unknown` outcome. Raw child output is never logged.
