# #383 complete diagnostic decorrelation

## Confirmed production evidence

Mapping job `5ea59130-38b9-4b19-b567-2c0f885bd105` failed at CTAS 117:2. Updated entry-age job `72e0ddf4-0a3e-4f83-a25a-a880d8997baf` failed at CTAS 145:2. Both retained errors say: “Correlated subqueries that reference other tables are not supported unless they can be de-correlated.” The supplied paginated discovery completed with 247 records over ten pages and found the mapping execution. **Discovery is complete and must not be repeated.** The five earlier successful evidence reads remain preserved.

These locations identify the final CTAS statements rather than one uniquely rejected inner expression. Inspection of the complete final SELECTs found multiple table correlations. This fix removes those diagnostic correlations together instead of attributing the generic error to just one expression.

## Query changes and count preservation

- Mapping review now aggregates approved routes by source reference, conflicts and names by subject, and families by parent reference. Persisted SKU matches aggregate by Woo source and Shopify product before joining names/families; the final candidate array aggregates by Woo source. Empty arrays remain empty for missing evidence. Named-target filtering, title minimum, distinct SKU evidence, 11-candidate and 20-route limits remain intact. Archived eligible sales still participate; no relationship is inferred or approved.
- Mapping route-consumption flags now join distinct resolved named values and aggregate booleans per source/product before counting distinct products. Duplicate order lines or several resolved names cannot multiply the counts. The review queue and catalogue retain their independent projections and row bounds.
- Entry-age attribution now builds distinct named line keys and distinct named order keys, then left-joins them to historical lines and global first orders. Missing/conflicting classifications remain unmatched. Candidate-only products use an explicit anti-join and never become governed membership. Historical rows retain `SELECT DISTINCT`; all order/customer counts keep their original distinct keys.
- Trace product totals aggregate before joining one route-array row per source reference. Product inventory totals, dates, empty route arrays and the independent stage-count grid are preserved. Missing governance still retains a target and unknown stage counts; it is not converted into zero customers.

The diagnostic's previously corrected active-group/name left join is preserved. The accepted business-report factory, execution mechanism, eligibility exclusions, linked snapshot and provisional/verified coverage rules are unchanged. No persistent table or governance decision is written. All twelve accepted business-report full SELECT and synthetic query settings are byte-identical to the preceding reviewed artifact.

New regressions inspect both complete generated diagnostic shapes and their actual staged final CTAS. Local SQL fixtures compare old/new trace membership flags with duplicate lines/names, prior cross-platform entries, conflicting/missing classification and candidate-only products; mapping fixtures cover duplicate SKU pairs and route-consumption distinct counts. These SQLite compatibility executions and shape assertions **do not establish BigQuery compatibility**. The command below executes both complete corrected production diagnostic scripts against existing warehouse data; it does not stop at a dry-run DDL.

## One targeted Render follow-up command

Run from deployed `src`; no deployment is needed. One immutable artifact contains both corrected scripts. Exactly two independent diagnostic jobs are permitted, each retaining its own success or error. No ingestion-control reads, retained-error discovery, source collection or report replay occurs. Existing per-script limits remain 50 seconds warehouse, 55 seconds client, 15 seconds/statement and 500 MB/data statement. Mapping uses ten temporary input tables plus final result materialization; trace uses eleven plus final materialization. The command changes no production report limits.

