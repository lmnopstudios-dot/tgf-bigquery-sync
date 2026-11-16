# Shopify customer linkage: catch-up and incremental collection

## What failed

The supplied 16 November audit showed 3,336 missing `order_customers` records:
16 in September, 1,416 in October and 1,904 in the November portion checked
(through 14 November). A subsequent 1 October GBP preview identified 35 IDs.
Finance and channel rows existed for that retained population; no finance or
channel rows were missing from the union inspected. This is not proof that all
Shopify orders exist in the warehouse.

The repository had a customer `--scheduled` implementation but no customer Render
cron in `render.yaml` or active customer source in the freshness runner. Only one
September repair appeared in the supplied customer manifests. The old repair SQL
also wrote the same watermark that scheduling used. A one-day repair could therefore
skip an unrepaired historical interval. Source retention and customerless POS orders
are separate questions; do not equate a missing row with a genuine guest order.

## Changes and explicit limits

`shopify/customer-refresh.js` has independent plan, preview, setup, catch-up,
bootstrap, scheduled and check modes. The old `customer-recovery.js` plan/verify
commands still work; its unguarded write entry points now refuse execution.

- A catch-up repairs **missing rows for exact native finance-known order IDs**,
  across all channels and currencies in explicit exclusive timestamp bounds. It
  does not infer customer IDs from names/emails, omit guests or change the
  incremental state. Guest orders receive a real row with a null customer ID.
- The new scheduled key is `shopify_customer_incremental_v2`. Legacy repair and
  scheduled watermarks are ignored. Bootstrap requires a successful new catch-up
  run, zero remaining missing rows in that catch-up's window, and an explicit
  updated-order window starting no later than the catch-up started. It cannot
  overwrite an existing new watermark. The created-date baseline remains a
  **retained finance-known population**, not certified complete Shopify history.
- Scheduling reads updated orders with a 48-hour overlap and a frozen end time.
  Cursor exhaustion is required. Rows and the successful run/watermark publish in
  one transaction, guarded by the expected prior watermark and held lock. Catch-up
  and scheduled modes share one guard; there is no automatic expired-lock takeover.
- Limits: 5,000 rows, 100 pages, 120 API attempts, 20 MB decoded responses, 15 minutes,
  50 IDs/page, at most four attempts/second and two bounded retries for throttling or
  specified transient network errors. Maximum explicit window: 92 elapsed days.
  These are reviewed bounds for this new collector, not an automatic increase of
  the old 500-ID repair limit. Larger populations fail; review smaller explicit
  windows instead of raising caps automatically.
- Warehouse queries use dataset metadata location, 1 GB maximum billed per query
  and 30-second server job limits. The overall external command has a separate
  16-minute wall-clock deadline. Source and warehouse permissions remain required.
  Older orders may require Shopify `read_all_orders` in addition to existing order
  and customer evidence access. No scopes are changed by this PR.
- Progress logs start immediately and continue every page / 15 seconds during a
  run. Output contains counts, phase, elapsed time, safe codes and run IDs. Raw
  orders, names, customer IDs and credentials are not printed. Temporary NDJSON is
  private (0600); staging tables expire in 24 hours. Stages may remain for recovery
  after a failure. Successful stages receive best-effort cleanup.
- Permanent destination, runs, state, guard and baseline-lineage tables must have
  no table/partition expiry. Dataset expiry defaults must be unset. Setup creates
  controls with explicit no-expiry settings; it does not clear unexpected expiry
  or mutate dataset defaults silently.

## Rollout: separate review, collection and activation

Nothing in this PR deploys, executes a production catch-up or activates a cron.
Do not run the broad legacy `server.js` Shopify truncate/import path. It does not
provide the atomic baseline needed by this workflow.

### 1. Review and deploy code with both crons disabled

Wait for the PR acceptance and browser checks. Deploy only after normal review.
The proposed cron services have `SHOPIFY_CUSTOMERS_ENABLED=false`, so their
scheduled invocations exit without collection. Keep the existing finance,
catalogue, order-line and LoyaltyLion jobs unchanged.

### 2. Read-only plan and Shopify preview, from the deployed Render shell

These bounds cover **1 September through 15 November inclusive, London**. September
begins at 23:00 UTC on 31 August. This includes one more November day than the
supplied audit, so the current count may differ from 3,336. All presentment currencies
and channels are included; no per-day manual command list is required.

```bash
timeout --signal=TERM --kill-after=5s 75s \
node shopify/customer-refresh.js plan \
  --start 2026-08-31T23:00:00Z --end 2026-11-16T00:00:00Z
```

The plan prints the missing count and a hash of the ID set, never raw IDs. If the
count exceeds 5,000, stop and review smaller windows. The count does not establish
full commerce coverage.

```bash
timeout --signal=TERM --kill-after=5s 16m \
node shopify/customer-refresh.js catchup --preview \
  --start 2026-08-31T23:00:00Z --end 2026-11-16T00:00:00Z
```

Preview retrieves current Shopify customer/status/app evidence, fully validates it,
and reports row/guest/page/call counts without setup, staging, publication or a
watermark change. A missing/inaccessible ID blocks publication; do not skip it.
Review both results before approving collection. Current eligibility fields do not
prove historical customer/order status.

