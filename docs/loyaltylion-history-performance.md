# LoyaltyLion history and performance report

This change prepares collection and reporting. It does not deploy, start source
reads, run imports, change points or enable a schedule. Existing reporting still
uses the shared private runtime configuration. Preserve the verified 1–5 November
2026 transaction window and the last complete customer roster.

## Evidence boundary, checked 13 November 2026

Official sources:
- https://developers.loyaltylion.com/api-reference/v2/resources/customers/list-customers
- https://developers.loyaltylion.com/api-reference/v2/resources/transactions/list-transactions
- https://developers.loyaltylion.com/api-reference/introduction
- https://developers.loyaltylion.com/llms.txt
- https://developers.loyaltylion.com/api-reference/v2/resources/orders/list-orders

Customers expose enrolment timestamps, current flags/balances and current tier
membership, with cursor pagination (500/page maximum). Updated-date filters exist,
but filtering updates does not produce a complete replacement roster or detect
all deletions; this implementation deliberately refreshes the full roster daily.
Do not use a partial updated-customer list as the full membership population.

Program transactions expose immutable approved/pending point deltas, cursor
pagination, since_id and half-open created_at filters. Reversals are separate
movements, not updates to previous deltas. This collector uses date windows and
native transaction IDs, preserving all movements. A transfer from pending to
approved is not additional net earning. A claimed-reward movement is not verified
redemption. No customer/order/reward mutation endpoints are enabled. The documented order list only contains orders delivered to LoyaltyLion through integrations/API; it is not a complete replacement for the governed Shopify sales population and its documented response does not establish reward-specific redemption/discount linkage.

The existing verified read_customers/read_orders identity and account/site checks
are reused. The vendor documents 20 requests/sec globally; our cap remains four.
Actual retention, account entitlements, deleted profiles, complete claims without
point movements, tier history and actual reward-use history are not certified by
these list endpoints. Successful exhaustion certifies accessible pages, not the
programme's lifetime completeness.

### Missing export contracts

Ask LoyaltyLion support/account administration for:
1. A complete enrolment/unenrolment/block/deletion history: program ID, native
   customer ID, exact merchant ID with documented namespace, event ID, event type,
   effective timestamp, export generation time and certified coverage.
2. Historical tier assignments: native customer ID, tier ID/name, valid-from and
   valid-to timestamps, event/reversal IDs and coverage.
3. Claims and actual redemptions/cancellations: native claim ID/customer ID/reward
   ID, claimed/used/cancelled timestamps, exact order reference **and namespace**,
   recorded discount amount/currency, state and effective time, coverage.

Request all dates and an explicit statement about deleted customers and retention.
The customer-export job listing is not evidence that these histories are included.
Do not create vendor export jobs automatically. Before implementing an importer,
review a redacted schema and approve exact namespace, correction and coverage rules.
No unverified export format is accepted by this PR. Use structured IDs for future
imports; never store voucher codes, email or arbitrary customer payloads in logs.
Legacy WooCommerce references need a documented namespace and approved identity
bridge; bare numeric similarity and email heuristics are not sufficient.

## Review the history plan first

A separate private plan is required, in addition to the existing account secret.
The example `config/examples/loyaltylion-history-plan.json` is intentionally
`proposed` and cannot run. Its epoch start is a discovery placeholder, not an
assertion that the programme began in 1970. Do not apply that placeholder span.

After operator review, set status to reviewed, record the reviewer/time on the
plan and both profiles, and install it as the Render secret file:
`/etc/secrets/loyaltylion-history-plan.json`.
Keep credentials in the existing environment. Do not replace the account secret,
change its initial_sync or paste private files into chat. The reviewed history
plan authorizes only its resource bounds and date range; it does not enable a cron.

Proposed explicit per-resource invocation profile (not automatically adopted):

| Bound | Value | Interaction |
| --- | ---: | --- |
| Rows | 100,000 | Client refuses more; no partial publication |
| Pages | 250 | At 500/page, row bound normally binds first |
| Calls | 300 | Includes identity/site reads and retries |
| Elapsed source time | 900,000 ms | Includes throttling; external command cap also required |
| Total normalized bytes | 64,000,000 | Refuse the window, do not truncate |
| Each normalized page | 2,000,000 bytes | Each stage parameter stays bounded |
| Requests/sec | 4 | Existing cap; retry attempts consume call budget |
| Transaction window | At most 7 elapsed days | One window per invocation |
| Stage retention | 24 hours | Explicit table expiry, not inherited defaults |

