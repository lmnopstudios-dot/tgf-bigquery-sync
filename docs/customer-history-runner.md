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
`2026-10-21T08:12:12Z`, with 850 reported committed records, 8,850 this-run
reported committed records, and an unknown pending commit outcome. Preserve
that original log. These totals are neither a cursor nor persisted row counts.

### Demonstrated reader defect

The collector CLI overrides legacy `collect.js` dates with `HISTORY_SCOPE`:
`1900-01-01` through `2026-10-19`. The runner supplies no date or evidence-table
arguments. The writer hashes JSON `[source, adapter, start, end, null, revision]`
in that exact order. Its default revision is `history-20261020-v2`. Each successful
child rereads `history_progress` by that key, so sequential invocations select the
same checkpoint. The old recovery reader incorrectly used `SCOPE.start`,
`2022-09-24`, producing a different key for both checkpoint reads and transaction
provenance. This explains how a reader could return zero while the writer resumed.
It does not prove the actual production checkpoint exists or identify the old
child failure. Both end dates are fixed at `2026-10-19`, not computed from today;
there is no daily rollover. A shared key helper now preserves the writer's exact
serialization, including prior revisions, without rewriting any stored keys.

Both readers use the configured `GOOGLE_PROJECT_ID`, dataset `customer_identity`,
table `history_progress`, source `ww`, adapter `metorik_orders`, and unchanged
revision. The evidence table defaults to null for this adapter. `email_observations`
is the additive destination, not an `evidenceTable` selection argument. String
hash parameters serialize as BigQuery STRING; DATE wrappers used for roster date
filters do not participate in hashing. Evidence counts intentionally span revisions.

### Operator procedure

Stop/prevent submissions by all collectors and runners for this selection on all
hosts and identities, and keep them stopped through review, unlock and launch.
Drain outstanding submission RPCs and delayed callbacks, including a job creation
request whose response was lost or timed out. A stopped local PID or cancellation
acknowledgement does not establish that an outstanding request cannot still create
a warehouse job. Reconcile those known submissions to terminal jobs before asserting
quiescence. Account for any other executor's pending/running warehouse jobs using
that executor's identity or administrator visibility. This workspace cannot attest to
those facts. Once the operator has confirmed them, run on the existing Render
runner host with its existing protected configuration:

```sh
timeout --signal=TERM --kill-after=5s 100s node diagnostics/customer-history-recovery.js --confirm-executors-quiescent
```

The flag records an operator assertion; it does not stop processes, grant access,
or cancel jobs. Omit the flag for discovery without that assertion; output then
remains blocked. This command never collects, changes checkpoints, cancels incident
jobs, or removes locks. It may cancel only its own timed-out diagnostic SELECTs.
The shared 90-second budget, individual ten-second reads, 1 GB per-query billing
ceiling, and outer 100-second timeout remain. Keep sanitized output beside the log.

Recovery does **not** scan historical jobs. The previous 2,000-job/ten-page
truncation was a diagnostic coverage limit, not a violation of atomic resumption.
`listing_complete:null`, `listing_pages:0` and `inspected_jobs:0` explicitly report
that history was not scanned. Previously captured historical evidence is retained.

Instead, the probe exhausts pending/running work across the configured identity
before checkpoint reads and repeats that check after all diagnostic SELECTs finish.
Each listing retains the ten-page cap: a remaining page, missing/repeated token,
failed read or deadline exhaustion blocks recovery. It also checks local `/proc`
for collectors/runners at both ends, without printing arguments. Any initial or
late active work blocks commands. Two empty observations help detect a violated
barrier; they cannot establish a distributed submission fence or prove that an
invisible, in-flight creation request will never arrive. The operator assertion
therefore includes the drained-submission condition above and holds until the sole
resumed runner launches. Other hosts/identities require their own exhaustive checks;
`allUsers:false` is deliberately not represented as administrator visibility.

After job checks, aggregate-only checkpoint discovery reports exact-key and
exact-selection row counts, the legacy reader-key count, same-namespace/revision
counts, other revision counts and missing lookup fields. Metadata checks required
field types. Discovery uses JSON field extraction so older schemas can be diagnosed
without selecting private cursors. Unknown hashes cannot reveal arbitrary start/end
or evidence-table components: a same-namespace mismatch is reported, never guessed
or replaced with the nearest/newest row. Zero exact matches, duplicate exact keys,
incompatible namespaces/schema/state, active/uncertain work or incomplete active listings
block recovery. A missing table/read failure also blocks. Evidence alone never
proves checkpoint presence, absence, deletion or loss.