### 3. Only after approval: setup and catch-up

```bash
SHOPIFY_CUSTOMERS_ENABLED=true \
node shopify/customer-refresh.js setup --apply
```

```bash
SHOPIFY_CUSTOMERS_ENABLED=true \
timeout --signal=TERM --kill-after=5s 16m \
node shopify/customer-refresh.js catchup --apply \
  --start 2026-08-31T23:00:00Z --end 2026-11-16T00:00:00Z
```

Save the successful `run_id`. The script recalculates the bounded target population
before collection and reports the actual count. It leaves every scheduled watermark
unchanged. Rerunning a terminal successful catch-up is idempotent by native order ID,
but never replay an uncertain run automatically.

Repeat the read-only **plan** above: expect zero *missing rows*. Genuine guests may
still have null customer IDs; these are not unresolved collector records.

### 4. Only after review of zero remaining rows: establish an updated-order baseline

Replace the run UUID below with the successful catch-up run ID. Do not use the old
September repair run. The explicit 14 November start overlaps the collection period
and the end is frozen immediately before invocation. If using this runbook after the
92-day bound, stop and prepare fresh reviewed bounds.

```bash
cutoff=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SHOPIFY_CUSTOMERS_ENABLED=true \
timeout --signal=TERM --kill-after=5s 16m \
node shopify/customer-refresh.js bootstrap --apply \
  --catchup-run REPLACE_WITH_SUCCESSFUL_CATCHUP_UUID \
  --start 2026-11-14T00:00:00Z --end "$cutoff"
```

This reads updated orders through the fixed cutoff and publishes the new baseline,
linkage rows and watermark atomically. It refuses a gap after the catch-up started,
an incomplete catch-up, an existing new state, duplicate IDs or incomplete pagination.
It does not certify earlier created-order history or modify LoyaltyLion coverage.

### 5. Separately approve cron activation

| Render setting | Customer collector | Independent check |
| --- | --- | --- |
| Name | `oracle-shopify-customers` | `oracle-shopify-customers-check` |
| Runtime | Node | Node |
| Build | `npm ci --ignore-scripts` | `npm ci --ignore-scripts` |
| Command | `node shopify/customer-refresh.js scheduled --apply` | `node shopify/customer-refresh.js check` |
| Schedule, UTC | `47 */2 * * *` | `57 */2 * * *` |
| Default enable flag | `SHOPIFY_CUSTOMERS_ENABLED=false` | `SHOPIFY_CUSTOMERS_ENABLED=false` |

Copy the existing authorized BigQuery and Shopify connection settings listed in
`render.yaml` to the collector. The check needs only the BigQuery settings. Do not
copy credentials into source files. After the bootstrap is verified and activation
is approved, set the enable flag true on both services. A scheduled run may write
without clicking Trigger Run. UTC schedules shift one London clock hour during BST;
watermarks are UTC instants, not local calendar dates.

Read-only validation (this does not activate a cron):

```bash
node shopify/customer-refresh.js status
```

The enabled `check` exits nonzero for an unreconciled/over-20-minute held guard, missing new baseline, a watermark
more than four hours behind, unfinished runs, unexpected expiry or finance-known
orders still missing customer rows beyond a four-hour arrival grace. A matching running job younger than 20 minutes is shown as in progress, not a
completed collection or a stale-lock alert. Fresh repair
rows cannot refresh the new scheduled watermark. A check failure should be routed
through Render's existing failure notifications. No new recipient or external
notification configuration is created by this PR.

`npm run audit:freshness` also exposes `shopify_customers`, its native successful
runs and whether a new scheduled execution was observed. A current row timestamp is
not proof that a schedule exists. Inspect the independent check as well as the generic
source freshness output.

## Failures and recovery

Before another writer, run `node shopify/customer-refresh.js status` and inspect the
reported guard holder and run IDs. If the run failed before publication and its failed
marker/release committed, the next reviewed attempt may proceed. A missing record or
an old lock is not permission to unlock.

If transaction submission timed out or its acknowledgement was lost, the stage is retained and no client-side guard release is attempted. The
transaction may have committed and released its guard, or the guard may still be held. Do not assume failure or replay, delete tables, or clear state.
Reconcile the original BigQuery job, run marker, destination rows and state `run_id`.
A successful atomic commit has a succeeded manifest, released guard, and (for
bootstrap/scheduling) matching new state. A running marker/held guard is unresolved;
keep other writers stopped and prepare a reviewed recovery after proving the original
job terminal. This PR intentionally supplies no automatic unlock/force-bootstrap.
Expired stages do not resolve an uncertain transaction. Stop the service before the
24-hour stage retention expires if investigation is needed.

## Oracle validation after successful collection

Run the aggregate commerce diagnostic again with the same bounds. Missing customer
**rows** should disappear where repair succeeded. Genuine customerless orders, unknown
channels and absent/ambiguous LoyaltyLion roster matches remain explicit. Then request:

```text
LoyaltyLion performance report
```

Verify October/November observed purchasing rows now appear where qualifying customer
links exist. Cohort rates remain withheld until the independent commerce-history
certification requirements are met. This catch-up does not discover finance-absent
orders, reconstruct historical tiers, refresh the LoyaltyLion roster, establish actual
voucher use or prove incremental loyalty impact.
