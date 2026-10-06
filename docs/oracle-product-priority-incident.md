# Product-priority production incident

Base: freshly fetched `origin/main` / merge `207d282344920663880c18284339c0f71077cb58`, containing merged PR #292 / `1787286`. Branch: `fix/product-priority-production`.

## Demonstrated defects and uncertainty

The supplied successful attempt-1 claim rules out treating the earlier concurrent-update abort as the demonstrated terminal cause. The checkout contains the export route and production binding. GitHub's main revision was independently confirmed, then the normal fetch succeeded with network access permitted. No old branch, cherry-pick or recreated export implementation was used.

A bounded live incident lookup was attempted using the configured credentials and readiness helper. Sandbox access first returned EPERM. With network access permitted, dataset metadata access failed with HTTP 403, classified as EGRESS_FORBIDDEN (the OAuth refresh error was inspected internally, never printed). The persisted job, actual deployed revision, Shopify permissions/API responses and production artifact IAM/size therefore remain unverified. This change fixes reproduced failure-handling defects; it does not claim the historical terminal cause or a production acceptance pass.

Reproduced defects:

- Worker checkpoint/finish exceptions were silently converted to failures at generic `analysis`, even though the actual stage was known. The cancellation poll could also overwrite that stage.
- A returned result was lost if checkpoint persistence failed, even when a subsequent failure write could preserve it. Existing checkpointed evidence survived finish failure, but evidence produced before a failed checkpoint did not.
- Guarded BigQuery terminal UPDATEs returned empty result arrays whether they changed one row or zero. The worker logged success for a rejected lease. Terminal writes now use query-job affected-row metadata; ownership token, exact lease and expiration predicates remain mandatory.
- Failed-job artifact recovery bypassed evidence agreement validation before reporting completion.
- Export used Shopify helpers that logged provider response bodies. Quote redaction in job diagnostics still exposed unquoted exception text. Export transport and job diagnostics now emit bounded fields only; exact contention text is used internally solely for retry classification.

## Changes and production trace

`server.js` now uses `createProductionPriorityDependencies`, also exercised by regressions. It binds the existing Shopify shop/client credentials and 2026-07 API, the actual BigQuery client/project, persisted Shopify/GA4/Search Console loaders and the owner-scoped BigQuery export store. Provider fixture tests replace HTTP/BigQuery transports, not the route, ranking, workbook, artifact store or delivery implementation. OAuth and GraphQL both receive cancellation signals; HTTP errors, malformed bodies and known GraphQL permission/throttle codes become bounded diagnostics without printing bodies or credentials.

The path remains context → shared dispatch → all Shopify catalogue pages → isolated source enrichment → currency-safe ranking → one-sheet XLSX → owner-scoped persisted artifact → evidence agreement → worker checkpoint → guarded terminal write → authenticated download. New stage events distinguish storage readiness/read, catalogue, enrichment, ranking, workbook, persistence, read-back, evidence validation and terminal persistence. Artifact queries resolve the dataset's real location, matching the job-store convention. Source queries remain independent; source failures produce unavailable evidence and provisional/unranked results, never zeros.

Existing complete-catalogue requirements, validated joins, all-product retention, missing-versus-zero semantics, evidence-backed tasks, photography review defaults, exact five-column workbook, immutable bytes, refresh/reconnect and same-ID idempotency are retained. A failed later catalogue page remains explicitly incomplete; an unavailable catalogue never becomes a successful empty export. The 8 MB artifact guard remains an explicit failure, with no truncation or alternate ephemeral download.

## Validation

- Initial sandbox test invocation failed because local HTTP listeners were blocked. It is not a pass.
- Initial network-permitted focused run: 41 passed, 3 failed. Those three tests expected exception message output that was intentionally removed; their assertions were updated to require its absence.
- Production/export regressions: 32 passed, zero failed.
- Repository suite: `env -u SHOPIFY_INVENTORY_LOCATION_ID npm test -- --test-reporter=tap`: 857 passed, 3 existing skips, zero failed/cancelled (860 total). Inventory selector is cleared only for mocked fixture isolation; no inventory queries run.
- After final recovery/validation and cancellation-capture edits: export/context/dispatcher/chart focused suite 68 passed; worker/lease/contention focused suite 12 passed; zero failures/skips/cancellations. The full suite was not repeated after these final edits.
- Syntax checks and `git diff --check` passed.

