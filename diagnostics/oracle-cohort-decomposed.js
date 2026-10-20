import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {classificationDiagnosticOptions} from './oracle-classification-coverage.js';
import {cohortExecutionOptions,COHORT_BOUNDARIES,COHORT_STATEMENT_BYTES} from '../oracle/cohort-execution.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {retentionRows,retentionCoverage} from '../oracle/cohort-retention.js';
import {safeReadFailure} from '../oracle/read-failure.js';
import {cohortWarehouseEvidence} from './cohort-warehouse-evidence.js';

export async function diagnoseDecomposedCohort({bigquery,project,now=Date.parse('2026-10-19T12:00:00Z'),signal}){
 const started=performance.now(),deadlineAt=Date.now()+40000,events=[],clientStages=[];
 let jobId=null,location,validation,rows=[],retention=[],coverage=[],failure=null,sqlVerified=false;
 const measure=async(stage,work)=>{const start=performance.now();try{const result=await work();clientStages.push({stage,state:'fulfilled',elapsed_ms:Math.round(performance.now()-start)});return result;}
 catch(e){const safe=safeReadFailure(e,stage==='dry_run'?'population_dry_run':'population_query');clientStages.push({stage,state:'rejected',elapsed_ms:Math.round(performance.now()-start),failure:safe});failure={...safe,stage};throw e;}};
 const observe=scope=>e=>{
  if(scope==='execution'&&e.query_id){jobId=e.query_id;location=e.query_location||location;}
  if(events.length<60)events.push({scope,...e});
 };
 try{
  const settings=await measure('sql_generation',()=>classificationDiagnosticOptions({project,source:'woo',store:'ww',now,stage:'full'}));
  location=settings.location;
  [validation]=await measure('dry_run',()=>boundedQuery(bigquery,{...settings,dryRun:true},{maximumMs:15000,deadlineAt,signal,onProviderStage:observe('dry_run')}));
  sqlVerified=true;
  // Same execution options as the production customer-journey factory.
  [rows]=await measure('execution',()=>boundedQuery(bigquery,{...settings,...cohortExecutionOptions(settings.query,25000),useQueryCache:false},{maximumMs:25000,deadlineAt,signal,onProviderStage:observe('execution')}));
  await measure('evidence_validation',async()=>{
   retention=retentionRows(rows.filter(r=>r.window_days!=null));coverage=retentionCoverage(rows[0]?.coverage||[]);
   if(!retention.length||!retention.every(r=>r.source_platform==='woo'&&r.source_store==='ww')||coverage.length!==1||coverage[0].source_platform!=='woo'||coverage[0].source_store!=='ww')throw Object.assign(Error('Invalid cohort scope'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  });
 }catch{/* The sanitized failure and completed stages survive every execution failure. */}
 const warehouse=await cohortWarehouseEvidence({bigquery,jobId,location});
 const expected=['transaction_setup',...COHORT_BOUNDARIES,'aggregation',...COHORT_BOUNDARIES.map(n=>'cleanup_'+n),'transaction_commit','result_select'];
 const stageOutcomes=expected.map(stage=>warehouse.stages.find(s=>s.stage===stage)||{stage,outcome:'not_observed',elapsed_ms:null,job_id:null});
 const timingError=warehouse.inspection_errors.length||warehouse.children_truncated||stageOutcomes.some(s=>s.outcome==='not_observed'||s.elapsed_ms==null)?'STAGE_TIMINGS_UNVERIFIED':null;
 const failedStatement=warehouse.stages.find(s=>s.outcome==='rejected');
 const productionSuccess=!failure&&!timingError&&warehouse.parent?.outcome==='fulfilled'&&stageOutcomes.every(s=>s.outcome==='fulfilled');
 return {state:failure?'rejected':'fulfilled',production_success:productionSuccess,sql_verified:sqlVerified,failure,
  failure_layer:failure?.stage==='dry_run'?'dry_run':failure?.code==='ORACLE_AGENT_DEADLINE'?'overall_deadline':failure?.code==='REQUEST_CANCELLED'?'caller_abort':failedStatement?.stage||(warehouse.parent?.outcome==='rejected'?'script_execution':failure?events.findLast(e=>e.stage==='query_failed')?.phase||failure.stage:null),
  warehouse_failure_stage:failedStatement?.stage||null,
  action:productionSuccess?null:'Inspect failure, client_stages, events and warehouse; not_observed does not prove a statement ran. A 499 or stopped status alone does not identify the cancellation initiator.',
  job_id:jobId,source:'woo',store:'ww',job_timeout_ms:25000,statement_timeout_ms:15000,client_execution_deadline_ms:25000,total_client_bound_ms:45000,
  maximum_bytes_billed_per_statement:COHORT_STATEMENT_BYTES,maximum_execution_bytes_billed:'20000000000',validation_bytes:validation?.metadata?.statistics?.totalBytesProcessed??null,
  elapsed_ms:Math.round(performance.now()-started),client_stages:clientStages,events,warehouse,stage_outcomes:stageOutcomes,
  stage_timings:warehouse.stages,timing_error:timingError,retention,coverage,...(!failure?{rows}:{})};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const result=await diagnoseDecomposedCohort(createBigQueryClient());console.log(JSON.stringify(result,null,2));if(!result.production_success)process.exitCode=1;}
 catch(e){console.log(JSON.stringify({state:'rejected',production_success:false,failure:safeReadFailure(e,'diagnostic')}));process.exitCode=1;}
}
