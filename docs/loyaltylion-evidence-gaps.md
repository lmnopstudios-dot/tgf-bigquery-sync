# LoyaltyLion evidence gaps: rollout and validation

## What is established

The supplied 15 November 2026 workbook describes a complete **11 November**
customer snapshot with **6,703 enrolled profiles**. That is a dated current-roster
observation, not today's programme population. Its certified points windows run
from 17 July to **13 November 2026 at 17:29 UTC exclusive**, a partial day.
The requested completed year is 1 November 2025–31 October 2026, with
1–14 November separately. These supplied facts are not new production verification.
No points before/after those certified windows have been inferred or collected.

A bounded read-only warehouse attempt in this workspace on 15 November returned
**HTTP 403 at `shopify_data` dataset metadata lookup**. No order query ran and no
production completeness claim is made. The private programme configuration is
also absent here. Re-run the command below with the authorized reporting identity
and existing private configuration. No public config, evidence certificate,
feature flag, schedule, points/balance, inventory or permanent retention setting
was changed. Nothing was deployed, collected, backfilled or automatically replayed.

## Exact source and eligibility trace

`oracle/loyalty-performance.js:performanceOrderSources` is now shared by the report
and the monthly audit. Its retained source population starts with latest
`synced_at` rows of `shopify_data.order_financials`, with deterministic row-JSON
tie-breaking; `order_customers` and `order_locations` use the same deduplication.
All joins use exact `gid://shopify/Order/...` and `gid://shopify/Customer/...` values.
There is no email/name, stripped-number or cross-platform identity matching.

The shared `qualifyingCustomerOrderPredicate` requires a nonempty customer ID,
noncancelled order, paid/partially-paid/partially-refunded status and original
shop-currency value greater than retained refunds. Known Matrixify copies
(`gid://shopify/App/1758145`) are excluded if either customer or location evidence
identifies them. Missing app evidence is not proof of native provenance. Original
presentment gross, including shipping/tax, supplies AOV; refunds are separate
lifetime retained amounts. Online Store maps to `online`, Point of Sale to
`instore`, all other/missing channel evidence remains `unknown`. Currencies stay
separate. Missing customer/status evidence cannot satisfy eligibility. Duplicate
roster Shopify identities are excluded from cohort joins and grouped as unknown
in observed purchasing. Missing/deleted roster profiles are also unknown.

The audit unions IDs from **all three sources** to expose missing finance as well
as missing linkage/channel evidence, by London month/channel/currency. It checks
native namespaces, missing customer IDs, ambiguous/absent roster links, migration
exclusions, cancellations, qualifying counts, monetary nulls and observed/sync
bounds. Missing monthly rows mean no retained observations, not certified zero
orders. Source or query failures remain independent, explicitly unavailable.

`server.js:getAllOrders`, `getAllOrderFinancialsAndRefunds` and `syncShopify`
retrieve separate paginated populations and replace the three permanent sources
in separate truncate/insert operations. This legacy path retains no atomic,
per-window completion manifest covering all three tables and can expose partial
replacement on failure. **Do not run it as remediation.** This is a concrete
collector/evidence design gap, not proof that this workbook lost particular orders.

`shopify/finance-refresh.js` checks pagination, stages location/finance/refunds and
commits with `finance_refresh_runs`/`finance_refresh_state`. Its windows select
**updated_at**, not created_at, and it does not collect customer linkage.
`shopify/customer-recovery.js` checks ID batches or updated-order pagination and
retains `customer_refresh_runs`/`customer_refresh_state`; an ID repair covers only
its requested IDs. An updated-order watermark, successful pages, a finance-only
manifest, a latest order date, or a nonempty month cannot certify complete
order-created purchasing coverage. Controls can also survive later legacy source
replacement, so reconcile them against the retained IDs and later writers.

**Missing proof:** a completed baseline order-created population through a fixed
cutoff, source access/retention evidence, and reconciled native ID/eligibility/
channel coverage of all three retained tables, plus contiguous update coverage
through that cutoff. The precise affected live months/IDs remain unknown because
metadata access was denied. Do not invent them. In particular, November 2025
cannot be assumed fully covered by native Shopify evidence (other repository
contracts describe native evidence beginning 16 November). Woo history and
Matrixify copies do not silently fill that gap.

