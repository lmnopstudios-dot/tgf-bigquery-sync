# Collaboration retention: causes, scope and verification

Baseline: latest main `6d75a665604b77269ea2592b3fec467a68bf6930` (PR #333).
The earlier cohort, shared planning, completeness, export, date and recovery work
remains in place. The only open PR returned by repository search was #123
(product-mapping diagnostics); its unmerged graph changes are not copied here.
No basket calculator, source classification, collection, backfill, inventory,
permission, schedule, deployment or merge was changed.

## Demonstrated causes

- `resolveExecutionPlan` rejected cohort chart/export preferences before invoking
  the supported cohort reader. That explains the table suppression without a
  provider call. Optional presentation now has an independent terminal outcome.
  Shared component accounting distinguishes an unavailable format from a failed
  supported export; related campaign, conversion and basket export tests remain.
- `retentionMarkdown` selected `Math.max(window_days)` for the headline. It thus
  selected 180 days whenever both windows existed, irrespective of the requested
  primary measure. Ranking window now survives context, plan, query parameters,
  bounded SQL selection, headline and strict recovered-evidence validation.
- `entry_matches` treated every active `collaboration_name` as a named entity.
  Broad `collaboration` / `collaborations` values were not separated. The reader
  now excludes those broad taxonomy values from named competitors, retains their
  generic membership in coverage, and rejects generic competitors on recovery.
  This is a read-time entity distinction, not a source taxonomy correction.
- The journey classifier used direct classifications and approved identity edges.
  The existing category-sales reader additionally supports governed reporting-family
  routes. Journey classification now uses those same decision/current/supersession
  rules, directionally from a historical member to its classified parent. Family
  membership conveys classification, not customer or product identity. No titles,
  tags, publication status, fuzzy matches or unapproved mappings establish a name.
- Piece grouping previously replaced collaboration grouping, and selected a minimum
  collaboration name per piece. A nested request now executes both named summaries
  and source-piece cohorts within each named collaboration. Separate pieces on an
  entry order overlap; each customer counts once within each cohort.
- Second-purchase classification did not execute in the retention SQL. It now
  classifies the first strictly later eligible order as same collaboration, other
  collaboration, explicitly governed core, or unknown. Mixed categories, missing
  product evidence and conflicting names are unknown, never inferred core.
- Rolling-year dates included today, and SQL used UTC `DATE(timestamp)` despite
  context recording London. The shared natural-period resolver now honors an
  explicit latest-completed-day role; typed journey parameters use the context's
  timezone for entry dates, observation cutoff, maturity and repeat-day windows.
  Entry period and observation cutoff remain separate contract fields.
- A prior sales question could capture the incident's “median days” as an added
  merchandise-median operation before resolving the new cohort subject. Subject
  resolution now precedes that refinement, and metric-only refinements must start
  with a refinement instruction. Tests retain valid sales refinements.
- Piece labels exposed source references, medians were not rounded, and the details
  opener was `<details><summary>...` on one line. The strict browser renderer only
  accepts those tags on separate lines. Labels are now readable names, medians use
  one decimal, percentages use two decimals, and one rendered details block holds
  technical definitions and coverage.

These traces demonstrate implementation defects, not certified production counts.
No live read established which named collaborations are missing, whether a specific
historical classification is wrong, or precisely why the reported response contained
only Shopify. The reported 100/52/6/32/8 counts are not test fixtures or expectations.

## Actual supported calculations and limitations

The bound provider reads Woo UK `metorik_uk.orders/order_line_items`, Woo US
`metorik_us.orders/order_line_items`, and Shopify
`order_locations/order_customers/order_financials/order_line_items`. Product
classifications and active governed product mappings/reporting families provide
classification evidence. Shopify Product GIDs normalize only to parent product IDs.

All available eligible identified history is sequenced before entry-window and
entry-channel filters. Customers already seen before entry cannot join a first-order
cohort on a later collaboration purchase. Source-qualified identities never merge
across Woo UK, Woo US and Shopify. The result explicitly substitutes first observed
for first-ever TGF purchase, including in its visible lead.

Woo completed/processing and Shopify paid/partially paid/partially refunded orders
remain eligible if not fully refunded. Cancelled Shopify orders and Matrixify
imports are excluded. Persisted order projection multiplication is deduplicated
before sequencing. Entry timestamp ties use source/store/order reference; only
strictly later orders count as subsequent purchases. Partial refunds retain the
existing order eligibility contract; individual returned-piece eligibility is not
reconstructed from incomplete line history.

Entry counts, mature 90/180-day denominators, repeat counts/rates and conditional
medians execute for named collaborations and pieces. Repeat maturity/windows use
London calendar dates. Median days is elapsed time, so a repeat on calendar day 90
can have elapsed duration slightly above 90; validation allows the calendar/timezone
boundary instead of rejecting that legitimate result.

Named identity is unique per product. Multiple active names on one product are
ambiguous; multiple separately named products in an order create overlapping cohorts.
Core classification requires an explicit governed core/core-range group; ordinary
product category evidence alone does not establish it. Missing second classification
from an older provider is shown as unavailable, never manufactured counts. New SQL
returns four exclusive counts reconciling to each repeat numerator.

Warehouse coverage includes eligible identified first customers/orders, named matches,
generic-only matches, unknown/ambiguous/outside-collaboration records, earliest/latest
observed source dates, identified and anonymous order counts, and migration,
cancellation and status/refund exclusions. Reasons can overlap. Coverage partitions,
window populations, ratios, medians, buckets, entities, requested rank, timezone and
recovery scope are validated. The unknown group includes non-collaboration entries;
it is not a claim that every such product lacks all classifications.

Classifications are the active current governed view. Neither current catalogue
membership nor effective-date columns establish historical purchase-time membership
for every order. No current publication filter is used. Observed source endpoints do
not certify continuous history or a complete three-year collection. Eligible anonymous
customer counts, cross-platform duplication and the company-wide unevaluable share
cannot be established; anonymous **orders** are not anonymous **customers**.

Square is deliberately explicit as unsupported by the cohort provider. The existing
`diagnostics/square-customer-attribution.js` can discover persisted order/payment
customer IDs and aggregate their exact linkage; the existing journey diagnostic
projects Square retail lines with null customer identity. Neither is a governed
Square cohort binding or company-wide identity bridge. Live Square schema/linkage
was not verified in this session. No email/name bridge or zero population is inferred.

Platform reads are isolated, so a missing Woo history table no longer appears in a
Shopify SQL read. Woo UK/US remain separate reported populations in one Woo query;
a missing required Woo store table can still make that Woo read unavailable. This
is reported rather than silently treating either population as zero. Named/piece
read failures preserve independently validated groups. Explicit source statuses
separate observed endpoints, unavailable providers and missing coverage metadata.

Ranking defaults to the requested 90-day repeat rate; an explicit 180-day primary
ranking or returning-customer-count request is preserved. 180-day figures stay
secondary for the production request. Row selection ranks by the requested metric
before limiting, with quotas per store so one Woo store cannot consume the entire
bound. A truncation flag covers populations beyond the quota. All denominators are
shown; no universal minimum sample threshold or significance claim is introduced.
The visible conclusion withholds a reliable company-wide winner and states association.

Charts and workbooks remain unsupported for this evidence type. Supported tables
survive either request, with separate component outcomes. Compatible validated cached
cohort evidence is reused for presentation-only requests. Checkpoint, lease, owner,
strict scope and authenticated polling safeguards remain active; rendering/recovery
never replays provider reads as a repair.

## Bounded read-only Render commands

Use the deployed service's existing identity and dependencies. This temporary source
checkout does not deploy or modify the service. Confirm its printed SHA against the
PR before interpreting results. The runtime computes Europe/London's latest completed
day; entry and observation dates are printed independently.

```sh
oracle_live_src="$PWD"
oracle_probe_root="$(mktemp -d /tmp/oracle-retention.XXXXXX)"
timeout 45s git clone --depth 1 --single-branch --branch fix/collaboration-retention https://github.com/lmnopstudios-dot/tgf-bigquery-sync.git "$oracle_probe_root/src"
ln -s "$oracle_live_src/node_modules" "$oracle_probe_root/src/node_modules"
git -C "$oracle_probe_root/src" rev-parse HEAD
(
  cd "$oracle_probe_root/src" || exit 1
  timeout 55s node diagnostics/oracle-retention-coverage.js
  timeout 55s node diagnostics/oracle-retention-coverage.js --execute-read-only
)
```

Each invocation attempts at most four queries (Woo/Shopify × named/pieces), 20 GB
maximum billed per query, 10-second warehouse job timeout and a 45-second shared
budget, with a 55-second external process limit. Each aggregate result is capped at
50 rows (up to 200 total), plus aggregate source coverage. Default mode is dry-run
only. Execution mode performs aggregate reconciliation, never returns customer rows,
and reports failures independently. Dry-run success verifies referenced schema/SQL,
not source completeness. No inventory tables are read.

For bounded Square schema and exact-ID aggregate discovery, separately run:

```sh
(
  cd "$oracle_probe_root/src" || exit 1
  timeout 55s node --input-type=module <<'JS'
import {createBigQueryClient} from './bigquery/client.js';
import {runDiagnostic,formatDiagnosticFailure} from './diagnostics/square-customer-attribution.js';
const {bigquery,project}=createBigQueryClient();
let queries=0;const deadline=Date.now()+45000;
const bounded={query:async options=>{
  if(++queries>4||Date.now()>=deadline)throw Object.assign(Error('Bound'),{code:'DEADLINE_EXCEEDED'});
  let query=options.query;
  if(query.includes('INFORMATION_SCHEMA.COLUMNS'))query=query.replace("WHERE table_name NOT LIKE 'customer_attribution_%'","WHERE table_name IN ('orders','retail_orders','payments','retail_payments','customers')")+' LIMIT 500';
  return bigquery.query({...options,query,jobTimeoutMs:Math.min(10000,deadline-Date.now()),maximumBytesBilled:'20000000000'});
}};
try{console.log(JSON.stringify(await runDiagnostic({bigquery:bounded,project}),null,2));}
catch(error){console.error(formatDiagnosticFailure(error));process.exitCode=1;}
JS
)
```

This is at most four read-only jobs, with the same time/billing caps and a 500-column
schema bound restricted to order/payment/customer tables. Output is aggregate counts,
schema descriptors and annual source-currency totals; no raw customer IDs or format
examples are emitted. Discovery does not authorize adding Square to a cohort or
combining its identities with another platform.

## Acceptance questions

1. Submit the unchanged request in `test/helpers/retention-events.js`, fresh and
   after an unrelated sales question. Are named collaborations compared at 90 days,
   with pieces below each collaboration and visible mature denominators?
2. Ask “Rank primarily by 180-day repeat-purchase rate; retain the 90-day figures.”
   Does the requested ranking change without changing the entry population?
3. Ask “Export that to Excel and show a chart.” Does the table survive with both
   formats explicitly unsupported and no sales substitution?
4. Refresh and recover the owned job. Do counts, classifications, dates and limits
   remain identical without additional provider reads? Record real coverage gaps;
   fixture counts are not production acceptance targets.

## Verification record

Live default SQL dry run: HTTP 403 at `oauth2.googleapis.com`, before warehouse
schema/SQL validation. The four-query probe likewise reported four unavailable dry
runs with code 403. The bounded Square diagnostic also failed at schema discovery with code 403.
No production row, source coverage, identity reconciliation or
classification coverage has been certified. Run the bounded commands above in Render.

Initial local runs failed on stale expectations (180-day headline, blocked optional
formats, one combined source call and legacy SQL shape). The release gate also found
that an unsupported workbook was incorrectly accounted as failed; capability-aware
component accounting fixes that shared boundary. Initial browser runs failed a
case-sensitive legacy “mature customers” assertion, which now accepts the table header.
No failed/interrupted check is counted as a pass. Final results are recorded below.

- Final persistent acceptance: **474 passed**, zero failed/cancelled/skipped.
  For each direct/interactive/durable transport: 15 correct results, 20 partial
  results, 6 capability limitations, 3 pending clarifications and zero failures
  across 20 conversations. These classifications report actual delivered fixture
  outcomes, not production success.
- Final focused cohort/journey/multipart run: **66 passed**, zero failures/skips.
- Desktop/mobile browser gate: **passed**, 20 conversations including the unchanged
  request fresh/after sales, one rendered details block, both unsupported optional
  outputs retaining the table, owned polling and refresh without provider replay.
- Two complete repository runs: **1,508 passed**, **3 opt-in checks skipped** each,
  zero failures/cancellations (1,511 total). Final ranking/presentation-scope refinements
  are additionally covered by the 13-check incident suite and persistent gate.
- Strict tool schemas: **46 schemas across 61 tools validated**. JavaScript syntax
  and `git diff --check` passed. The four-job dry-run probe contract was also checked
  locally with a fixture BigQuery client; no fixture establishes live SQL validity.