These are ceilings, not targets. The roster has already been observed at 36,670
profiles. A high-volume seven-day transaction window may still exceed a bound.
If so, stop, review a shorter window_days value and rerun an explicit preview.
Do not silently increase a limit. No single command loops indefinitely through
all historical windows. Memory used for native-ID duplicate checks is bounded by
the explicit row cap. Collection + stage queries + promotion may exceed the source
clock; the external 16-minute cap stops the process and uncertain commits must be
reconciled. No timed-out result is automatically treated as failure to commit.

## Exact operator commands after review and deployment approval

All commands run from the Render checkout. Nothing below has been run in production.

### 1. Discover accessible history (no warehouse writes)

Use a reviewed bounds plan; dates are ignored for discovery. This exhausts the
accessible transaction ledger through a captured upper timestamp, or fails closed
at its bounds. It prints counts and earliest/latest accessible dates only:

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 16m \
node loyaltylion/history.js discover --preview
```

Use the observed earliest accessible date, relevant export evidence and the
programme owner's known launch date to review the true historical start. Freeze
an end_exclusive timestamp through which to import. Discovery does **not** modify
or approve the plan. If discovery exceeds bounds, obtain a vendor history export
or supply a verified launch date and review bounded date-window discovery instead;
do not assume the oldest returned page is the beginning.

### 2. Read-only status and next-window preview

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
node loyaltylion/history.js status
```

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 16m \
node loyaltylion/history.js next --preview
```

Status reads complete coverage and aggregate guard state. Next selects the first
uncovered range, stopping at the next covered range or the seven-day cap. It never
uses only the highest checkpoint to declare earlier gaps complete. The existing
1–5 November window is skipped rather than reset. A preview normalizes and validates
all pages in memory, prints aggregate progress and performs no warehouse writes.

### 3. Separately gated setup and one historical window

Only after plan/preview review and explicit production-write approval:

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=true \
node loyaltylion/history.js setup --apply
```

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=true \
timeout --signal=TERM --kill-after=5s 16m \
node loyaltylion/history.js next --apply
```

Rerun status after each successful terminal window. Repeat next preview/apply for
each remaining window only under the reviewed import approval. Staged transactions
and observed claims publish with coverage and a monotonic checkpoint in one BigQuery
transaction. Retries retain immutable existing deltas and reject conflicting hashes.
A repeated window can contain old deduplicated records: fetched row_count is not the
count of newly inserted rows. Old complete coverage and roster snapshots remain.

### 4. Recovery

If a run is interrupted or says publication_submitted/commit unknown:

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
timeout --signal=TERM --kill-after=5s 40s \
node diagnostics/loyaltylion-history-reconcile.mjs RUN_UUID_FROM_OUTPUT
```

This only reads completion-marker/row counts and guard state. One complete marker
is committed publication evidence, not a reason to recollect. Zero markers with a
held guard is **not** proof that the pending query cannot still commit. Inspect the
terminal BigQuery promotion job and ensure all executors are stopped before any
manual guard repair. The tool never unlocks, takes over, deletes stages or replays.
On pre-publication failure, the guard is released when that release is verified;
the previous complete population is untouched. Stages expire after 24 hours.

### 5. Disabled incremental Render cron proposal

Activate only after the history status is complete, live validation succeeds and
an operator approves scheduling. Independently review incremental_enabled=true in
the private history plan. It is false in the example. Collection remains disabled
until the Render flag is explicitly set.

| Setting | Proposed value |
| --- | --- |
| Name | oracle-loyaltylion-daily |
| Schedule | `35 4 * * *` UTC |
| London time | 04:35 GMT / 05:35 BST |
| Build | `npm ci` |
| Command | `node loyaltylion/history.js roster --apply && node loyaltylion/history.js incremental --apply` |
| Config path | `/etc/secrets/loyaltylion-account.json` |
| History plan path | `/etc/secrets/loyaltylion-history-plan.json` |
| Collection | Keep `LOYALTYLION_COLLECTION_ENABLED=false` until activation |
| Reporting | Do not change the existing reporting setting |