## Read-only aggregate diagnostics

From the reviewed checkout in an authorized runtime:

```bash
# No remote access: prints bounds only.
node diagnostics/loyaltylion-commerce-coverage.mjs

# Four SELECTs, <=1 GB billed each, <=15 s each, 65 s total; <=380 days.
# This also includes the 1–14 November observation portion.
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 75s \
node diagnostics/loyaltylion-commerce-coverage.mjs \
  2025-11-01T00:00:00Z 2026-11-15T00:00:00Z --execute-read-only

# Existing report path: section/aggregate/linkage status, no workbook/job creation.
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 120s \
node diagnostics/loyaltylion-performance-validate.mjs 2025-11-01 2026-10-31
```

The first command never certifies from its row counts. Review missing months and
sources, failed/nonterminal manifests, unresolved IDs and joins against the actual
source baseline/access evidence. Audit earlier/later bounds separately when a
cohort requires them, with the same limits. Never widen points history to do so.
Only after full reconciliation may an operator review existing private
`performance_coverage` intervals, reviewer/time and a durable evidence reference.
Use exact exclusive timestamps, appropriate channels and gaps; do not backdate or
extend certification to report time. The report binds those reviewed intervals,
clips them at generation time, and displays them separately from observed orders.

## Bounded roster refresh, separate preview and apply

Reuse `loyaltylion/history.js roster` with the existing reviewed private history
plan and staging profile. **Do not change the plan's transaction dates or enable
incremental collection.** `roster` selects only customers, even with incomplete
points history. It never invokes `next`, `incremental` or history replay.

```bash
# Reads all roster pages within the already reviewed page/row/call/byte/time caps;
# warehouse access is read-only guard/coverage inspection; no staging/publication.
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=false \
timeout --signal=TERM --kill-after=5s 16m \
node loyaltylion/history.js roster --preview
```

Review counts, terminal cursor, site/namespace checks, existing guard and bounds.
A count change from 6,703 enrolled customers is not inherently an error; the full
roster includes other profiles. Duplicate/native-ID/normalization failures must
fail the run, not truncate it. Preview never promotes anything.

**Only following separate operator authorization for production collection:**

```bash
LOYALTYLION_CONFIG_PATH=/etc/secrets/loyaltylion-account.json \
LOYALTYLION_HISTORY_PLAN_PATH=/etc/secrets/loyaltylion-history-plan.json \
LOYALTYLION_COLLECTION_ENABLED=true \
timeout --signal=TERM --kill-after=5s 16m \
node loyaltylion/history.js roster --apply
```

Pagewise private stages expire in 24 hours. Cursor exhaustion, normalization,
row/duplicate/guard checks and no-expiry validation precede transactional
snapshot + complete-marker publication. Previous complete snapshots are retained;
a failed refresh leaves the report on the previous complete snapshot. Collection
`observed_at` is captured independently of report `as_of`; the workbook displays
both and flags snapshots older than a day. Do not kill/retry a suspected commit:
use `diagnostics/loyaltylion-history-reconcile.mjs RUN_UUID` from the existing
runbook, inspect terminal publication status and retain the guard while uncertain.
Never unlock/replay automatically. Permanent history and no-expiry guards remain.

## Commerce remediation only if the audit identifies a bounded gap

**Customer writes below are superseded:** the dedicated [customer automation runbook](shopify-customer-automation.md) now owns guarded catch-up, bootstrap and scheduling. Legacy `customer-recovery.js` plan/verify remain read only; its apply/scheduled commands fail closed to prevent watermark poisoning and writer races. Do not use the old write examples below.

No commerce collection is authorized or run by this change. Resolve access first;
403 is not an empty source. For a **confirmed** small missing `order_customers`
population, use the existing read-only plan for one date/currency slice (example
bounds below are illustrative, not diagnosed missing dates):

