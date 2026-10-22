# Retained baseline and transaction-pipeline investigation

Report fixes are ready for review; see the [merge recommendation and finite coverage plan](retention-coverage-verification-plan.md). Scope remains 2022-10-19–2026-10-19 entry,
2026-10-19 observation cutoff, Europe/London, existing snapshot
customer_identity/history-20261022-billing-v3. No report replay, collector,
production write, classification change or certificate is authorized here.

## Exact baseline rejection: now confirmed

The user supplied the successful exact-result check. The historical validator
rejected **results[0].second_order_products[0].product_ref = null**, with
`Invalid second-order products`. Query 6026f7a6-44c6-4449-9814-398b028296f1
completed successfully. This previously inaccessible field is no longer an
unresolved investigation. The supplied evidence, shared boundary fix, exact
regression and separate finance/completeness findings are in
[the confirmed-baseline investigation](retention-confirmed-baseline-and-finance.md).
The in-memory historical validator is retained unchanged for auditability.

## Actual transaction ingestion paths

| Report input | Writer and completion evidence | What it can establish / what it cannot |
|---|---|---|
| Shopify order_locations, order_customers, order_line_items | server.js getAllOrders → syncShopify → separate replace functions; /sync-shopify | Outer order pages exhaust hasNextPage; response/logs include fetched/written counts. Separate deletes/inserts across tables do not form one atomic snapshot. lineItems(first:250) has no nested exhaustion proof. No immutable full-bootstrap manifest is persisted by this path. Successful code execution alone does not establish which historical orders the API permitted. |
| Shopify order_locations, order_financials, order_refunds | shopify/finance-refresh.js, scheduled via render.yaml → ops/collector-runner.js → --mode scheduled; finance_refresh_runs and finance_refresh_state | A succeeded run is recorded in the same transaction as promotion. Exact half-open updated_at windows, page counts, order/refund counts, run ID and watermark can establish successful extraction/promotion of accessible updates. Pagination bounds fail closed. Contiguous update windows can support maintenance **after a verified full baseline**, not establish a created-order history baseline by themselves. This writer does not populate customer/status or product-line tables. |
| Shopify order_customers eligibility/status | shopify/customer-recovery.js; customer_refresh_runs and customer_refresh_state | Repair mode fetches only missing IDs already known to warehouse financials. Requested=returned and no unresolved IDs establish that repair, not discovery of all orders. Scheduled mode exhausts updated_at windows and can support maintenance after a verified baseline. Repair and scheduled windows must never be merged into one completeness chain. Blueprint does not schedule this customer collector. A deployed schedule elsewhere is not inferred absent. |
| Woo WW/USD orders and order_line_items | server.js /sync-metorik-uk-orders and /sync-metorik-us-orders → fetchAllMetorikOrders → syncMetorikOrders → safelyReplaceMetorikTables | No discovery-date filter; explicit page progress, nonrepeated content, has_more_pages=false, valid IDs, duplicate/orphan checks, staging counts and coordinated transactional replacement. Response returns pages/counts/date/status distributions; rows retain synced_at. The path does not persist those API-page assertions as a run manifest. Retained successful response/log plus matching warehouse commit/counts could support a full snapshot of the Metorik API's accessible population, subject to source/export completeness and retirement proof. No Woo follow-up after retirement is inferred from latest activity. |

Shopify retention joins locations to financials and customers, uses customer
financial status/cancelled_at, location source-app ID/channel, and financial
refund totals. Therefore finance-only success cannot certify this report's
eligibility input. Missing product lines block item/classification sections;
missing transactions or eligibility records can also affect retention counts.
These limitations must remain separate. Native Woo orders_api and identity
email adapters do not write the canonical metorik_uk/metorik_us transaction tables
used here; their completion cannot certify those inputs.

`ops/collector-runner.js` also writes oracle_ops.collector_runs/state, but its
Shopify inspection is a snapshot count/MAX(synced_at), not a transaction interval.
The wrapper reads coverage_end, which this snapshot inspection does not return;
its generic watermark can therefore be null. Those generic records establish
runner outcome, not continuous transaction coverage. Do not repair state or
reinterpret a timestamp as a certificate.

The earlier bounded discovery matched coverage/history candidates in five
datasets. It did not inspect these specific finance/customer refresh records or
oracle_ops. Thus its absence result was **missing certification among inspected
records**, not evidence of missing transactions and not a complete pipeline audit.
The supplied ready identity snapshot and eight completed history_progress records
establish identity adapter lineage/completion only.

## Smallest concrete verification before certifying an interval

1. Read the **two exact Shopify run/state pairs** below. For finance and scheduled
   customer runs independently, inspect successful update-window unions, internal
   gaps, successful watermark and matching atomic promotion run IDs. Customer
   repair windows are excluded from the incremental union. A missing table/read
   or chain is unresolved evidence, never proof that transactions are absent.
