# Durable running state and browser reconnect

Incident: request `e085db3a-f9cb-41f8-9624-ee9a9b8c4aff`, job
`0451b073-06b0-4136-aecd-6c20030cba5d`.

## Demonstrated defects and limits

On base main `e7f537947cb68f1ac8deb1d8330bd4d4a9576db1`, BigQuery ordinary
claim discovery selects queued jobs only. Unlike the memory store, it has no
expired-running-lease reconciliation. An interrupted or otherwise abandoned
worker can therefore leave persisted running state indefinitely. This is a
reproduced infrastructure defect, not proof this worker was interrupted.

The browser's submit catch treated a confirmed submission plus any subsequent
transport exception as `Analysis failed`. Three failed status GETs can reproduce
this false terminal statement while the same job completes successfully.

Worker stop previously only signalled abort; an uncooperative provider kept the
worker waiting until its runtime deadline. The server had no graceful worker
shutdown hook. These are reproduced lifecycle defects, not evidence a deployment
interrupted this production job. The earlier claim 400 cannot establish terminal
failure because the supplied evidence shows a later successful claim.

The bounded incident helper returned `unverified`, `job_dataset_metadata`,
`403`, `EGRESS_FORBIDDEN` in this workspace. Original claim/update timestamps,
lease/heartbeat, execution revision, last provider query, query state, browser
HTTP outcome and independent saved exports are therefore unverified. Diagnostic
revision and shell identity describe the diagnostic runtime, not the old worker.
Neither fixture success nor this PR establishes production incident resolution.

GitHub connector open-PR search found only unrelated product-mapping PR #123;
CLI REST/GraphQL access was forbidden. The branch starts from freshly fetched
origin/main and retains the merged basket/date/completeness/export fixes.

## Shared behavior

- Each ordinary worker tick looks up one expired ordinary lease, then fences its
  terminal reconciliation by observed job ID, claim token and lease expiry.
  Competing reconcilers and stale workers cannot change a newer claim. Saved
  result JSON is retained. Smoke jobs are excluded. Existing contention-only
  retry classification remains unchanged; arbitrary invalidQuery is not retried.
- Expired jobs become `failed / WORKER_LEASE_EXPIRED`. Automatic provider replay
  remains unsupported because execution is not transactional. Polling discloses
  that limitation. Valid saved evidence and XLSX artifacts still recover through
  existing authenticated delivery/export paths. Recovery never creates artifacts.
- A nullable `lifecycle_json` column is added through existing additive job-store
  setup. It contains sanitized claim time, original execution revision, attempt,
  last observed stage, heartbeat and latest recorded query metadata. Ownership
  guards apply to lifecycle writes as well as checkpoints and terminal writes.
  Heartbeats observe liveness; they do not extend leases or prove provider progress.
- Basket and order-value SQL use the shared bounded query helper with server
  deadlines and cancellation of allocated or late allocated query jobs. Other
  providers retain their existing deadlines/cancellation contracts, with the
  shared worker deadline independently bounding all report families. Query-only
  controlled transports explicitly report cancellation unavailable.
- Stop races uncooperative execution against abort, including shutdown during a
  pending claim. SIGTERM/SIGINT stop scheduling, abort execution, allow bounded
  lease-owned persistence and close HTTP, with a 25-second outer shutdown bound.
  Hard termination is reconciled by a later worker after lease expiry.
- Poll failure preserves submission/job references, reports unknown status and
  exposes a bounded read-only Reconnect action. Refresh recovers completed and
  failed jobs. A disconnect never posts cancellation or resubmits execution.
  New question explicitly clears the reference for an independent analysis.

The last query is only one observation: concurrent queries may exist. A missing
stage/heartbeat is `not_recorded`, never an invented failed stage. The diagnostic
labels external results, worker logs and browser HTTP state `not_inspected`;
`no_result` applies only to the inspected durable result field.

## Bounded read-only Render commands

Run from the repository root in the Render shell with its existing configuration.
These commands neither submit jobs nor change storage. The helper has a 25-second
process bound, an 18-second client read bound, a 15-second SQL timeout and a
100 MB billing cap. It inspects at most one job.

