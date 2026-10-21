# Customer history commit reconciliation

The supplied 2026-10-21 exact-job evidence reports:

- history_d4471e2ac16642f8b9ceef6f4df15aa8: DONE, no errors,
  30,821ms execution, 32ms creation-to-start.
- history_d04a714331ef40508b54f8ccf68b817c: DONE/stopped,
  21,753ms execution, 32ms creation-to-start, user cancellation.
- Both configured jobTimeoutMs=20000.

A server timeout is not an exact completion bound. Client cancellation can race
successful completion. These observations justify reconciliation, not increased
server limits, larger batches, or a quota diagnosis. The individual slow script
statement has not been established by the supplied summary.

## Change

Only history batch_commit opts into reconciliation. On client deadline, the old
result loop loses ownership before a separate metadata-only observation window
starts, using the same existing 20-second bound. The allocated job ID is reused;
no new submission is made. This permits observing the reported 30.8-second success
without changing execution settings. DONE without error is sufficient here
because batchMergeSql ends at COMMIT TRANSACTION, with no subsequent statements
or exception handler that could hide a failed transaction. Other scripts do not
inherit this result-free success contract.

DONE with error preserves provider errors and stops without redundant cancellation.
It conservatively leaves commit_outcome unknown: stopped alone is not an atomic
checkpoint observation. Nonterminal/unavailable metadata after the observation
window triggers the existing bounded cancellation path and unknown outcome.
Explicit signals cancel immediately; reconciliation never overrides an abort.
Late metadata/results cannot start further polling after ownership ends. Submission
timeouts before allocation retain the existing late-allocation cancellation path.

No transaction SQL, expected-cursor assertion, deduplication, limits, stage TTL,
checkpoint key, page size or production records change. No automatic retry is added.

## Recovery review (do not unlock or restart as part of this patch)

1. Preserve the original metadata and runner logs. Verify exact parent SQL against
   batchMergeSql and its private selection parameters if provenance remains in
   doubt. No-error DONE proves commit only for the verified script contract.
2. Keep a submission barrier across all executors and identities: prevent new
   submissions, drain outstanding creation RPCs and delayed callbacks, and
   reconcile known submissions to terminal jobs. Read the authoritative checkpoint for WW /
   metorik_orders / customer_identity / history-20261020-v2 / 1900-01-01 through
   2026-10-19. Require exactly one compatible row. Do not derive its cursor from
   runner totals or provider-record counts.
3. Both supplied jobs are terminal, but independently check current pending/running
   work across all relevant hosts and identities. The existing recovery diagnostic
   without confirmation can inspect the checkpoint/current identity; its historical
   incident window describes an older failure, not these two exact jobs.
4. If the stopped script's transaction outcome is needed, inspect bounded child
   metadata for that exact parent and transaction/COMMIT evidence. A stopped parent
   alone does not justify manually rewinding the cursor or replaying its page.
5. After separate deployment review and operator-confirmed quiescence, rerun fresh
   recovery checks. Any future authorized resume must use the unchanged selection
   and saved checkpoint. Never edit/rewind progress, delete evidence or blindly
   resubmit the uncertain transaction. No unlock or restart is authorized here.

## Review scope and local validation

The complete change includes the two implementation files, warehouse regressions,
this recovery document, the exact-job diagnostic and its tests, and the persistent
acceptance matrix. The earlier implementation-only summary was incomplete: the
warehouse regression was a tracked modification, while this document and the
metadata diagnostic/test were untracked and absent from ordinary git diff output.
All seven files belong in the review and commit.

Call-site audit: only historyQuery with write=true and stage=batch_commit supplies
reconcileDeadline; the only production caller is commitBatch in history.js. Roster
bulk scripts, publish scripts, reads, query-only test transports, load jobs and
ordinary shared boundedQuery callers retain their original deadlines and cleanup.
Regressions explicitly verify other history stages, read-only batch_commit,
provider failures, explicit abort, terminal stopped, same-job success after client
wait expiry, and late metadata fencing. The two new test suites are registered in
the persistent acceptance matrix.

Completed on the final code based on main 1222a9492de25d4e2ececefe6ffd3274754caef1:

- Focused history/recovery/runner/query-ownership suites: 94 tests passed,
  zero failures/cancellations/skips.
- npm run test:oracle:acceptance: exit 0, 648 tests passed, zero failures,
  cancellations or skips; 21 central conversations and 40 regression suites.
- ORACLE_BROWSER_DRIVER=/opt/codex/cua_node/lib/node_modules/playwright-core/index.mjs
  npm run test:oracle:browser: exit 0, 21 conversations, desktop/mobile, durable
  refresh and activated identity refresh passed. Installed driver 1.57.0 and
  /usr/bin/chromium were used via the repository-supported driver override; no
  repository dependency or lockfile changes were required.
- git diff --check passed.

The earlier terminated acceptance run is a failure, not a pass. Its empty report
was inconclusive. Reproduction established environment constraints: default
sandbox loopback listen returns EPERM, and a minimal piped Python spawnSync
fixture returns ETIMEDOUT. The same subprocess and migration suite pass with
network permission enabled (migration: six tests, zero failures/cancellations).
The bare browser import initially failed because playwright-core was not in the
project module path, although the installed driver above was available. Both
required gates completed with network permission for their local HTTP fixtures;
no production provider was called, test assertion removed or gate weakened.

Full local logs are /tmp/oracle-acceptance-gate.tap,
/tmp/history-review-acceptance-final.log and /tmp/history-review-browser-final.log;
screenshots are /tmp/oracle-acceptance-browser. These are workspace artifacts,
not durable repository attachments. Production verification and the individual
slow warehouse statement remain unverified. No deployment, production writes,
incident cancellation, lock removal or collector restart occurred.
