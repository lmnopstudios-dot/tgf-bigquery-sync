# Blank completed Oracle response

Incident request `51bfebe0-0b84-480c-be2e-8803d5d10197`, job
`aa87e577-3d41-4244-87f9-9302d33f79b7`. Implementation starts from latest
`origin/main` `3ea6caa`, including merged clarified-export PR #309. Its catalogue,
filter identity, workbook validation, idempotency and durable routing are retained.

## Demonstrated defects and uncertainty

The supplied logs establish execution-stage success, not correct shipping evidence
or usable presentation. Read-only production inspection reached dataset metadata
and failed with `403 EGRESS_FORBIDDEN`. No production row, provider argument,
order-level distribution, saved answer or owner-scoped polling response was read.
The precise incident cause and production browser outcome remain unverified.

Current shared code demonstrably allowed `response.output_text` to be empty after
successful tools. The shared presentation function returned immediately when
`answer` was empty even with meaningful evidence. Poll recovery recognised prose
only, and the browser rendered empty prose without a deliverability check. Polling
was unbounded, and failed jobs with checkpoints were discarded by the browser.
Legacy malformed/null terminal envelopes could also fail while being destructured.
Production-shaped fixtures reproduce these mechanisms and now render meaningful
content with the composer enabled.

Latest main already validates BigQuery affected-row counts, claim tokens and
leases, and refuses stale-worker failure writes. Those fixes are preserved.
Finish diagnostics now explicitly distinguish accepted terminal persistence,
presentation readiness and **unverified browser delivery**.

## Shared implementation

- `public/oracle/result-contract.js` normalizes bounded known result envelopes,
  JSON strings, supported presentation summaries, clarifications and owned export
  URLs appropriate to the UI or authenticated direct API. Blank, malformed, unsupported-version and expired-artifact results receive
  an honest visible limitation.
- `oracle/result-delivery.js` uses the existing analytical presentation and shared
  aggregate evidence renderer after scope validation, without provider replay.
  Serialization failures preserve separately serializable evidence and artifacts.
- Dispatcher, direct model output, interactive API, worker and authenticated job
  polling apply the contract. Existing resolved-plan and evidence checks precede
  polling recovery. Scope mismatches return sanitized `409` without evidence.
  Polling preserves authoritative job IDs/status and does not allow result fields
  to overwrite lifecycle metadata.
- The browser shares the same answer path on immediate delivery and refresh.
  Markdown exceptions fall back to text; optional chart/proposal failures preserve
  the answer. Failed/cancelled checkpoints remain visibly labelled as partial.
  Expired/unavailable artifact links are withheld; manifest failures are visible.
- Polling is read-only and bounded to 300 attempts or ten minutes, with at most
  three consecutive transient failures. Scope/auth/client rejection stops it
  immediately. Stale-scope replies cannot clear newer submission state. Automatic
  reconnect creates no jobs; explicit retries retain owner/request idempotency.
- New worker, polling and browser diagnostics contain bounded identifiers, stage,
  status, schema version, counts and presence flags. They contain no prompts,
  provider parameters, raw results, credentials or private exception messages.

## Shipping capability audit

`requested-operations.js` describes reusable order-value band and threshold
requirements, independent of exact wording or the supplied threshold list. It
prevents an unrelated aggregate-sales or model route from claiming such an
analysis is supported. This is a capability limitation through the common answer
pipeline, not a new shipping provider or calculation route.

No current governed binding establishes all of the required complete unique-order
population, UK shipping destination, online channel, GBP, merchandise eligibility
amount after applicable discounts, tax treatment, separate recorded shipping
charges, exceptions and unknowns. The bounded order-search route is not a complete
population. ShopifyQL period sales, AOV and product-line evidence do not supply
these semantics; joining product rows could multiply order values. Consequently,
£250 versus £175/£200/£225/£275/£300 bands, exact inclusive/exclusive threshold
boundaries and historical shipping-revenue effects are **unavailable**. No such
figures are manufactured from totals or a limited sample.

