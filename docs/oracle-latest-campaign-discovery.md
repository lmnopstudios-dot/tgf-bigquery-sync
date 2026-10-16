# Oracle latest sent campaigns

Base: latest fetched `origin/main` d8341eb (merged #324), including merged #323
5e41346. Shared calendar resolution, explicit subject switching, governed evidence
validation and the persistent acceptance gate are retained.

## Demonstrated defects and production uncertainty

* `collectMetadata` classified every nonempty `send_strategy` as recipient-local,
  even `{method:'static'}` with a valid source `send_time` on a sent campaign.
  This discarded actual-send semantics. The schema already stores send time,
  semantics, status, parent identity, message IDs and retrieval time; no new
  storage columns are necessary. The strategy object itself is not persisted,
  so old rows alone cannot prove which strategy caused a rejection.
* The production dependency factory previously bound only a persisted
  `entity_metadata` reader. It had no on-demand campaign discovery, so stale or
  incorrectly classified persisted metadata could not recover during a question.
* Boundary ties blocked deterministic selection. Single and multiple campaign
  selection now use the same timestamp/identity ordering.
* “Compare with the previous three” advanced to the previous set instead of
  retaining the selected set for comparison. A newly retrieved snapshot could
  also replace selected metadata and fail evidence scope validation. The
  original selected snapshot is now retained.
* The shared presenter promoted technical reporting definitions into the main
  answer and formatted money without a fixed two decimal places.

Bounded production probes in this workspace returned a denied warehouse read
(403 classified as read access unavailable) and Klaviyo NETWORK failures. Both
native fetch and Node's supported environment-proxy transport were attempted.
Credentials are configured, but environment readiness was unknown. No private
payload or exception text was printed. These results do **not** establish that
production source send times are absent, that IAM alone caused the warehouse
failure, that the deployed revision matches main, or that production reports are
fresh. No live campaign identity or performance was verified. Fixtures establish
the code defects and regression behavior, not live readiness.

## Shared path and semantics

`analysis-context` / `campaign-context` resolve entity-relative scope before date
clarification. `provider-dependencies` supplies the same Klaviyo service to
server direct, interactive and durable execution. With the configured private
key it uses `klaviyo/campaign-discovery`, the existing bounded Klaviyo client and
`/api/campaigns` email filter, following pagination to completion. It does not
rely on the API's listing order. Failure or a pagination bound never yields a
partial latest ranking and never silently falls back to stale metadata. Without
a configured key, the existing persisted metadata reader remains available.
Its freshness must be established by diagnostics; it is not proof of live source
completeness.

The source parent campaign `send_time` is accepted only with sent/sending status
and an absent, immediate or static non-recipient-local strategy. Strategy option datetimes, campaign creation,
update times and revenue never establish send ordering. Distributed/recipient
local, smart and unknown strategy methods remain guarded. The campaign identity
is account + channel + parent ID. All eligible candidates must have verified
metadata; any missing or conflicting timestamp blocks newest selection.

* Draft, cancelled, scheduled, unsent, flow and future-send candidates are excluded.
* Ongoing `sending` campaigns are eligible with a verified timestamp; the table
  marks them as sending/provisional. The source timestamp is not a completion
  time and does not verify that all recipients have received the campaign.
* Equal instants use campaign ID ascending; comparison groups use the same order.
* Included A/B variants and multiple messages do not become campaigns. Their
  message-level metrics remain grouped by parent and conversion population.
* Resends with distinct parent IDs are separate campaigns. Repeated messages or
  resend variants within one parent count once; no separate send execution is
  inferred. Conflicting parent timestamps fail closed.
* Retained selections and cutoff survive ranking, since-send, refresh, retry,
  export and durable recovery. Explicit incompatible subjects clear that context.
* Performance comes from governed `message_performance` and `window_coverage`.
  A campaign-specific read always carries parent ID, account and email channel.
  Failed or absent evidence for one campaign does not discard supported others.
  Separate currency/conversion populations are never added together.

Discovery requires no collection, backfill or scheduling. The changed collector
normalizer will apply if collection is separately authorized later; no historical
rows are repaired by this PR. The existing schema can store the corrected
semantics unchanged. Latest performance is constrained by existing collected
calendar-month windows and their retrieval age. Discovery does not make missing
recent performance available. Exact post-send slicing and equal elapsed windows
remain unsupported. Attribution settings, supported cutoffs, currencies,
provisional maturity and message-level denominators are disclosed in Show details.
Klaviyo credited revenue is not causal incremental sales.

## Deployment/setup dependencies

Deploy the reviewed code through the normal release process, separately from this
change. Bind the same governed account's `KLAVIYO_PRIVATE_API_KEY` and pinned
`KLAVIYO_API_REVISION` used by the collector (currently 2026-07-15); its campaign
read permission must cover campaigns and included campaign messages. Keep the
single-account/email binding aligned with `config/klaviyo-account.json`.
Provide outbound HTTPS access to a.klaviyo.com. The warehouse principal needs
read access to dataset metadata, `klaviyo.entity_metadata`,
`klaviyo.message_performance`, `klaviyo.window_coverage`, and permission to run
bounded query jobs. Performance freshness depends on existing authorized
collection; any repair or collection needs separate authorization. No schema
migration or schedule activation is required for discovery.

Discovery bounds per resolution: 20 pages, 2,000 campaigns, 24 HTTP calls, no
retries, 8-second request timeout and 20-second elapsed budget. A bound requires
narrower identity selection or a separately reviewed capacity change; it cannot
prove latest ordering from the enumerated subset.

## Exact bounded read-only Render commands

Run in the deployed Render service shell after the proposed revision is available
there. Do not echo environment variables or run collector/refresh/backfill scripts.

```sh
# Confirm the deployed code without printing credential configuration.
git rev-parse HEAD
# Plan only: no remote reads.
node diagnostics/oracle-campaign-dependencies.js
# Source + storage + actual production-factory selection/performance reads.
timeout 65s node diagnostics/oracle-campaign-dependencies.js --execute-read-only
```

The executing probe permits at most eight SELECT/WITH query calls (1 GB billed
per query), 40 API calls shared by source and factory probes, 20 pages per
listing, and a 60-second work deadline. Individual warehouse operations have
15-second deadlines. The outer timeout bounds process lifetime, including SDK
cleanup/retries. The probe emits only stage/code/status, aggregate coverage,
metadata age and SHA-256 identity correlations. It performs no Oracle job writes
and no collection or source writes. Successful script completion alone is not
readiness: inspect every stage. Readiness requires complete discovery, three
verified selected identities, performance reads or explicit coverage gaps, and
passing deployed acceptance conversation/delivery.

If Render uses an explicit environment HTTP proxy with Node 24+, use its
supported transport without changing inherited proxy values:

```sh
timeout 65s env NODE_USE_ENV_PROXY=1 node diagnostics/oracle-campaign-dependencies.js --execute-read-only
```

## Acceptance conversation (fixture example; not production results)

User: **How did the last 3 Klaviyo campaigns go?**

Oracle: Here is the available performance for the three most recently sent
campaigns. Recent results may still be provisional.

| Campaign | Actual send (UTC) | Delivered | Click rate | Attributed conversions | Attributed revenue |
|---|---|---:|---:|---:|---:|
| Campaign 1 | 2026-09-28 23:30 | 100 | 12% | 3 | 30.00 GBP |
| Campaign 2 | 2026-09-27 23:30 | 100 | 12% | 3 | 30.00 GBP |
| Campaign 3 | 2026-09-26 23:30 | 100 | 12% | 3 | 30.00 GBP |

Show details: actual-send ordering, observation cutoff 2026-10-09 12:00 UTC;
Europe/London calendar-month evidence through 30 September, retrieved 1 October;
fixture attribution setting 5-day click/open, not proof of historical settings;
message-level click denominator; credited revenue is not incremental sales;
unequal attribution ages and no exact post-send slicing.

User: Which performed best?
Oracle: Retains c1/c2/c3. Compares observed attributed revenue within each currency
and conversion population; it cannot infer a mature or causal winner.

User: Since they were sent.
Oracle: Retains c1/c2/c3, uses their send dates to choose supported monthly windows,
and explains that exact post-send slicing is unavailable.

User: Compare with the previous three.
Oracle: Retains c1/c2/c3, discovers c4/c5/c6 using actual send order and compares
both groups without duplicate parent campaigns.

User: Export that.
Oracle: Produces the owned workbook containing those same six identities,
report windows, separate currencies, unavailable cells and definitions. Recovery
and repeated owned downloads do not rediscover or change the selection.

User: Show mobile and desktop conversion rates this year.
Oracle: Clears incompatible campaign scope and uses the shared conversion path.

## Verification results

* Final `npm run test:oracle:acceptance`: 329 passed; zero failed, skipped or
  cancelled; 10 central conversations and 15 registered provider/delivery suites.
* Final browser gate: 10 conversations on desktop/mobile passed, including the
  production-factory latest-three table, ranking follow-up, visible currency,
  expanded causal/coverage definitions and durable refresh recovery.
* Final `npm test -- --test-reporter=tap`: 1,363 total, 1,360 passed, zero failed
  or cancelled, three opt-in live BigQuery syntax validations skipped (annual,
  shipping and reconciliation statement validation).
* Focused campaign/discovery/legacy continuity suite: 119 passed. Subsequent
  strategy-only verification: six passed, including static recipient-local
  exclusion and immediate-source timestamps. The final gate/full suite include
  these regressions and the successful central conversation.
* Diagnostic plan, source syntax and `git diff --check` passed. Live read-only
  probes were attempted, but source/storage access failed as described above.
* Intermediate gate/full-suite attempts found two legacy tests requiring a send
  date prompt. Their assertions now require the metadata limitation without a
  send-date request; explicitly supplied legacy dates for a retained identity
  remain supported. Final reruns above passed. Initial sandboxed HTTP tests
  could not bind localhost; they were rerun successfully with localhost access.

Direct/shared, interactive and durable provider tests assert ordered IDs,
production-factory API calls and pagination, campaign SQL predicates, scoped
report arguments, separate populations, partial failures, presentation, actual
workbook bytes, ownership, idempotency and recovery. Existing date clarification,
product reporting and conversion suites remain in the gate/full suite. Local
fixtures and browser success do not establish deployed production readiness.
