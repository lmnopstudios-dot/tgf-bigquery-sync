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

After that verification, remove only that empty lock directory with `rmdir`, then
resume with the same launch command. Do not use a wildcard or delete checkpoints.
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