```bash
node shopify/customer-recovery.js --start 2026-11-12 --end 2026-11-12 \
  --currency GBP --max-ids 100 --max-retries 1
# Separate authorized apply for that same reviewed slice only:
timeout --signal=TERM --kill-after=5s 120s \
node shopify/customer-recovery.js --apply --start 2026-11-12 --end 2026-11-12 \
  --currency GBP --max-ids 100 --max-retries 1
```

The existing recovery planner includes native order IDs; keep that output private.
It refuses populations above the cap and will not promote unresolved IDs.
It repairs finance-known missing linkage only; it does not discover finance-absent
orders or repair every stale eligibility record. Repeat the aggregate audit after
a terminal successful repair; do not infer full history from it.

For a confirmed missing **update** slice in finance/location evidence, first run
`node shopify/finance-refresh.js --mode preflight`. Only after separate collection
approval, a bounded example is:

```bash
timeout --signal=TERM --kill-after=5s 120s \
node shopify/finance-refresh.js --mode collect \
  --start 2026-11-12T00:00:00Z --end 2026-11-13T00:00:00Z --max-pages 20
```

An incomplete page budget must fail; never raise it automatically. This does not
supply a missing created-history baseline or customer evidence. If the baseline
proof is absent, prepare a separately reviewed staged baseline collector/export
contract with creation bounds, frozen cutoff, complete pagination/source IDs,
three-source reconciliation and atomic manifests before any backfill. Existing
commands cannot truthfully manufacture that certificate. No broad legacy sync,
new scheduler or automatic job retry is an acceptable shortcut.

## Workbook and exact Oracle validation prompts

After separate code review/deployment, use a **new** report; retained workbooks
and jobs keep their original evidence. Refresh/download must not replay providers.

1. `LoyaltyLion performance report`
   Expect November 2025–October 2026 and current November through yesterday as
   separate windows. Compare requested dates with exact commerce intervals and
   partial-day points cutoff; verify collection time differs from generation.
2. `LoyaltyLion performance report for October 2026`
   Inspect 30/90/180-day required starts/ends, cohort customer counts, maturity,
   verified commerce cutoff and `withheld_reason`. November orders may contribute
   to enrolment-relative windows beyond 31 October; only fully supported windows
   receive rates. A true zero under full coverage is 0, not blank.
3. `LoyaltyLion performance report compare September 2026 with October 2026`
   Verify separate enrolment selection scopes and observation bounds. Current
   member/non-member/unknown AOV, orders per purchasing customer and repeat rates
   stay separate by channel and currency. Full period counts/rates are computed
   directly, never summed/averaged from monthly rows.
4. `Export those results to Excel`
   Download using the authenticated owner session; verify all successful sheets
   remain when a source fails. An unauthenticated request must be denied. Reload
   the completed result and download again without new provider queries.

The generated-SQL regression reproduces October enrolment with a November order
and includes it despite an October-only requested period. The original SQL also
has no requested-period predicate on cohort outcome orders: **the suspected
October filter defect is not confirmed**. Production row-by-row reproduction is
blocked by access, not replaced by a fixture claim. The confirmed boundary defect
was excluding immature enrolments using report generation time, leaving no row
explaining why the verified commerce window could not support them.

Rates are withheld for no verified channel cutoff, an immature required after-end,
a gap in the full required before/after interval, or an empty eligible population.
Maturity and full-window support are distinct. Counts beyond certification remain
observed. Monthly cohort groups are conservative: the whole aggregated required
window must be supported. No causal uplift, actual voucher use, historical tiers,
discount binding or incremental revenue is inferred; claims remain claims.

## Verification

Local SQL executes generated BigQuery statements against synthetic rows via
DuckDB/sqlglot (Python dependencies: duckdb, sqlglot, pytz). This is a calculation
regression, not a production BigQuery dry-run or live coverage certification.
The acceptance matrix registers the evidence-gap suite; staged roster failure,
interactive/durable partial workbooks, authenticated downloads and desktop/mobile
browser recovery are exercised by the existing gates and added assertions.