```sh
node diagnostics/oracle-analysis-incident.js \
  e085db3a-f9cb-41f8-9624-ee9a9b8c4aff \
  0451b073-06b0-4136-aecd-6c20030cba5d
```

Once lifecycle query metadata exists, optionally inspect only that query's safe
state/timing/error-reason fields with a further five-second metadata bound:

```sh
node diagnostics/oracle-analysis-incident.js \
  e085db3a-f9cb-41f8-9624-ee9a9b8c4aff \
  0451b073-06b0-4136-aecd-6c20030cba5d --inspect-query
```

The current diagnostic source can inspect older job rows without the new column;
missing lifecycle data stays `not_recorded`. Metadata error reasons never include
SQL, exception bodies, prompts, credentials or customers. Query cancellation
acknowledgement does not prove when a query actually stopped. Inspect correlated
Render logs for the exact request/job/worker IDs and the returned time window;
original worker revision, shutdown and HTTP history cannot be reconstructed from
the diagnostic process revision. Independent artifact existence is checked by the
existing authenticated job/export recovery path; it is not inspected by this CLI.

Compare two explicitly invoked snapshots. Unexpired lease plus fresh heartbeat
suggests a live worker, not proof of active retrieval. Expired lease indicates
abandoned ownership awaiting reconciliation. Query metadata may establish
provider RUNNING/DONE/error; missing checkpoints do not prove absence of external
results. A persisted result with failed terminal write is recoverable delivery,
not a reason to rerun providers.

## Acceptance sequence (no deployment performed)

1. Run the read-only commands for the incident and retain sanitized output. Do not
   reset, forcibly finish, requeue or otherwise edit this job.
2. In the authenticated browser, reconnect to the saved job. Check terminal
   status or an explicit unsupported-replay explanation after lease reconciliation.
   Verify isolation from a second authenticated owner.
3. For an authorized new read-only analysis, submit the unchanged production
   basket question once. Observe claim/heartbeat/stage progress and terminal
   delivery; verify 1 January–17 October, exclusion of 1–4 May, UK online GBP,
   reconciled baskets, individual-item cutoff, four bands, separate overlap and
   combinations. Fixture counts are not expected production counts.
4. Download XLSX, open its supporting basket-band/combination tables and compare
   them with the visible evidence. Refresh and confirm the same artifact URL.
5. Disconnect the browser while polling, allow bounded polling to stop, reconnect
   and refresh. Verify the same job/submission and artifact, no duplicate provider
   execution, and no false definitive analysis failure from a transport error.
6. Exercise controlled worker termination/deadline/shutdown in fixtures, never by
   terminating production work for acceptance. Run both required release gates.

## Local validation

- Focused provider/schema/delivery/basket SQL checks: 76 passed.
- Final lifecycle plus shared delivery checks: 37 passed, no skips/cancellations.
- Existing long-running durable job suite plus shutdown regressions: 35 passed.
- Browser release gate: 20 conversations at desktop and mobile sizes passed,
  including forced poll disconnect/reconnect, completed refresh and two failed-job
  refreshes. XLSX was downloaded and opened; provider calls did not repeat.
- Repository `npm test -- --test-reporter=tap`: 1,521 tests, 1,518 passed,
  zero failures/cancellations, three existing opt-in live BigQuery syntax-validation
  tests skipped (annual, generated statements and reconciliation statements).
- `git diff --check` and source syntax checks passed.

Initial focused failures exposed a fixture clock before 17 October and adapters
that supported createQueryJob only for dry runs. The final regression uses a
19 October clock and controlled cancellable query jobs through the production
factory. The schema-count expectation was updated for the additive lifecycle
column. These corrected fixture failures do not establish live provider success.
The initial restricted-sandbox test invocation did not run the transport suite;
all reported transport passes above used the permitted localhost test execution.

Final acceptance release gate: **486 passed**, zero failures, cancellations or
skips (20 central conversations and 24 provider/delivery suites). Final focused
lifecycle confirmation: **12 passed**, zero skips/cancellations. Production
acceptance remains outstanding because live diagnostics were egress-blocked.