Covered: real production factory/shared dispatch, interactive/durable authenticated downloads, complete pagination and API rejection, unavailable enrichment, currency/ID/URL contracts, generated XLSX, read/put failures and size limits, restart/manifest recovery, checkpoint and terminal failures, evidence mismatch, affected-row/lease rejection, narrow contention retries and same-ID submission without duplicate jobs. These are fixture-based regressions, not deployed provider verification.

## Exact bounded read-only Render inspection

Open the production **web service's Render Shell**, in its repository root. This standalone command works on deployed PR #292 code as well as this branch and does not need the new diagnostic file. It performs dataset metadata reads and at most two exact-correlated SELECTs, each LIMIT 1, 100 MB maximum billing and 15-second query timeout. It never calls setup, DDL, DML, collectors, inventory, knowledge mutations or retry/reset methods. Owner keys and artifact identifiers are used internally and excluded from output. Deployed revision is read from RENDER_GIT_COMMIT; its absence is reported rather than guessed.

```sh
node --input-type=module <<'NODE'
import { BigQuery } from '@google-cloud/bigquery';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const priorityArtifactId=(owner,request)=>createHash('sha256').update(JSON.stringify([owner,request])).digest('hex');
const detail=error=>{const outer=error?.errors?.[0];return outer?.errors?.[0]||outer;};
const bigQueryErrorDiagnostic=error=>({reason:safe(detail(error)?.reason||error?.reason||error?.code),...(detail(error)?.location?{location:safe(detail(error).location)}:{})});
const routeSource=await readFile('oracle/analysis-route-dispatcher.js','utf8').catch(()=>'');
const serverSource=await readFile('server.js','utf8').catch(()=>'');
const routeRegistered=routeSource.includes("'export_product_priorities'")&&/createProductPriorityService|createProductionPriorityDependencies/.test(serverSource);
const safe=value=>/^[A-Za-z0-9._-]{1,80}$/.test(String(value||''))?String(value):'unknown';
const identifier=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw Object.assign(new Error('identifier'),{code:'CONFIGURATION_INVALID'});return value;};
const failure=(stage,error,correlation)=>{const detail=bigQueryErrorDiagnostic(error);return {...correlation,stage,status:'failed',code:safe(error?.code),reason:/domain forbidden/i.test(String(error?.message||''))?'EGRESS_FORBIDDEN':detail.reason,...(detail.location?{location:detail.location}:{})};};

// SELECT and metadata only: never call job-store setup or export-store readiness.
// Even the returned diagnostic excludes owner keys, artifact IDs and row values.
async function inspectPriorityIncident({bigquery,project,dataset,table,requestId,jobId,revision}){
  const correlation={request_id:safe(requestId),job_id:safe(jobId)},stages=[];
  if(correlation.request_id==='unknown'||correlation.job_id==='unknown')throw Object.assign(new Error('correlation'),{code:'CORRELATION_INVALID'});
  stages.push({...correlation,stage:'deployment',status:/^[a-f0-9]{40}$/.test(revision||'')?'known':'unavailable',...(/^[a-f0-9]{40}$/.test(revision||'')?{code:revision}:{})});
  stages.push({...correlation,stage:'export_route_registration',status:routeRegistered?'registered':'missing'});
  let stage='job_dataset_metadata';
  try{
    const [metadata]=await bigquery.dataset(identifier(dataset)).getMetadata(),location=identifier(metadata.location);
    stages.push({...correlation,stage,status:'available',location});
    const run=async(query,params)=>(await bigquery.query({query,params,location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'15000',labels:{component:'oracle_incident'}}))[0];
    const fq=`\`${identifier(project)}.${identifier(dataset)}.${identifier(table)}\``;
    stage='persisted_job';
    const [job]=await run(`SELECT status,error_code,JSON_VALUE(result_json,'$.failed_stage') failed_stage,JSON_VALUE(payload_json,'$.analysis_context.tool_route') route,JSON_VALUE(payload_json,'$.export_owner') export_owner,JSON_VALUE(result_json,'$.artifact.id') artifact_id,JSON_VALUE(result_json,'$.evidence.manifest.artifact_reference') evidence_artifact_id FROM ${fq} WHERE job_id=@job_id AND request_id=@request_id LIMIT 1`,{job_id:jobId,request_id:requestId});
    if(!job){stages.push({...correlation,stage,status:'not_found'});return stages;}
    stages.push({...correlation,stage,status:safe(job.status),...(job.error_code?{code:safe(job.error_code)}:{})});
    if(job.failed_stage)stages.push({...correlation,stage:safe(job.failed_stage),status:'recorded_failure'});
    stages.push({...correlation,stage:'persisted_export_route',status:job.route==='export_product_priorities'?'registered':'different_or_missing'});
    stages.push({...correlation,stage:'evidence_checkpoint',status:job.evidence_artifact_id?'present':'absent'});
    const id=job.artifact_id||job.evidence_artifact_id||(job.export_owner?priorityArtifactId(job.export_owner,requestId):null);
    if(!id||!job.export_owner){stages.push({...correlation,stage:'artifact_reference',status:'unavailable'});return stages;}
    stage='artifact_metadata';
    const [artifact]=await run(`SELECT JSON_VALUE(artifact_json,'$.envelope.manifest.complete_catalogue') complete_catalogue,JSON_VALUE(artifact_json,'$.envelope.ranking_status') ranking_status FROM \`${identifier(project)}.${identifier(dataset)}.oracle_exports_v1\` WHERE artifact_id=@id AND owner_key=@owner LIMIT 1`,{id,owner:job.export_owner});
    stages.push({...correlation,stage,status:artifact?'persisted':'absent'});
    if(artifact){stages.push({...correlation,stage:'catalogue',status:artifact.complete_catalogue==='true'?'complete':'incomplete'});stages.push({...correlation,stage:'ranking',status:safe(artifact.ranking_status)});}
  }catch(error){stages.push(failure(stage,error,correlation));}
  return stages;
}
try {
  const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';
  const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'null');
  if(!credentials)throw Object.assign(new Error('configuration'),{code:'CREDENTIALS_MISSING'});
  const stages=await inspectPriorityIncident({bigquery:new BigQuery({projectId:project,credentials}),project,dataset:process.env.ORACLE_JOB_DATASET||'commerce',table:process.env.ORACLE_JOB_TABLE||'oracle_analysis_jobs_v1',requestId:'461cad81-5c32-4153-861a-565cec0a8e17',jobId:'aa85e1bd-b3da-4c46-8b2a-1ba03beab4de',revision:process.env.RENDER_GIT_COMMIT});
  console.log(JSON.stringify({read_only:true,stages}));
  if(stages.some(stage=>stage.status==='failed'))process.exitCode=1;
} catch(error) { console.log(JSON.stringify(failure('configuration',error,{})));process.exitCode=1; }
NODE
```

On a checkout containing this PR, the equivalent reusable command is:

```sh
node diagnostics/oracle-product-priority-incident.js \
  461cad81-5c32-4153-861a-565cec0a8e17 \
  aa85e1bd-b3da-4c46-8b2a-1ba03beab4de
```

Interpretation: `persisted_export_route=different_or_missing` means the job did not persist the new route; compare the deployment revision with the merge ancestry before attributing a provider fault. A recorded stage plus error code narrows the terminal failure. `artifact_metadata=persisted` and `evidence_checkpoint=absent` isolate a failure after artifact persistence but before checkpoint. `catalogue=incomplete` must never be called a complete export. `artifact_metadata=failed` identifies a bounded artifact read/IAM/location failure. Missing failure stage on an older checkpointed result is inconclusive; the prior worker did not persist the stage reliably. Do not reset or replay this job based only on a contention message.

## Oracle acceptance prompt

> Export all published Shopify products in priority order for photography and product-page improvements.

Verify completeness and provisional notes; download, refresh/reconnect, download again and explicitly retry the same request ID. Confirm one sheet, `Priority | Product | Product link | Work needed | Status`, every published product, clickable links and initial To do statuses. Verify a different authenticated owner cannot download it.