```bash
timeout --signal=TERM --kill-after=5s 75s node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {BigQuery} from '@google-cloud/bigquery';
import {loadBigQueryConfig} from './bigquery/client.js';
import {boundedQuery} from './oracle/bounded-query.js';
import {reconcileRetentionCatalogue} from './oracle/retention-catalogue.js';
const revision='1981e23bc86b204337f9a85a652ce4cbaaadd0a4';
const clean=v=>String(v??'').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted]').slice(0,8000);
let allocations=0;
const emit=v=>console.log(JSON.stringify({report_replayed:false,persistent_business_writes:false,five_successful_reads_repeated:false,error_discovery_repeated:false,...v}));
try {
 const response=await fetch(`https://raw.githubusercontent.com/lmnopstudios-dot/tgf-bigquery-sync/${revision}/diagnostics/retention-mapping-coverage.json.gz`,{signal:AbortSignal.timeout(8000),redirect:'error'});
 assert.ok(response.ok,'Pinned artifact unavailable');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=262144,'Artifact bound');chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);assert.equal(createHash('sha256').update(bytes).digest('hex'),'ce6dbdd78895f92f70fbd2377e98e6944b09413cf87f49f3cd86663ddbee10b6');
 const artifact=JSON.parse(gunzipSync(bytes,{maxOutputLength:4194304}));
 const {project,credentials}=loadBigQueryConfig();assert.equal(project,'gf-full-data');assert.equal(artifact.project,project);
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_MODE,'email_candidate_v2');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_DATASET,'customer_identity');
 assert.equal(process.env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT,'history-20261022-billing-v3');
 const bq=new BigQuery({projectId:project,credentials,location:'US',autoRetry:false,maxRetries:0});
 const checks=[['corrected_mapping_review','mapping_settings'],['corrected_entry_age_trace','trace_settings']];
 const results=await Promise.allSettled(checks.map(async([check,key])=>{
  let query_id=null;
  try {
   const settings=artifact[key];assert.equal(settings.maximumBytesBilled,'500000000');assert.equal(settings.jobTimeoutMs,50000);
   for(const [name,type]of Object.entries(settings.types))if(type==='DATE'&&settings.params[name]!=null)settings.params[name]=BigQuery.date(settings.params[name]);
   const guarded={createQueryJob:async options=>{
    assert.ok(++allocations<=2,'Only two diagnostic queries allowed');assert.equal(options.query,artifact[key].query);
    assert.ok(!options.destination&&!options.dryRun);const result=await bq.createQueryJob(options);query_id=result[0].id;
    emit({check,phase:'allocated',query_id,query_sha256:createHash('sha256').update(options.query).digest('hex')});return result;
   }};
   const [rows]=await boundedQuery(guarded,settings,{maximumMs:55000});assert.equal(rows.length,1);const r=rows[0];
   if(key==='mapping_settings'){
    assert.ok(Array.isArray(r.review_rows)&&r.review_rows.length<=501);assert.ok(Array.isArray(r.catalogue));assert.ok(Array.isArray(r.route_consumption));
    const catalogue=[['woo','ww'],['woo','usd'],['shopify','shopify']].flatMap(([source_platform,source_store])=>reconcileRetentionCatalogue(r.catalogue.filter(c=>c.source_platform===source_platform&&c.source_store===source_store),[],{source_platform,source_store}));
    for(const c of catalogue)if(c.status==='truncated')c.status='eligible_matches_present';
    emit({check,status:'executed_envelope_validated',query_id,review_rows:r.review_rows.slice(0,500),review_truncated:r.review_rows.length>500||Number(r.review_rows[0]?.total_review_products)>500,catalogue,route_consumption:r.route_consumption,governance_written:false,coverage_certified:false});
   }else{
    assert.equal(r.targets?.length,2);assert.equal(r.stage_counts?.length,208);
    const keys=r.stage_counts.map(x=>[x.collection_id,x.stage,x.source_store].join('|'));assert.equal(new Set(keys).size,208);
    emit({check,status:'executed_envelope_validated',query_id,targets:r.targets,stage_counts:r.stage_counts,product_routes:(r.product_routes||[]).slice(0,200),product_routes_truncated:(r.product_routes||[]).length>200||Number(r.product_routes?.[0]?.total_product_rows)>200,coverage_certified:false});
   }
   return true;
  }catch(e){emit({check,status:'unresolved',query_id,http_status:Number(e.code)||null,message:clean(e.message),provider_errors:(e.errors||[]).slice(0,10).map(x=>({reason:x.reason,location:x.location,message:clean(x.message)}))});return false;}
 }));
 emit({phase:'two_corrected_diagnostics_complete',artifact_revision:revision,deployed_revision:process.env.RENDER_GIT_COMMIT||null,queries_submitted:allocations,checks:results.map((r,i)=>({check:checks[i][0],completed:r.status==='fulfilled'&&r.value===true,...(r.status==='rejected'?{message:clean(r.reason?.message)}:{})}))});
 if(results.some(r=>r.status!=='fulfilled'||r.value!==true))process.exitCode=1;
}catch(e){emit({status:'unavailable',message:clean(e.message),queries_submitted:allocations});process.exitCode=1;}
JS
```

Mapping execution returns raw governed/SKU evidence, required review actions and impact counts; candidate relationships still require the existing graph-safe review workflow. Successful execution of these diagnostics would establish query compatibility and return current warehouse evidence, not certify transaction coverage or approve mappings. The zero-denominator cause remains unresolved until the trace's returned stages are reviewed.

## Validation status

All 17 focused tests pass. The required full acceptance gate is running; desktop/mobile browser validation is running. Development Google access remains blocked by OAuth 403 `Domain forbidden`; no BigQuery compilation/execution pass is claimed. The two-job command is the remaining live compatibility/execution check, not a repeat of completed discovery.
