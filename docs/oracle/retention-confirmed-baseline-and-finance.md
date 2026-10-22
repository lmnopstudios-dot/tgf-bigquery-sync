# Confirmed baseline bug, finance failures and completeness verification

PR #370 remains draft. Frozen report scope, snapshot, governed collection, linked
identity, migration exclusions and mature-window safeguards are preserved. These
are three separate findings, not one cause.

## Confirmed null-product rejection and shared boundary fix

The successful supplied exact-result diagnostic establishes:

- Retained query 6026f7a6-44c6-4449-9814-398b028296f1: DONE, warehouse_failed=false.
- Incident validator rejected `Invalid second-order products` at
  **results[0].second_order_products[0].product_ref = null**.
- All three rows have Shopify/shopify/Sitewide identity with no entry product.
  Cohort customers: 8,897 each. Observed repeats: 510 / 656 / 702 at 90/180/360
  days. Mature denominator and mature-repeat counters are zero under unverified
  coverage; those zeros do not establish a supported mature rate.

The earlier SQL grouped second-order lines with null product references into the
same bonus array as identifiable products. The monolithic row validator rejected
that bonus entry and discarded the whole baseline. This is an application
calculation/validation-boundary bug, not a warehouse error or source-coverage
failure. The supplied trace is committed in
[test/fixtures/retention-exact-production-20261022.json](../../test/fixtures/retention-exact-production-20261022.json).

The PR's SQL already excludes unidentified references from named detail and
counts unidentified/missing-line customers separately. The shared boundary now
also separates unknown attribution in a completed or retained aggregate:

- Validate source/store/cohort/window, population counts, mature coverage,
  denominators, median and classification buckets independently and strictly.
- A null supplemental product_ref is **never a named product identity**. Keep its
  valid observed/mature counts in explicit unidentified groups; retain all valid
  named product rows. Groups overlap named products and are not summed into a
  unique-customer total or used to alter any cohort/return denominator.
- Missing/empty/non-string/duplicate named identities, malformed bonus counts or
  product-attribution coverage flags reject the supplemental attribution, not validated baseline metrics.
  Report attribution as unavailable. No malformed identity is accepted as a
  product, no title matching or synthetic ID is introduced.
- Strict terminal validation checks the canonical known-product array and the
  separate unknown/unavailable contract. Forging a null reference into named
  detail still fails delivery. Rendering/recovery preserve unknown attribution.

The exact regression uses the supplied baseline metrics and null reference;
product detail counts/titles/other references were not in the diagnostic and are
explicitly synthetic fixture values. Direct, interactive, lease-owned durable
persistence/polling and desktop/mobile refresh paths exercise the boundary without
provider replay. No new live calculation or rate certification is claimed.

## Finance pipeline relationship and observed failures

Source trace: render.yaml's oracle-shopify-finance cron invokes
ops/collector-runner.js → shopify/finance-refresh.js scheduled mode →
fetchUpdatedOrders / transform / promote. Atomic promotion writes:

| Written table | Retention dependency in oracle/customer-journey.js |
|---|---|
| shopify_data.order_locations | Driving Shopify order IDs; created_at entry/return dates, retail_location_id channel, source_app_id imported-order exclusion |
| shopify_data.order_financials | original_total_presentment and total_refunded_presentment used in eligibility; currency |
| shopify_data.order_refunds | Not read directly by retention. Its collector also updates the financial total-refund fields that retention does read. |

Retention additionally LEFT JOINs shopify_data.order_customers for customer ID,
is_guest, display_financial_status, cancelled_at and record presence. Product
attribution reads shopify_data.order_line_items. Finance refresh does **not**
maintain either customer/status or product-line tables. No evidence links these
finance failures to the null product_ref; finance refresh does not write the
order_line_items attribution input. The full server.js
syncShopify path is another writer of these inputs. Therefore a failed scheduled
collector is a real dependency risk, not proof that all retention inputs stop at
its watermark. Linked Shopify returns may affect Woo-entry cohorts too; no count
of affected customers is established by the supplied evidence.

The supplied run records show 206 succeeded finance windows with no internal gaps
in the selected persisted union, from 2026-09-25T00:00:00Z through
**2026-10-19T14:17:24.265Z**. Latest twelve attempts are failed and all start at
2026-10-19T12:17:24.265Z (two-hour overlap). The latest known failed run is
9a2b5457-8605-4801-bf24-464e78f2ddb2, ending 2026-10-22T14:17:35.465Z,
with 183 fetched orders, five refunds and four pages. The frozen successful
state belongs to run 69e90b1e-0df3-439d-94d4-cc3967098a5a.

Nonzero persisted order/refund/page counts establish that those attempts reached
the count update inside promote, after fetch and transformation. Failure could
occur during staging creation/load or promotion; the exact cause is **not** in
this supplied output because the prior diagnostic did not select `error`.
Atomic source code guards promotion and state update together, but run status or
timestamps alone do not prove what all other writers committed or quantify loss.

One exact SELECT of existing error records was attempted here; OAuth token
refresh returned **403, Domain forbidden**, before execution. No restart, source
fetch, retry, recollection or reset followed. The smallest remaining error read
is below. Do not rerun either previous diagnostic or the retained baseline query.