Daily roster collection is a complete current population. Incremental transaction
collection resumes from contiguous certified ranges to the captured runtime cutoff,
at most one reviewed window per invocation. If it is more than a window behind,
report the lag and use explicit bounded catch-up; do not silently schedule a history
replay. Immutable transactions do not require revising old deltas; refunds/reversals
arrive as new movements. Mutable actual reward-use history needs its own future
reviewed binding. Watch complete coverage end timestamps, not cron exit alone.

## Oracle report and workbook

`LoyaltyLion performance report` defaults to the last 12 completed London months,
with current month through yesterday separately. Explicit periods and comparisons
use the shared resolver, e.g. `LoyaltyLion performance report compare September 2026
with October 2026`. The report reads retained sources only and never invokes this
collector or customer search samples. The authenticated download uses the existing
owner-scoped retained workbook store, with integrity checks and refresh recovery.

Sheets: Read me, Coverage, Programme usage, Customer purchasing, Enrolment cohorts,
Rewards and purchasing, Tiers, Linkage and limitations (plus Source notes).
Successful sheets survive another section's failure. Missing observations never
become certified zero; all retained purchasing totals remain explicitly observed.

Current roster grouping is a separate, clearly labelled comparison, **not** a
historical membership label. Ambiguous native Shopify identities stay unknown.
Native Shopify orders only are used for purchasing; cross-platform customer
continuity is not assumed. A customer may appear in more than one channel/currency
row, so do not sum customer counts across those groups. Monthly and Full period
rows must not be summed together. Period repeat rate is >=2 orders during that same
row's period, not a lifetime or causal retention rate. Order frequency is per
purchasing customer, not per every roster member.

Cohort zeros include non-purchasers in a mature enrolled cohort, but remain only
observed zeros until sales coverage is certified. The 30/90/180-day cohort includes
only enrolments mature by the report-generation cutoff. Before and after windows
use the same cohort and exact elapsed-day duration. Cohort outcome observation runs
through the generation cutoff, which can be later than the enrolment selection
period. `existing_observed_customer` requires an observed pre-enrolment purchase;
otherwise `prior_history_unverified` is used, never "new customer" without complete
prior evidence. Cohort rows have separate currency/channel populations.

Rates requiring historical observation are blank until reviewed commerce coverage
exists. Do not add certificates merely because a query succeeded. An optional
`performance_coverage` object in the private account config may contain reviewed_by,
reviewed_at and intervals, each with source=`shopify`, channel=`online`/`instore`/
`unknown`/`all`, ISO start_at/end_exclusive and evidence_reference. Verify native
finance/customer/channel completeness, status exclusions, migration policy and the
whole window before certifying. Adjacent valid ranges combine; gaps never do.

Optional `performance_events` contains reviewed_by, reviewed_at and windows with
name (`May Bank Holiday` or `Black Friday`), actual start_date/end_date and an
evidence_reference. Only overlapping reviewed dates are displayed as context;
recurring dates and member/variant participation are never guessed. No control
cohort or adjustment for tenure/promotion is claimed by this initial report.

To validate the retained binding before using the workbook, without collection:

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 120s \
node diagnostics/loyaltylion-performance-validate.mjs 2026-11-01 2026-11-05
```

This prints aggregate linkage reasons, not native IDs/customer data. It can explain
missing order, missing customer/channel evidence, migrated/cancelled/ineligible
orders and customer mismatches. Old normalizations cannot distinguish an invalid
original order reference from an originally absent one; disclose this gap rather
than retroactively inventing a namespace.

## Retention and backups

Provisioning and every publication verify dataset defaults and permanent tables
have neither table nor partition expiry; they refuse unsafe settings without
silently changing them. No production history is replaced or expired by this PR.
Keep separate administrator-reviewed cross-project/dataset snapshots or exports
with their own no-expiry policy, and periodically restore into a separate recovery
dataset to verify row counts, IDs and coverage markers. Back up data, coverage,
checkpoints and schema together. A guard copied in a backup must never be used to
resume a writer without reconciliation. Staging expiry is intentional; permanent
history expiry is not. Existing recovery procedures remain applicable.