Output `status` is `blocked`, `recoverable`, or `complete`, with stable machine
`reasons`. `safe_to_unlock:true` (exit 0) requires one compatible authoritative
checkpoint, verified boolean completion and timestamp, two complete active listings, terminal
corresponding work, zero active identity jobs and zero local collectors at both observations, and the
operator submission-barrier assertion. `blocked` exits 2, emits no unlock/resume commands and must
be resolved first. Errors also emit `status:blocked` and `safe_to_unlock:false`.

A safe result supplies `unlock_command`, an exact `rmdir /tmp/customer-history-runner-<hash>.lock`
for this selection, and, only if incomplete, `resume_command` with the identical
launch at the top of this document (20 batches, 40 invocations, six hours, 650
seconds per invocation). Review the fresh result, run only that exact `rmdir` if
the retained empty lock exists, then its resume command while other submitters
remain stopped. Do not use wildcard deletion. A complete result requires no launch.
The incident-specific commands below are conditional on a fresh passing probe and
the continuing operator barrier; they are not executed by the probe.

### Exact commands for the reported checkpoint (not executed here)

The operator-reported checkpoint is uniquely selected by `1900-01-01` through
`2026-10-19`, null evidence-table selection, and `history-20261020-v2`; it is
incomplete, last updated `2026-10-21 08:11:51.998+00`. The reported 15,000 persisted
provider records are evidence, not a replacement cursor or a per-run count. Preserve
that row, revision, all evidence and existing logs. With the drained-submission
barrier held, run the read-only probe above from this change's code on the existing
runner host. Only on exit 0 with `status:recoverable` and `safe_to_unlock:true`,
review its exact commands and run:

```sh
rmdir /tmp/customer-history-runner-548d195ee1121da71503b0debd552ca421e9734c11ac1301071da2a1f49b111c.lock
nohup node customer-identity/history-runner.js --source=ww --adapter=metorik_orders --dataset=customer_identity --batches=20 --revision=history-20261020-v2 --max-invocations=40 --total-ms=21600000 --invocation-ms=650000 --apply </dev/null >>/tmp/customer-history-ww-metorik-orders.log 2>&1 &
```

If the retained lock exists, `rmdir` must succeed on this exact empty directory;
do not force removal or continue past an unexpected error. Keep other submitters
stopped through launch. If the fresh checkpoint is complete, no resume is needed.
The supplied production snapshot supports the recovery invariant under the operator
barrier; it is not a fresh execution of this updated probe. No production lock has
been removed or collector launched by this change.

### Why lost child attribution does not prevent recovery

Every batch merges additive evidence and checkpoint cursor/completion in one
BigQuery transaction with an expected-cursor assertion. Once all prior work and outstanding submissions are
drained, warehouse jobs are terminal and the submission barrier is held, reread the authoritative checkpoint: a committed
transaction advanced both, and a rolled-back transaction advanced neither. The next
child rereads that same key; it never derives a page from runner totals. A load
before a transaction only fills a random staging table and cannot update canonical
evidence or progress. Its terminal state is covered by identity-wide quiescence,
even if its relationship to the suppressed child is unknown. Failed/uncertain
stages retain their original TTL. No manual cursor edits, uncertain-write retries,
new revisions, completed adapters, truncation or evidence deletion are needed.
Cancellation acknowledgement alone proves neither terminal state nor rollback.

Exact SQL/key/source/adapter/revision transaction matching remains useful diagnostic
evidence, with children and stage loads linked only through verified provenance.
Neither missing matches nor an incomplete historical listing is a blocker when
complete identity-wide active-work checks and the operator barrier establish
quiescence. Historical success/failure cannot select the resume cursor. If separate
failure diagnosis needs historical evidence, use the existing exact SQL/checkpoint
key/source/adapter/revision provenance helpers and the failure log's invocation
elapsed interval (falling back to the known runner interval), not an arbitrarily
larger scan. Such attribution is advisory and must never be called exhaustive
when pagination is capped. This recovery contract does
not diagnose the suppressed production failure or guarantee the next API call.

The runner retains sanitized stage/code/reason, job ID, commit outcome, cancellation
state and statement location. Earlier committed records remain separate from the
failed operation's exact outcome. Existing runtime/API/query/billing caps, host
locking, cancellation and transaction safeguards remain intact. No production writes,
collection, incident-job cancellation, lock removal, merge or deployment are part
of this task.
