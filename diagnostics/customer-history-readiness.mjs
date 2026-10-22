import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {READINESS_AUDIT_FIELDS,auditSchema,readinessAuditSql,auditMatchesRepair,readinessFailure} from './customer-history-readiness-audit.js';
export async function main({clientFactory,emit=console.log}={}) {
const P='gf-full-data',D='customer_identity',S='history-20261022-billing-v3';
const KEEP='2026-10-22T07:31:49.447Z';
const log=x=>emit(JSON.stringify({read_only:true,...x}));
const controller=new AbortController();
let failed=false;
let stage='load_deployed_contract',stageNow='configuration',rejected=null;
const jobs=new Map(),allocated=new Map(),captured={};let readinessPassed=false,auditPassed=false;
const stop=setTimeout(()=>{controller.abort();log({check:'deadline',status:'incomplete',stage,pending_owned_jobs:[...jobs.keys()]});process.exit(2);},55000);
const signals=['SIGTERM','SIGINT'].map(signal=>{const handler=()=>{controller.abort();log({check:'stopped',signal,stage,owned_jobs:[...jobs.keys()]});process.exit(2);};process.once(signal,handler);return [signal,handler];});
const need=(v,s)=>{if(!v)throw Object.assign(Error(),{diagnostic_reason:s});};
const sha=s=>createHash('sha256').update(s).digest('hex');
const safe=readinessFailure;

try {
  const root=fileURLToPath(new URL('../',import.meta.url)),file=resolve(root,'oracle/customer-identity.js');
  const source=await readFile(file,'utf8');
  // Observe the swallowed readiness exception without changing deployed files.
  const anchor=/\}\s*catch\s*\(error\)\s*\{\s*(?=if\s*\(args\[1\]\?\.signal\?\.aborted)/g;
  need([...source.matchAll(anchor)].length===1,'unsupported_reader_catch_shape');
  let instrumented=source.replace(anchor,match=>match+'options.__readinessRejected(error);\n');
  instrumented=instrumented.replace(/(from\s+)(['"])(\.[^'"]+)\2/g,(_,prefix,quote,specifier)=>prefix+quote+new URL(specifier,pathToFileURL(file)).href+quote);
  const reader=await import('data:text/javascript;base64,'+Buffer.from(instrumented).toString('base64'));
  const load=p=>import(pathToFileURL(resolve(root,p)).href);
  const [{createBigQueryClient},{SCOPE},{HISTORY_SCOPE},{customerEvidenceSql},{boundedQuery}]=await Promise.all([
    load('bigquery/client.js'),load('customer-identity/collect.js'),load('customer-identity/history-sql.js'),load('oracle/customer-query.js'),load('oracle/bounded-query.js')
  ]);
  const {bigquery:bq,project}=(clientFactory||createBigQueryClient)();
  const env={...process.env,ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:D,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:S};
  const {BigQuery}=await import('@google-cloud/bigquery');
  const BigQueryTimestamp=x=>BigQuery.timestamp(x);
  const config=reader.identityConfiguration(env);
  need(config?.orderLinks===true,'v2_order_link_configuration_not_resolved');
  log({check:'deployed_contract',reader_sha256:sha(source),reader_integrity_guard:typeof reader.orderSnapshotGuardSql==='function',render_commit:/^[a-f0-9]{7,64}$/.test(process.env.RENDER_GIT_COMMIT||'')?process.env.RENDER_GIT_COMMIT:null,resolved_project:project,expected_project:P,requested_mode:'email_candidate_v2',reader_mode_label:config.mode,order_links:config.orderLinks,expected_start:HISTORY_SCOPE.start,expected_end:SCOPE.end,history_scope_end:HISTORY_SCOPE.end,snapshot:S,readiness_limit_ms:5000,analytical_queries:'suppressed'});
  need(project===P,'configured_project_differs_from_repaired_project');
  const markerSQL=`SELECT state,start_date,end_date,mapping_count FROM \`${P}.${D}.identity_snapshots\` WHERE snapshot_id=@snapshot LIMIT 2`;
  const coverageSQL=reader.identityCoverageSql(customerEvidenceSql(project),project,config);
  const originalCreate=bq.createQueryJob.bind(bq);
  let readerSubmissions=0;
  bq.createQueryJob=async settings=>{
    const kind=settings.query===markerSQL?'snapshot_read':settings.query===coverageSQL?'identity_coverage':'aggregate_contract_audit';
    if(stage==='actual_readiness') {
      need(kind!=='aggregate_contract_audit'&&++readerSubmissions<=2,'unexpected_reader_query');
      need(Number(settings.jobTimeoutMs)<=5000,'reader_budget_changed');
    } else need(stage==='aggregate_contract_audit'&&kind==='aggregate_contract_audit'&&/^WITH\s/i.test(settings.query.trim()),'unexpected_query');
    stageNow=kind;
    const id='readiness_probe_'+randomUUID().replaceAll('-','');
    log({check:'query_submission',readiness_stage:kind,proposed_job_id:id,server_limit_ms:settings.jobTimeoutMs,maximum_bytes_billed:settings.maximumBytesBilled});
    const result=await originalCreate({...settings,jobId:id,useQueryCache:false});
    const job=result[0];jobs.set(job.id,kind);allocated.set(job.id,{job,kind,cap:String(settings.maximumBytesBilled)});
    log({check:'query_allocated',readiness_stage:kind,job_id:job.id});
    const metadata=job.getMetadata?.bind(job);
    if(metadata)job.getMetadata=async(...args)=>{const r=await metadata(...args);if(r[0]?.status?.state==='DONE')jobs.delete(job.id);return r;};
    const get=job.getQueryResults.bind(job);
    job.getQueryResults=async(...args)=>{
      const r=await get(...args);
      if(r[2]?.jobComplete===true&&!r[1]) {
        if(kind!=='aggregate_contract_audit')captured[kind]=r[0];
        jobs.delete(job.id);
      }
      return r;
    };
    return result;
  };
  const factory=options=>({analyzeCustomerJourney:async()=>({diagnostic_analytical_path_suppressed:true,path:options.identity?'identity':'fallback'})});
  stage='actual_readiness';
  try {
    const service=reader.identityAwareService({bigquery:bq,project,env,__readinessRejected:error=>{
      rejected={...safe(error),readiness_stage:error.history_diagnostic?.stage||stageNow,job_id:error.history_diagnostic?.job_id||[...jobs.keys()].at(-1)||null};
      log({check:'original_readiness_rejection',...rejected});
    }},factory,customerEvidenceSql);
    const result=await service.analyzeCustomerJourney({start_date:HISTORY_SCOPE.start,end_date:HISTORY_SCOPE.end,group_by:['summary']},{timeoutMs:20000,decompose:false,signal:controller.signal});
    readinessPassed=result.identity_evidence?.activation==='active'&&result.identity_evidence.mode==='email_candidate_v2';
    log({check:'reader_decision',readiness_passed:result.identity_evidence?.activation==='active',fallback_selected:result.identity_evidence?.activation==='fallback',reported_fallback_reason:result.identity_evidence?.reason||null,reader_mode:result.identity_evidence?.mode||null,analytical_query_executed:false});
  } catch(e) {failed=true;log({check:'readiness_probe_failed',...safe(e)});}
  for(const [name,rows] of Object.entries(captured)) {
    if(name==='snapshot_read') {
      log({check:'marker_contract',returned_rows:rows.length,ready_rows:rows.filter(r=>r.state==='ready').length,expected_start_rows:rows.filter(r=>(r.start_date?.value||r.start_date)===HISTORY_SCOPE.start).length,expected_end_rows:rows.filter(r=>(r.end_date?.value||r.end_date)===SCOPE.end).length,positive_mapping_count_rows:rows.filter(r=>Number(r.mapping_count)>0).length,distinct_mapping_counts:[...new Set(rows.map(r=>Number(r.mapping_count)))]});
    } else {
      const keys=['identified_profiles','mapped_profiles','unmatched_profiles','qualifying_orders','matched_orders','unmatched_orders','ambiguous_orders','unavailable_orders','email_linked_guest_or_unknown_records','conflicting_orders','shared_address_orders'];
      log({check:'coverage_contract',returned_rows:rows.length,distinct_sources:new Set(rows.map(r=>r.source_store)).size,total_qualifying_orders:rows.reduce((n,r)=>n+Number(r.qualifying_orders),0),sources:rows.map(r=>{
        const values=Object.fromEntries(keys.map(k=>[k,Number(r[k])]));
        return {source:['ww','usd','shopify'].includes(r.source_store)?r.source_store:'unexpected_source',...values,invalid_numeric_fields:keys.filter(k=>!Number.isSafeInteger(values[k])||values[k]<0),profile_partition_valid:values.mapped_profiles+values.unmatched_profiles===values.identified_profiles,order_partition_valid:values.matched_orders+values.unmatched_orders+values.ambiguous_orders+values.unavailable_orders===values.qualifying_orders};
      })});
    }
  }
  // Independent aggregate audit: does not change/retry the actual reader's limits.
  stage='aggregate_contract_audit';
  const sql=readinessAuditSql(project,D);
  try {
    for(const [name,fields] of Object.entries(READINESS_AUDIT_FIELDS)) {
      const [meta]=await bq.dataset(D).table(name).getMetadata();
      const result=auditSchema(meta,fields);
      log({check:'audit_schema',table:name,...result});
      need(result.valid,'audit_schema_mismatch');
    }
    const [rows]=await boundedQuery(bq,{query:sql,location:'US',params:{snapshot:S,reader_start:HISTORY_SCOPE.start,reader_end:SCOPE.end,keep_created_at:BigQueryTimestamp(KEEP)},maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:15000},{maximumMs:15000,signal:controller.signal});
    need(rows.length===1,'invalid_audit_result');auditPassed=auditMatchesRepair(rows[0]);
    log({check:'aggregate_contract_audit',evidence:rows[0],matches_successful_repair:auditPassed,prior_successful_repair:'accepted; no repair/backups replayed'});
  } catch(e) {log({check:'aggregate_contract_audit',status:'unknown',query_sha256:sha(sql),...safe(e)});}
  // Outside the reader's five-second waits: report actual uncached billing.
  await Promise.all([...allocated].map(async([id,{job,kind,cap}])=>{
    try {
      const [meta]=await job.getMetadata();
      log({check:'query_statistics',readiness_stage:kind,job_id:id,maximum_bytes_billed:cap,cache_hit:meta.statistics?.query?.cacheHit??null,total_bytes_processed:meta.statistics?.query?.totalBytesProcessed??null,total_bytes_billed:meta.statistics?.query?.totalBytesBilled??null,state:meta.status?.state||null,...(meta.status?.errorResult?{failure:safe({errors:meta.status.errors||[meta.status.errorResult]})}:{})});
    } catch(e) {log({check:'query_statistics',job_id:id,status:'unknown',...safe(e)});}
  }));
  if(!readinessPassed||!auditPassed)failed=true;
  log({check:'summary',readiness_verified:readinessPassed,audit_verified:auditPassed,original_readiness_reason_captured:!!rejected,production_data_mutations:0,activation_performed:false,remaining_owned_jobs:[...jobs.keys()],limitation:'This observes current readiness. It cannot recover a swallowed exception from the earlier failed invocation; a current pass does not disprove a transient earlier failure.'});
} catch(e) {log({check:'diagnostic',stage,status:'stopped',...safe(e)});failed=true;}
finally {clearTimeout(stop);for(const [signal,handler] of signals)process.off(signal,handler);}
return failed?2:0;

}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)process.exitCode=await main();
