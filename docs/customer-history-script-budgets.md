# History script execution budgets

## Render evidence (operator supplied, 2026-10-21)

Both checkout and RENDER_GIT_COMMIT were
`23699d65de882ac2978664be967fafaac3a9a110` (PR #361).
The actual preview returned ORACLE_AGENT_DEADLINE at preview_coverage after
20,308ms, job `history_d862705d4f0a490991d5c83828e2635c`, cancellation acknowledged.
This was not a successful preview.

The subsequent bounded metadata diagnostic reported:

| Evidence | Value |
| --- | --- |
| Parent state/outcome | DONE / failed, reason stopped |
| Parent execution / queue | 31,321ms / 49ms |
| Parent configured jobTimeoutMs | 20,000 |
| Parent statementTimeoutMs | absent |
| Parent numChildJobs | 15 |
| Linked children listed | 17; listing_complete=true |
| Child outcomes | BEGIN, fourteen materializations, COMMIT, final SELECT all DONE/succeeded |
| Materialization execution times, in order (ms) | 2009, 3611, 1079, 1306, 1029, 1214, 1172, 995, 925, 1353, 1111, 1215, 1128, 3001 |
| Materialization execution sum | 21,148ms |
| All child execution / queue sums | 21,595ms / 4,937ms |
| Remaining parent execution span | 4,789ms (not attributed by these fields) |
| terminal_evidence_complete | false |

Preserve the 15-versus-17 discrepancy. Do not reinterpret it as a complete,
successful preview or infer result delivery from successful child statements.
Cancellation acknowledgement is not terminal cancellation. Parent jobTimeoutMs
did not enforce a precise 20-second server stop in this observation. Child timeout
fields near 24 hours are provider metadata, not the application's ownership budget.
No SQL, customer values or provider messages from the attachment are retained here.

## Budget calculation

`history-budgets.js` opts in only coverage and publication:

| Path | Per statement (server) | Whole script (server and client) | Reconciliation reserve |
| --- | --- | --- | --- |
| preview_coverage | 10s | 90s | none |
| publish | 10s | 210s | 20s |
| preview_evidence / ordinary callers | unchanged | existing 20s default | unchanged |

The statement cap is 2.77 times the observed slowest materialization (3.611s).
This permits moderate stage variation while stopping an individually stalled
statement. It does not grant fourteen independent 90-second waits.

Coverage is rounded conservatively above twice the observed parent execution
plus 15 seconds for submission/result transport and variation:
2 × 31.321 + 15 = 77.642 seconds, rounded up to 90 seconds.
This is an initial operating ceiling from one failed-parent timeline, not a p95,
benchmark or guarantee. The whole-script ceiling can expire even if every
individual statement fits its cap.

Publication uses the identical graph but additionally has ten ASSERT statements
(nine before materialization, one after the link insert) and two INSERTs.
Reserve up to 12 × 10 = 120 seconds beyond coverage's 90 seconds: 210 seconds.
This deliberately retains coverage's final SELECT allowance as conservatism.
These extra statements have not been measured in production. Their individual
10-second cap and the aggregate 210-second cap both apply; a failure should be
diagnosed rather than automatically extending either cap.

Both settings must be changed together: historyQuery's maximumMs bounds the client
wait, and boundedQuery clamps jobTimeoutMs to the remaining absolute client window.
scriptOptions.statementTimeoutMs independently bounds each server statement.
No global boundedQuery or ordinary historyQuery default is increased.

## Ownership, cancellation and publication

Preview pins one absolute 110-second operation deadline: coverage 90 seconds plus
the ordinary evidence read's 20 seconds. Publication pins 230 seconds: execution
210 seconds plus a separate 20-second reconciliation reserve. Earlier supplied
caller deadlines clip these values, including reconciliation. Submission, polling
and results share the execution deadline; a new stage/poll cannot reset it.
The existing separate cancellation cleanup allowance is at most one second.

Only opted-in publication and existing batch commits can reconcile an expired
result wait. Publication ends at COMMIT and requires no result rows, so terminal
DONE without errorResult on the same allocated parent job can establish success.
The old result loop is fenced before reconciliation. Terminal provider failure,
abort, expired caller ownership, late allocation or unresolved metadata cannot
establish success. Timeout reconciliation never creates or replays a query.
Explicit abort cancels immediately. Late allocation and late metadata/results
remain fenced; unresolved writes retain commit_outcome=unknown.

Publication SQL remains one transaction: prerequisite assertions, materialized
graph, link insert, positive-match assertion, ready snapshot insert, COMMIT.
No intermediate readiness or separately committed graph is introduced. A failed
or unobserved publication must not be retried blindly or activated; inspect the
same job and immutable snapshot state under a separately authorized procedure.

## Render verification command (not executed)

After a separately authorized merge/deployment, confirm the reviewed PR commit is
deployed before running this single preview verification from the existing Render
service repository root, with its existing credentials:

```sh
git rev-parse HEAD
node -e 'console.log(process.env.RENDER_GIT_COMMIT || "unknown")'
timeout --signal=TERM --kill-after=5s 125s node customer-identity/history.js preview --dataset=customer_identity
```

125 seconds leaves 15 seconds beyond the 110-second internal operation bound for
startup, cancellation cleanup and output. The former 45-second outer timeout is
incompatible. TERM reaches the scoped abort controller; KILL is only a final
process bound and cannot prove warehouse termination. Exit 124/137 or any failure
requires same-job metadata diagnosis, not an automatic rerun. Success requires
exit zero and the actual read_only preview envelope with sources and evidence;
child success alone is insufficient.

This command creates only script temporary tables, never persistent evidence or
readiness. It is documentation, not authorization to run preview now. There is no
publication, collection, activation, merge or deployment in this task. Any future
authorized publication wrapper must exceed its 230-second internal bound plus
cleanup/startup (for example 245s with a separate 5s kill grace).

## Validation

The executable acceptance matrix includes customer-history-script-budgets, covering
the 31,321ms simulated timeline, separate settings, ordinary limits, transaction
structure, caller deadlines, cancellation, same-job success/failure reconciliation,
no replay and late polling/allocation fencing. Existing history relational parity,
warehouse, runner and shared query ownership regressions remain applicable.
Local fixture gates do not establish deployed BigQuery success.