2. Supply an **existing full-bootstrap completion artifact** for Shopify and each
   retired Metorik store: source/API/export scope and access limits, exhausted
   pagination, source order key/count reconciliation to committed warehouse input,
   and eligibility/refund/cancellation field completeness. Use existing successful
   sync response/log, immutable export manifest, load/commit metadata or an already
   retained source reconciliation. Warehouse-to-warehouse joins alone cannot prove
   unseen upstream orders do not exist. A full source order-ID inventory with
   bidirectional anti-join counts is preferable to totals alone.
3. Identify the evidenced Woo retirement boundary and migration/handoff lifecycle,
   including any post-retirement adjustments. Supply original-order provenance and
   source/channel scope. A public Shopify launch or observed last-order timestamp
   cannot substitute. Current mutable tables also do not prove financial status as
   it stood on 2026-10-19; record the report's current-state versus historical-as-of
   semantics explicitly.

If an artifact above is not retained, propose **one read-only source-versus-warehouse
order-ID/eligibility reconciliation for the specific uncertified interval** (using
an existing export if available), with counts of missing/extra keys and mismatched
refund/cancellation state. Obtain authorization for any fresh source verification
separately; it is not a recollection or backfill and is not run by this PR. For an
asserted retired interval, the smallest missing fact may instead be a retained
retirement/no-new-orders attestation. No rate is enabled until the applicable
facts are established, reviewed and supplied through the existing certificate
contract. Its linked common-interval safeguard is unchanged; a future certified
handoff union would need separate design and proof.

**Coverage blocker:** no supplied record yet proves a complete original-transaction
bootstrap plus continuous eligibility-state maintenance and source lifecycle for
the linked follow-up interval. Transactions are present (the supplied report shows
observed repeats). Completeness is unverified; missing transactions are not
established. Existing refresh manifests can narrow the gap but cannot alone close
bootstrap, cross-table and retired-source evidence gaps.

## One indispensable Render check

**Completed: the user supplied successful output. Do not rerun this command.**
The remaining targeted read is only the stored finance errors in the
[confirmed findings](retention-confirmed-baseline-and-finance.md).

The single pinned command below performs one GET of the **existing** baseline
result, two metadata GETs and two bounded SELECT jobs against the exact Shopify
run/state pairs. No INFORMATION_SCHEMA discovery, source/API collection, job
replay, transaction recomputation, DDL/DML or identity/classification/settings
write. At most 200 MB billed across both SELECTs; each query ≤10 seconds,
40-second shared budget, process TERM at 55 seconds plus 5-second kill allowance.
All checks retain independent outcomes. Recent/gap examples are capped at 12;
summary interval/gap counts inspect all relevant persisted runs. These are update
windows, not certificates. If a pair is absent, the other still returns.

```sh
timeout --signal=TERM --kill-after=5s 55s node --input-type=module <<'JS'
import {createHash} from 'node:crypto';
let stage='deployed_dependencies';
try {
  const [{BigQuery},{loadBigQueryConfig}]=await Promise.all([
    import('@google-cloud/bigquery'),import('./bigquery/client.js')
  ]);
  stage='pinned_read_only_diagnostic';
  const revision='b7ce8a2006e3aca4009a1f20ff9646695f9781d5';
  const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/oracle-retention-exact-evidence.js`,{
    signal:AbortSignal.timeout(8000),redirect:'error'
  });
  if(!response.ok)throw Error();
  const chunks=[];let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;if(bytes>65536)throw Error();chunks.push(chunk);}
  const source=Buffer.concat(chunks);
  if(createHash('sha256').update(source).digest('hex')!=='7487929ea4e80e40ee7cb04234eeaa9967d597b125d45ca9fe1d78e998a736aa')throw Error();
  const {readExactRetentionEvidence}=await import('data:text/javascript;base64,'+source.toString('base64'));
  const {project,credentials}=loadBigQueryConfig();stage='exact_evidence_reads';
  const evidence=await readExactRetentionEvidence({
    bigquery:new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0}),project
  });
  console.log(JSON.stringify({diagnostic_revision:revision,deployed_revision:process.env.RENDER_GIT_COMMIT||null,...evidence}));
  process.exitCode=evidence.checks.some(c=>c.status!=='read_completed')?1:0;
}catch{
  console.log(JSON.stringify({read_only:true,report_replayed:false,status:'unavailable',stage}));
  process.exitCode=1;
}
JS
```

A failure to fetch an expired retained result does not trigger a replacement
query. If the historical validator accepts these retained rows, report that
reproduction did not establish the original predicate; investigate the original
provider projection/coverage or saved validation log instead of inventing a field.

## Local validation

Six targeted regressions pass: incident-validator checksum, exact null-field trace,
strict scope/denominator rejection, existing-result-only access, independent
failure/expired-result handling, and distinct scheduled/repair update windows.
Required acceptance gate: **759 passed**, zero failed/cancelled/skipped (21 central
conversations, 51 suites). Browser gate: **passed**, desktop/mobile and durable /
activated-identity refresh. Syntax and diff whitespace checks pass. These are
local checks; the user supplied successful production output and confirmed the exact null
product_ref. Corrected live execution and follow-up certification remain separate.
