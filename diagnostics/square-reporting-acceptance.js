import {BigQuery} from '@google-cloud/bigquery';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadBigQueryConfig} from '../bigquery/client.js';
import {bigQueryDate,describeDateParameter} from '../bigquery/date-parameters.js';
import {identityConfiguration} from '../oracle/customer-identity.js';
import {customerJourneySql,validateJourneyDefinition} from '../oracle/customer-journey.js';
import {cohortExecutionPlan} from '../oracle/cohort-execution.js';
import {retentionRows,retentionDefinition} from '../oracle/cohort-retention.js';
import {productJourneyDefinition,validateProductJourneys} from '../oracle/product-journeys.js';
import {collaborationJourneyDefinition} from '../oracle/collaboration-product-journeys.js';
import {reportingCoverageText,JOURNEY_SCOPE_LIMITATION} from '../oracle/journey-scope.js';
import {safeSqlFailure} from './square-safe-sql-error.js';

export const ACCEPTANCE_LIMITS=Object.freeze({totalBytes:'5000000000',stageMs:60000,totalMs:240000,maxSubmissions:300,maxRows:1000});
export function reportingAcceptanceCases(){
 const base={analysis_type:'customer_journey',start_date:'2022-10-19',end_date:'2026-10-19',cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London'};
 const scope=(entry,followup,next='anywhere_then_filter')=>({version:'square_channels_v1',include_square:true,entry,followup,next});
 return [
  {name:'collaboration_retention_all_channels',definition:retentionDefinition({...base,journey_scope:scope('all','all'),entry_product_classification:'collaboration',journey_group_by:'collaboration_name',sort:'repeat_rate_desc'})},
  {name:'overall_instore_entry_next_anywhere',definition:productJourneyDefinition({...base,journey_scope:scope('instore','all')})},
  {name:'collaboration_online_entry_next_instore',definition:collaborationJourneyDefinition({...base,journey_scope:scope('online','instore','next_matching_channel')})}
 ].map(c=>({...c,definition:validateJourneyDefinition(c.definition)}));
}
export function acceptanceQueryPlan(project,identity,c){
 const d=c.definition,s=d.subsequent,e=d.cohort;
 const query=customerJourneySql(project,d.group_by[0],null,null,identity,true,d.report_scope,{state:'preview',version:'square_channels_v1'});
 return {...cohortExecutionPlan(query),params:{time_zone:d.time_zone,first_order_semantic:d.first_order_semantic,cohort_entry_start:d.cohort_entry_start,cohort_entry_end:d.cohort_entry_end,observation_end:d.observation_end,start_date:d.start_date,end_date:d.end_date,coverage_status:'unverified',coverage_start:null,coverage_end:null,coverage_evidence:null,entry_source:null,entry_channel:e.entry_channel,entry_product_ref:e.entry_product_ref,entry_classification:e.entry_product_classification,subsequent_source:null,subsequent_channel:s.channel,minimum_sequence:2,maximum_sequence:null,within_days:null,subsequent_product_ref:null,subsequent_classification:null,excluded_product_titles:[],include_unclassified:false,ranking_window:d.ranking_window,retention_source_store:null,retention_store_count:1,retention_sort:d.sort,limit:d.limit,cohort_limit:Math.floor(d.limit/3),matrixify_app_id:'gid://shopify/App/1758145'}};
}
export function selectedParameters(query,params){
 const lexical=query.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|(['"`])(?:\\.|(?!\1)[^\\])*?\1/g,' ');
 const names=new Set([...lexical.matchAll(/(?<!@)@([A-Za-z_][A-Za-z0-9_]*)/g)].map(m=>m[1]));
 const types={};const values={};
 for(const name of [...names].sort()){
  if(!Object.hasOwn(params,name)||params[name]===undefined)throw Error('Missing acceptance parameter');
  types[name]=['cohort_entry_start','cohort_entry_end','observation_end','start_date','end_date','coverage_start','coverage_end'].includes(name)?'DATE':['maximum_sequence','within_days','minimum_sequence','ranking_window','retention_store_count','cohort_limit','limit'].includes(name)?'INT64':name==='excluded_product_titles'?['STRING']:name==='include_unclassified'?'BOOL':'STRING';
  values[name]=types[name]==='DATE'&&params[name]!==null?bigQueryDate(params[name]?.value??params[name]):params[name];
 }
 return {params:values,types};
}
// Validate the installed SDK's actual scalar encoding before any data job.
// Only the seven fixed calendar parameters are exposed; no source data values.
export function dateBindingContract(bindings){
 return Object.entries(bindings.types).filter(([,type])=>type==='DATE').map(([name])=>{
  const value=bindings.params[name],wire=JSON.parse(JSON.stringify(BigQuery.valueToQueryParameter_(value,'DATE')));
  const encoded=wire.parameterValue?.value,intentionalNull=['coverage_start','coverage_end'].includes(name)&&value===null;
  if(intentionalNull?encoded!==null:typeof value?.value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.value)||encoded!==value.value)throw Object.assign(Error('Calendar DATE parameter failed SDK serialization'),{audit_reason:'invalid_calendar_date_binding'});
  return {name,...describeDateParameter(value),intentional_null:intentionalNull,sdk_encoded_value:encoded};
 });
}
function invalidPopulation(reason){return Object.assign(Error('Acceptance population evidence unavailable'),{audit_reason:reason});}
export function assertPopulationCheckpoint(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>4)throw invalidPopulation('empty_customer_history_population');
 const count=x=>x!=null&&x!==''&&typeof x!=='boolean'&&Number.isSafeInteger(Number(x))&&Number(x)>=0;
 if(new Set(rows.map(r=>r.source_platform+':'+r.source_store)).size!==rows.length||rows.some(r=>Object.keys(r).some(k=>!['source_platform','source_store','customer_history_orders','analytical_records'].includes(k))||!['woo:ww','woo:usd','shopify:shopify','square:square'].includes(r.source_platform+':'+r.source_store)||!count(r.customer_history_orders)||!count(r.analytical_records)||Number(r.analytical_records)>Number(r.customer_history_orders)))throw invalidPopulation('invalid_customer_history_population');
 if(!rows.some(r=>r.source_platform==='square'&&Number(r.customer_history_orders)>0&&Number(r.analytical_records)>0))throw invalidPopulation('missing_square_customer_history');
}
export function assertAggregateReport(rows,group){
 const visit=x=>{if(x&&typeof x==='object')for(const [key,v]of Object.entries(x)){if(/^(customer_id|source_customer_id|governed_customer_ref|canonical_customer_ref|order_id|order_ref|email|email_address|customer_name)$/.test(key))throw Error('Personal/order-level output refused');visit(v);}};
 visit(rows);if(!rows.length||rows.length>ACCEPTANCE_LIMITS.maxRows)throw Error('Incomplete acceptance report');
 const coverage=rows.find(r=>Array.isArray(r.reporting_coverage))?.reporting_coverage;if(!coverage?.length)throw invalidPopulation('empty_reporting_coverage');reportingCoverageText(coverage);
 if(!coverage.some(r=>r.source_platform==='square'&&r.eligible_transaction_orders>0&&r.eligible_orders>0))throw invalidPopulation('missing_square_reporting_coverage');
 if(group==='retention_product_journeys')validateProductJourneys(rows[0].product_journeys);
 else if(group==='retention_collaboration_journeys'){
  const data=rows[0].collaboration_journeys;if(!Array.isArray(data)||data.length>244)throw Error('Missing collaboration outputs');
  for(const type of ['overall','collaboration','item'])validateProductJourneys(data.filter(r=>r.cohort_type===type));
 }else retentionRows(rows.filter(r=>r.window_days!=null));
}
export async function acceptSquareReports({bigquery,project,identity,location,emit,now=Date.now}){
 let session,spent=0n,submissions=0,fatal=false;const started=now(),cache=new Map(),checkedPopulations=new Set(),outcomes=[];
 const connection=()=>session?{connectionProperties:[{key:'session_id',value:session}]}:{};
 const submit=async o=>{if(++submissions>ACCEPTANCE_LIMITS.maxSubmissions)throw Error('Submission bound');return bigquery.createQueryJob(o);};
 const cases=reportingAcceptanceCases().map(c=>({...c,plan:acceptanceQueryPlan(project,identity,c)}));
 const dateQuery='SELECT @cohort_entry_start,@cohort_entry_end,@observation_end,@start_date,@end_date,@coverage_start,@coverage_end';
 for(const c of cases)emit({stage:'date_parameter_contract',case:c.name,state:'validated_locally',bindings:dateBindingContract(selectedParameters(dateQuery,c.plan.params))});
 emit({stage:'manifest',preview_only:true,publication:false,activation:false,limits:ACCEPTANCE_LIMITS,prior_evidence:{eligible_linked_square_ids:1524,eligible_linked_square_orders:2026},cases:cases.map(c=>({name:c.name,scope:c.definition.report_scope})),limitation:JOURNEY_SCOPE_LIMITATION,temporary_storage:'Session temporary storage is separately metered until cleanup/automatic expiry.'});
 try{
  for(const c of cases){
   if(fatal)break;
   const plan=c.plan,physical=new Map();let stage,phase,sql='',activeSql='',job,planned,accounted=false;
   try{
    const all=[...plan.stages.flatMap(s=>[{name:s.name,query:s.query},...(s.name==='ranked_orders'?[{name:'population_check',population:true,query:'SELECT source_platform,source_store,COUNT(*) customer_history_orders,COUNT(DISTINCT governed_customer_ref) analytical_records FROM _SESSION.cohort_ranked_orders GROUP BY source_platform,source_store ORDER BY source_platform,source_store'}]:[])]),{name:'report',query:plan.result,result:true}];
    for(const s of all){
     stage=s.name;job=null;planned=null;accounted=false;
     if(now()-started>=ACCEPTANCE_LIMITS.totalMs||spent>=BigInt(ACCEPTANCE_LIMITS.totalBytes))throw Error('Time or cumulative billing ceiling reached');
     sql=s.query.replace(/_SESSION\.cohort_([a-z_]+)/g,(_m,n)=>{if(!physical.has(n))throw Error('Missing materialized dependency');return '_SESSION.'+physical.get(n);});
     const bindings=selectedParameters(sql,plan.params),hash=createHash('sha256').update(sql+JSON.stringify(bindings)).digest('hex');
     if(s.population&&checkedPopulations.has(hash)){emit({case:c.name,stage,state:'reused_validated_population'});continue;}
     if(!s.result&&!s.population&&cache.has(hash)){physical.set(s.name,cache.get(hash));emit({case:c.name,stage,state:'reused_compiled_and_executed'});continue;}
     const table='square_accept_'+hash.slice(0,32),remaining=String(BigInt(ACCEPTANCE_LIMITS.totalBytes)-spent);
     const options={useLegacySql:false,useQueryCache:false,location,...connection(),...bindings,maximumBytesBilled:remaining,jobTimeoutMs:Math.min(ACCEPTANCE_LIMITS.stageMs,ACCEPTANCE_LIMITS.totalMs-(now()-started))};
     phase='dry_run';activeSql=sql;try{
      const [dry]=await submit({...options,query:sql,dryRun:true});emit({case:c.name,stage,phase,state:'succeeded',query_sha256:createHash('sha256').update(sql).digest('hex'),stage_cache_key:hash,estimated_bytes:dry.metadata?.statistics?.totalBytesProcessed??dry.metadata?.statistics?.query?.totalBytesProcessed??null});
     }catch(e){
      const msg=String(e.errors?.[0]?.message||e.message||'');
      if(!(session&&/dry.?run/i.test(msg)&&/unsupported|not supported/i.test(msg)&&/session|temporary/i.test(msg)))throw e;
      emit({case:c.name,stage,phase,state:'unsupported_for_session',...safeSqlFailure(e,activeSql)});
     }
     phase='execute';const executionMs=Math.min(ACCEPTANCE_LIMITS.stageMs,ACCEPTANCE_LIMITS.totalMs-(now()-started));if(executionMs<=0)throw Error('Acceptance wall deadline');const execution=s.result||s.population?sql:`CREATE TEMP TABLE _SESSION.${table} AS\n${sql}`;
     activeSql=execution;planned='square_report_accept_'+randomUUID().replaceAll('-','');
     [job]=await submit({...options,jobTimeoutMs:executionMs,query:execution,jobId:planned,...(!session?{createSession:true}:{}),labels:{component:'square_report_acceptance',operation:'preview'}});
     session=job.metadata?.statistics?.sessionInfo?.sessionId||session;
     const [rows,next,response]=await job.getQueryResults({autoPaginate:false,maxResults:s.result||s.population?ACCEPTANCE_LIMITS.maxRows:1});
     const [m]=await job.getMetadata();session=m.statistics?.sessionInfo?.sessionId||session;
     const billed=m.statistics?.query?.totalBytesBilled;if(!/^\d+$/.test(String(billed??'')))throw Error('Authoritative billed bytes unavailable');
     spent+=BigInt(billed);accounted=true;if(spent>BigInt(ACCEPTANCE_LIMITS.totalBytes))throw Error('Cumulative billing invariant');
     if(m.status?.errorResult)throw m.status.errorResult;
     if(!session||m.status?.state!=='DONE'||next||response?.jobComplete===false)throw Error('Incomplete acceptance stage');
     emit({case:c.name,stage,phase,state:'succeeded',compiled_and_executed:true,query_sha256:createHash('sha256').update(execution).digest('hex'),billed_bytes:String(billed),cumulative_billed_bytes:String(spent)});
     if(s.population){if(response?.totalRows!=null&&String(response.totalRows)!==String(rows.length))throw Error('Incomplete population retrieval');assertPopulationCheckpoint(rows);checkedPopulations.add(hash);emit({case:c.name,stage,state:'population_validated',rows});}
     else if(!s.result){if(rows.length)throw Error('Unexpected materialization output');cache.set(hash,table);physical.set(s.name,table);}
     else{if(response?.totalRows!=null&&String(response.totalRows)!==String(rows.length))throw Error('Incomplete aggregate retrieval');assertAggregateReport(rows,c.definition.group_by[0]);emit({case:c.name,stage:'aggregate_results',state:'succeeded',preview_only:true,definition:c.definition,rows});}
    }
    outcomes.push({case:c.name,state:'succeeded'});
   }catch(e){
    outcomes.push({case:c.name,state:'failed'});if(stage==='population_check')fatal=true;emit({case:c.name,stage,phase,state:'failed',counts:'unknown',validation_reason:['invalid_calendar_date_binding','empty_customer_history_population','invalid_customer_history_population','missing_square_customer_history','empty_reporting_coverage','missing_square_reporting_coverage'].includes(e.audit_reason)?e.audit_reason:null,...safeSqlFailure(e,activeSql)});
    if(job||planned)try{
     const [m]=await(job||bigquery.job(planned,{location})).getMetadata();session=m.statistics?.sessionInfo?.sessionId||session;
     emit({case:c.name,stage,phase:'existing_job_metadata',allocated:true,state:m.status?.state,error:m.status?.errorResult?safeSqlFailure(m.status.errorResult,activeSql):null});
     // A failed submission/results retrieval has uncertain charge accounting.
     // Never start another data statement until it has been safely reconciled.
     if(!accounted){const bytes=m.statistics?.query?.totalBytesBilled;if(m.status?.state==='DONE'&&/^\d+$/.test(String(bytes??''))){spent+=BigInt(bytes);accounted=true;}else fatal=true;}
     if(spent>BigInt(ACCEPTANCE_LIMITS.totalBytes))fatal=true;if(m.status?.state!=='DONE')await(job||bigquery.job(planned,{location})).cancel();
    }catch(meta){fatal=true;emit({case:c.name,phase:'existing_job_metadata',allocated:Number(meta.code)===404?false:'unknown',...safeSqlFailure(meta)});}
   }
  }
 }finally{
  if(session)try{const [j]=await submit({query:'CALL BQ.ABORT_SESSION(@session)',params:{session},location,useLegacySql:false,maximumBytesBilled:'0',jobTimeoutMs:10000});await j.getQueryResults({autoPaginate:false,maxResults:1});emit({stage:'session_cleanup',state:'succeeded'});}catch(e){fatal=true;emit({stage:'session_cleanup',state:'failed',...safeSqlFailure(e)});}
 }
 for(const c of cases)if(!outcomes.some(o=>o.case===c.name))outcomes.push({case:c.name,state:'skipped',reason:'shared_population_or_execution_unavailable'});
 emit({stage:'acceptance_summary',preview_only:true,outcomes,known_billed_bytes:String(spent),execution_ceiling_bytes:ACCEPTANCE_LIMITS.totalBytes});
 return !fatal&&outcomes.length===cases.length&&outcomes.every(x=>x.state==='succeeded');
}
export async function main(){
 const emit=x=>console.log(JSON.stringify(x,(_k,v)=>typeof v==='bigint'?String(v):v));
 try{
  if(process.argv.length!==2)throw Error('No arguments supported');
  const identity=identityConfiguration();if(!identity?.orderLinks||identity.mode!=='email_candidate_v2')throw Error('Existing v2 identity configuration required');
  const {project,credentials}=loadBigQueryConfig(),bigquery=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
  const [ds]=await bigquery.dataset('square_data').getMetadata();
  if(!await acceptSquareReports({bigquery,project,identity,location:ds.location,emit}))process.exitCode=2;
 }catch(e){emit({stage:'configuration_region_or_preflight',state:'failed',counts:'unknown',validation_reason:e.audit_reason==='invalid_calendar_date_binding'?e.audit_reason:null,...safeSqlFailure(e)});process.exitCode=2;}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)await main();