The report's full London cutoff day ends at 2026-10-19T23:00:00Z. The last finance
watermark is 8h42m35.735s before that half-open boundary. This identifies an
uncertified update interval, not an inferred number of missing orders. Successful
finance windows also cover only maintenance after September 25, not a complete
historical baseline. The supplied customer record is one successful September
repair of 192/192 known IDs, zero unresolved; there are zero scheduled customer
runs in the selected persisted history. Its October 1 repair watermark is not a
proven transaction-population end date.

## Smallest completeness verification for the actual retention inputs

Stop searching table names for a certificate. Reuse an existing exhaustive,
original-order export/manifest where available and perform a **read-only keyed
reconciliation**, without importing or recollecting anything:

1. For Shopify, reconcile original source order IDs (Online and In-store,
   including cancellation/refund state and app/import provenance) bidirectionally
   to distinct order_locations IDs, then to order_financials and order_customers
   by order_id. Report source-only, warehouse-only, duplicate keys and mismatched
   created_at/channel/source-app/status/cancelled/refund/total fields. Include
   source orders with no products; do not derive the order roster from lines.
   An equal overall count or warehouse-to-warehouse match is insufficient.
2. The smallest *newly exposed* interval starts at the last successful October 19
   update watermark (inclusive) and ends at the London cutoff boundary (exclusive). Reconcile source order
   keys created **or updated** in that interval, including older orders refunded
   or cancelled then. This can close that narrow freshness gap, not certify the
   entire historical bootstrap. Use recorded bootstrap manifest/key results to
   establish earlier history; if absent, the unresolved bootstrap range must be
   explicitly covered by a retained full source-key inventory.
3. For each Woo store, compare a retained complete Metorik original-order key
   inventory/export to metorik_uk.orders / metorik_us.orders, including status,
   original dates, totals/refunds and duplicate keys, through an evidenced source
   retirement boundary. Confirm no later original orders/adjustments from retained
   lifecycle evidence; a last-order timestamp does not establish retirement.
   Reconciliation must use the report's declared financial-state semantics; a
   newly fetched current status/refund value alone cannot prove historical state
   at the October 19 cutoff. Preserve any retained as-of audit independently.
4. Only product/item completeness additionally requires order/product/line keys
   against the actual order_line_items tables, with missing/unknown lines separate.
   It must not gate preservation of otherwise valid baseline order metrics.

If the necessary retained source inventory is absent, the remaining fact is
source-to-warehouse key/state completeness over that exact range, not necessarily
missing transactions. Propose a separately authorized read-only source-key/state
verification for the uncertified range; do not automatically collect, persist,
backfill, repair or certify. Report frozen-snapshot linkage gaps separately;
do not invent or change links to make a source reconciliation pass. Existing
warehouse counts and identity completion
cannot substitute. Linked mature denominators still need complete applicable
source follow-up (and evidenced handoff/retirement), so rates remain unavailable.

## One targeted existing-error read (production access essential)

Run once in the existing deployed Render repository. This uses existing SDK and
configuration, selects only persisted finance failures for the frozen overlap
window, and returns the first two plus latest four attempts (at most six rows).
No collector, report replay, source API call, DDL/DML or state write. Fixed US
location is established by supplied metadata; max billed bytes 100 MB, query
10 seconds, process 20 seconds plus three-second kill. Preserve existing errors;
do not restart based on the output.

```sh
timeout --signal=TERM --kill-after=3s 20s node --input-type=module <<'JS'
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {redactError} from './oracle/ui-security.js';
const {project,credentials}=loadBigQueryConfig();
if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
try {
  const bigquery=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  const [rows]=await bigquery.query({
    query:`SELECT run_id,window_start,window_end,status,error,started_at,finished_at
      FROM \`${project}.shopify_data.finance_refresh_runs\`
      WHERE status='failed'
        AND window_start=TIMESTAMP('2026-10-19T12:17:24.265Z')
        AND window_end>TIMESTAMP('2026-10-19T14:17:24.265Z')
      QUALIFY ROW_NUMBER() OVER(ORDER BY started_at)<=2
        OR ROW_NUMBER() OVER(ORDER BY started_at DESC)<=4
      ORDER BY started_at LIMIT 6`,
    location:'US',useLegacySql:false,autoPaginate:false,maxResults:6,
    jobTimeoutMs:10000,maximumBytesBilled:'100000000'
  });
  console.log(JSON.stringify({read_only:true,restarted:false,
    checks:rows.map(r=>({...r,error:redactError(r.error)}))}));
}catch(e){
  console.log(JSON.stringify({read_only:true,status:'unavailable',
    http_status:Number(e.code)||null,message:redactError(e.message)}));
  process.exitCode=1;
}
JS
```

## Verification

- Five exact-boundary/delivery regressions pass, including the supplied null
  product reference, baseline metrics, strict terminal identity checks and
  durable recovery without re-query.
- Required acceptance gate: **764 passed**, zero failed/cancelled/skipped,
  21 central conversations and 52 suites. Command:
  `taskset -c 0 npm run test:oracle:acceptance` (one available CPU makes Node run
  test files sequentially). Two initial concurrent runs each failed one unchanged
  millisecond-deadline publication test; the first affected suite passed 15/15
  in isolation. No tests or publication code were altered to bypass those failures.
- Final `npm run test:oracle:browser`: **passed**, desktop/mobile, 21 conversations,
  unknown-attribution disclosure, durable and activated-identity refresh.
- Syntax and `git diff --check` pass. These gates use local fixtures; no corrected
  live report, collector recovery, transaction completeness or rate is certified.