The supplied £8 is illustrative, not recorded-charge evidence. Raising a threshold
does not establish that all affected customers would pay it. Unchanged-behaviour
revenue scenarios would not predict conversion, basket uplift or profit. A
profit-optimal recommendation is withheld without compatible product and
fulfilment costs.

Confirmed online May promotion context is retrieved with the existing governed
promotion service and retained independently when available. Failure, incomplete
retrieval, conflicting dates or ambiguous endpoints remain explicit limitations;
no causal promotion effect or exclusion-adjusted distribution is inferred.

Published UK-price add-on suggestions remain unavailable in this response. The
existing general catalogue search includes inventory fields and is not a
compatible inventory-free UK published-price/eligible-basket binding. No inventory
call is added, no price is invented, and no basket relationship is inferred.
A separately governed price binding would be needed before adding this enrichment.

For completed-day wording the capability check excludes the current London day
from its disclosed window. This does not mean any orders were retrieved for that
window. The general date planner's original context is retained; the capability
limitation makes no analytical evidence claim for it.

## Verification

The full repository run passed 1,107 tests, with zero failures and three opt-in
BigQuery syntax checks skipped. The subsequent internal model-to-UI bridge change
passed 89 focused worker/API tests. Tool-schema validation passed 46 strict schemas
across 61 registered tools. The final route-specific contract/presentation checks passed 55 tests. Desktop/mobile full-UI and presentation browser checks passed.
Earlier failed runs were corrected and rerun; no interrupted run is reported as a pass. The new tests exercise actual worker, router and
polling modules with empty, evidence-only, artifact-only, presentation-only,
clarification, nested, malformed and serialization-failure results. They cover
owner isolation, strict scope rejection, optional-source failure, lease rejection,
terminal persistence failure, bounded polling and same-ID retry. Existing suites
cover sales/comparisons, customers/conversion, campaigns, product clarification,
filtered exports, weekday/promotion analysis, chart contracts and recovered XLSX.

`diagnostics/oracle-result-delivery-browser.mjs` runs the actual UI, worker and
API at desktop (1280×900) and mobile (390×844), including direct answers,
refresh/reconnect, interrupted polling, markdown failure, partial checkpoints,
artifact links, details, scenario tables and the UK shipping limitation with
confirmed fixture promotion context. This is offline fixture acceptance; it does
not establish production delivery. No production analysis was submitted, and no
collection, backfill, inventory read, source/knowledge mutation, queue reset,
schedule change, deployment or merge was performed.

## Exact bounded read-only Render commands

From the Render service shell, using its configured credentials and checkout:

```sh
node diagnostics/oracle-analysis-incident.js 51bfebe0-0b84-480c-be2e-8803d5d10197 aa87e577-3d41-4244-87f9-9302d33f79b7
```

This reads dataset metadata plus at most one matching job, with a 100 MB billing
cap, 15-second query timeout and 25-second process deadline. It emits only route,
subject/date/channel codes, lifecycle metadata, JSON types, schema versions,
character/row/section/chart counts and presence flags. It does not print the
prompt, SQL parameters, owner key, analytical rows, provider arguments or answer.
An unavailable route binding does not itself prove that model tooling was wrong.
Correlated provider logs are still required to assess actual provider operations.

To inspect authenticated delivery with the **original incident owner's existing
browser session**, set `ORACLE_INCIDENT_SESSION_COOKIE` privately in the shell
(do not paste its value into logs or the PR), retain the configured
`ORACLE_UI_ORIGIN`, then run:

```sh
node diagnostics/oracle-incident-poll.js aa87e577-3d41-4244-87f9-9302d33f79b7
```

This issues one GET with a 15-second deadline and emits only safe delivery
metadata. A new login has a different session owner and cannot read the old job.
HTTP success alone still does not verify the browser. Refresh the original
owner's browser and confirm visible answer/partial/clarification/limitation,
accessible details/downloads and an enabled composer. Do not resubmit the
production incident to diagnose persisted delivery.

For inspection on the currently deployed checkout **without deploying this PR**,
the following standalone command uses existing dependencies and performs only
metadata/SELECT reads. It does not need the new scripts:

```sh
node --input-type=module <<'JS'
import {BigQuery} from '@google-cloud/bigquery';
const bounded=setTimeout(()=>{console.log(JSON.stringify({read_only:true,status:'unverified',code:'INSPECTION_DEADLINE'}));process.exit(1);},25000);
const safe=x=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(x||''))?String(x):null;
const identifier=x=>{if(!/^[A-Za-z0-9_-]+$/.test(x))throw Error('configuration');return x;};
try{
  const project=identifier(process.env.GOOGLE_PROJECT_ID||'gf-full-data');
  const dataset=identifier(process.env.ORACLE_JOB_DATASET||'commerce');
  const table=identifier(process.env.ORACLE_JOB_TABLE||'oracle_analysis_jobs_v1');
  const bq=new BigQuery({projectId:project,credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)});
  const [metadata]=await bq.dataset(dataset).getMetadata();
  const fq=String.fromCharCode(96)+project+'.'+dataset+'.'+table+String.fromCharCode(96);
  const [rows]=await bq.query({
    query:`SELECT job_id,status,error_code,attempts,
      JSON_VALUE(payload_json,'$.analysis_context.tool_route') route,
      JSON_VALUE(payload_json,'$.analysis_context.requested_subject') subject,
      JSON_TYPE(result_json) result_type,
      LENGTH(TRIM(COALESCE(JSON_VALUE(result_json,'$.answer'),''))) answer_characters,
      LENGTH(TRIM(COALESCE(JSON_VALUE(result_json,'$.presentation.summary_markdown'),''))) summary_characters,
      JSON_VALUE(result_json,'$.presentation.version') presentation_version,
      JSON_QUERY(result_json,'$.evidence') IS NOT NULL evidence_present,
      JSON_QUERY(result_json,'$.artifact') IS NOT NULL artifact_present,
      JSON_QUERY(result_json,'$.result') IS NOT NULL nested_result_present,
      ARRAY_LENGTH(JSON_QUERY_ARRAY(result_json,'$.evidence.results')) tool_result_count
      FROM ${fq}
      WHERE request_id=@request_id AND job_id=@job_id LIMIT 1`,
    params:{request_id:'51bfebe0-0b84-480c-be2e-8803d5d10197',job_id:'aa87e577-3d41-4244-87f9-9302d33f79b7'},
    location:metadata.location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'15000'
  });
  const r=rows[0];
  console.log(JSON.stringify({read_only:true,status:r?'found':'not_found',...(r?{
    job_id:safe(r.job_id),job_status:safe(r.status),error_code:safe(r.error_code),attempts:Number(r.attempts)||0,
    route:safe(r.route),subject:safe(r.subject),result_type:safe(r.result_type),
    answer_characters:Number(r.answer_characters)||0,summary_characters:Number(r.summary_characters)||0,
    presentation_version:safe(r.presentation_version),evidence_present:r.evidence_present===true,
    artifact_present:r.artifact_present===true,nested_result_present:r.nested_result_present===true,
    tool_result_count:Number(r.tool_result_count)||0,browser_delivery_verified:false}: {})}));
}catch(error){console.log(JSON.stringify({read_only:true,status:'unverified',code:safe(error.code)||'INSPECTION_UNAVAILABLE'}));process.exitCode=1;}
finally{clearTimeout(bounded);}
JS
```

## Production acceptance prompts after approved deployment

- “Analyse UK online GBP order-value bands this year through the latest completed
  day. Current free-shipping threshold £250, delivery £8 below it. Compare £175,
  £200, £225, £275 and £300 under unchanged purchasing behaviour; include add-on
  products and May sale context. Read only; no inventory or collection.” Expect
  explicit component limitations, promotion context only when confirmed, and no
  invented distribution, revenue effect or profit optimum. Refresh must preserve
  a meaningful visible outcome and stop loading.
- “Compare online sales this month with last month.” Then “Show details.”
- “Export Shopify pendants ranked by units sold this year.” Resolve the offered
  collection, download, then refresh. Population/owner checks remain strict.
- “Which weekdays have the most online sales this year? Account for the May sale.”
  Resolve any promotion date ambiguity; successful unadjusted evidence survives.
