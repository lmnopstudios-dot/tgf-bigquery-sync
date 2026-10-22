import {createHash,randomUUID} from 'node:crypto';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortExecutionOptions,COHORT_COMBINED_BOUNDARIES} from '../oracle/cohort-execution.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {answerCohortRetention} from '../oracle/cohort-retention.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
import {cohortWarehouseEvidence} from './cohort-warehouse-evidence.js';
import {safeReadFailure} from '../oracle/read-failure.js';
export const MATERIALIZED_REQUEST='Compare all governed collaborations and individual first-purchase items with sitewide retention from 2022-10-19 to 2026-10-19, observation cutoff 2026-10-19, Europe/London. Show provisional observed 90/180/360-day repeat rates, whole-range product rankings and second-order products across online and in-store orders.';
const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
const groups=['retention_windows','retention_piece_windows','retention_baseline_windows'];
const hash=s=>createHash('sha256').update(s).digest('hex');
export function materializedManifest(project='gf-full-data'){
 return {project,snapshot:identity.snapshot,statement_names:[...COHORT_COMBINED_BOUNDARIES],components:groups.map(group=>{
  const options=cohortExecutionOptions(customerJourneySql(project,group,null,null,identity,true),45000);
  return {group,script_sha256:hash(options.query),maximum_bytes_per_statement:options.maximumBytesBilled,data_statements:COHORT_COMBINED_BOUNDARIES.length+2,maximum_bytes_per_component:'20000000000'};
 })};
}
// Execute the deployed provider + orchestration + evidence/delivery validators,
// in memory. No HTTP report submission, durable job, publication or saved replay.
export async function acceptMaterializedRetention({bigquery,project,env=process.env,manifest,onCheck=()=>{}}){
 if(env.ORACLE_CUSTOMER_IDENTITY_MODE!=='email_candidate_v2'||env.ORACLE_CUSTOMER_IDENTITY_DATASET!==identity.dataset||env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT!==identity.snapshot)throw Error('Configured identity differs from the preserved scope');
 if(JSON.stringify(manifest)!==JSON.stringify(materializedManifest(project)))throw Error('Deployed materialized SQL differs from reviewed manifest');
 const context=transitionAnalysisContext(null,MATERIALIZED_REQUEST,{now:Date.parse('2026-10-22T12:00:00Z')}).context;
 if(context.start_date!=='2022-10-19'||context.end_date!=='2026-10-19'||context.observation_end!=='2026-10-19'||context.time_zone!=='Europe/London'||context.journey_group_by!=='collaboration_piece'||!context.retention_baseline||!context.retention_second_products)throw Error('Acceptance scope did not resolve exactly');
 const deadlineAt=Date.now()+45000,submitted=[],read_failures=[],seen=new Set();let allocations=0;
 const instrumented={query:bigquery.query.bind(bigquery),createQueryJob:async settings=>{
  if(++allocations>9)throw Error('Acceptance job allocation bound');
  const sql=settings.query;let component;
  if(sql.includes('retention_members')){
   component=manifest.components.find(c=>c.script_sha256===hash(sql));
   if(!component||seen.has(component.group)||!sql.startsWith('BEGIN TRANSACTION;')||settings.dryRun||settings.destination)throw Error('Unexpected population execution shape or duplicate component');
   if(String(settings.maximumBytesBilled)!==component.maximum_bytes_per_statement||String(settings.scriptOptions?.statementByteBudget)!==component.maximum_bytes_per_statement||Number(settings.jobTimeoutMs)>45000||Number(settings.scriptOptions?.statementTimeoutMs)>15000)throw Error('Production execution bounds differ from reviewed limits');
   seen.add(component.group);
  }else if(!sql.startsWith('SELECT state,start_date,end_date,mapping_count')&&!sql.includes('unmatched_profiles'))throw Error('Unexpected acceptance read');
  let response;try{response=await bigquery.createQueryJob(settings);}catch(error){const failure={component:component?.group||'identity_readiness',...safeReadFailure(error,'query_submission')};read_failures.push(failure);onCheck({phase:'query_submission_failed',...failure});throw error;}
  const [job,...rest]=response;
  if(component){submitted.push({...component,job_id:job.id,location:job.metadata?.jobReference?.location||'US'});onCheck({phase:'materialized_script_submitted',group:component.group,job_id:job.id,maximum_bytes_per_statement:component.maximum_bytes_per_statement});}
  return [job,...rest];
 }};
 const provider=createOracleProviderDependencies({bigquery:instrumented,project,env}).customerJourney;
 const result=await answerCohortRetention({context,provider,requestId:'retention-materialized-'+randomUUID(),deadlineAt});
 const delivered=deliverOracleResult(structuredClone(result),context),e=result.evidence||{};
 const source_outcomes=(e.source_outcomes||[]).map(o=>({group:o.group,state:o.state,stage:o.stage,code:o.code,provider_reason:o.provider_reason,http_status:o.http_status,bigquery_reason:o.bigquery_reason,error_category:o.error_category,statement_location:o.statement_location,query_id:o.query_id,population_read:o.population_read,validation_reason:o.validation_reason,identity:o.identity_evidence?{activation:o.identity_evidence.activation,mode:o.identity_evidence.mode,snapshot:o.identity_evidence.snapshot}:null}));
 onCheck({phase:'native_result_validation',delivery:delivered.delivery,source_outcomes,section_outcomes:e.section_outcomes||[]});
 const warehouse=[];
 for(const job of submitted){const evidence=await cohortWarehouseEvidence({bigquery,jobId:job.job_id,location:job.location});warehouse.push({group:job.group,...evidence});onCheck({phase:'materialized_child_execution',group:job.group,...evidence});}
 const expected=['transaction_setup',...COHORT_COMBINED_BOUNDARIES,'aggregation',...COHORT_COMBINED_BOUNDARIES.map(n=>'cleanup_'+n),'transaction_commit','result_select'];
 const stage_inspection_complete=warehouse.length===3&&warehouse.every(w=>w.parent?.outcome==='fulfilled'&&!w.children_truncated&&!w.inspection_errors.length&&expected.every(stage=>w.stages.some(s=>s.stage===stage&&s.outcome==='fulfilled')));
 const population_execution_passed=submitted.length===3&&source_outcomes.length===3&&source_outcomes.every(o=>o.state==='fulfilled'&&o.population_read==='completed'&&o.identity?.activation==='active'&&o.identity.snapshot===identity.snapshot);
 const result_validation_passed=['success','partial'].includes(delivered.delivery?.status)&&e.population_scope==='linked_tgf'&&(e.section_outcomes||[]).length===2&&e.section_outcomes.every(o=>o.state==='fulfilled');
 const catalogue=e.catalogue_reconciliation||[],catalogueIds=new Set(catalogue.map(c=>c.collection_id));
 const catalogue_complete=catalogue.length>0&&['ww','usd','shopify'].every(store=>{const ids=(e.catalogue_source_reconciliation||[]).filter(c=>c.source_store===store).map(c=>c.collection_id);return ids.length===catalogueIds.size&&ids.every(id=>catalogueIds.has(id));});
 return {read_only_business_data:true,persistent_writes:false,temporary_tables_only:true,report_replayed:false,report_published:false,
  execution_shape:'one_transaction_per_combined_component',population_execution_passed,result_validation_passed,stage_inspection_complete,catalogue_complete,
  acceptance_passed:population_execution_passed&&result_validation_passed&&stage_inspection_complete&&catalogue_complete,
  prior_full_select_compilation_passes_preserved:11,prior_synthetic_execution_passes_preserved:12,prior_checks_rerun:0,
  actual_script_jobs:submitted.length,maximum_population_bytes:'60000000000',population_deadline_ms:45000,read_failures,source_outcomes,section_outcomes:e.section_outcomes||[],
  result_summary:{retention_rows:e.rows?.length||0,sitewide_rows:e.baseline_rows?.length||0,period_rows:e.baseline_period_rows?.length||0,whole_range_rows:e.product_ranking_rows?.length||0,governed_collection_entries:catalogue.length},warehouse};
}
export const materializedAcceptanceFailure=error=>({acceptance_passed:false,phase:'acceptance_read',failure:safeReadFailure(error,'diagnostic'),report_replayed:false,persistent_writes:false});
