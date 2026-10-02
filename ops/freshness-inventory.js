#!/usr/bin/env node
import {BigQuery} from '@google-cloud/bigquery';
import {createOracleToolDefinitions} from '../oracle/tool-registry.js';
import {ORACLE_SOURCE_CONTRACTS,freshnessAssessment} from '../oracle/freshness.js';
import {CONTROL_DATASET,sourceInspections} from './collector-runner.js';

const value=v=>v?.value??v??null;
const iso=v=>v==null?null:new Date(value(v)).toISOString();
const errorEvidence=(stage,error)=>({status:'inspection_failed',stage,error:String(error?.message||error).slice(0,300)});
async function query(bigquery,options){const [rows]=await bigquery.query(options);return rows;}

export function retiredCoverageSql(project,source){
  if(source!=='woo_metorik_retired')return null;
  return `SELECT CAST(MIN(order_date) AS STRING) coverage_start,CAST(MAX(order_date) AS STRING) coverage_end,COUNT(*) row_count FROM (SELECT DATE(order_created_at) order_date FROM \`${project}.metorik_uk.orders\` UNION ALL SELECT DATE(order_created_at) order_date FROM \`${project}.metorik_us.orders\`)`;
}

export function dependencyAudit(){
  const implemented=new Set(createOracleToolDefinitions().map(tool=>tool.name));
  return Object.fromEntries(Object.entries(ORACLE_SOURCE_CONTRACTS).map(([source,contract])=>[source,{registered:contract.tools,data_use_evidence:contract.tools.map(tool=>({tool,verification:tool==='get_klaviyo_email_performance'?'verified_direct_sql':tool==='compare_klaviyo_email_with_shopify_referrer'?'verified_cross_source_sql':'contract_declared',evidence:tool==='get_klaviyo_email_performance'?'oracle/klaviyo-email.js reads only klaviyo.message_performance and klaviyo.window_coverage':tool==='compare_klaviyo_email_with_shopify_referrer'?'oracle/klaviyo-email.js reads Klaviyo performance plus shopify_data session conversion referrer evidence':'source contract declaration; inspect the tool query/report assembly before changing this dependency'})),missing_implementations:contract.tools.filter(name=>!implemented.has(name)),implementations_registered:contract.tools.every(name=>implemented.has(name))}]));
}

async function inspectTables({bigquery,project,source}){
  const tables=[];
  for(const inspection of sourceInspections(project,source)){
    try{const options={query:inspection.query,params:inspection.params,types:inspection.types,useLegacySql:false};if(inspection.table==='window_coverage')await bigquery.createQueryJob({...options,dryRun:true});const rows=await query(bigquery,options);tables.push({table:inspection.table,kind:inspection.kind,role:inspection.role||null,status:'inspected',dry_run:inspection.table==='window_coverage'?'passed':null,...(rows[0]||{})});}
    catch(error){tables.push({table:inspection.table,kind:inspection.kind,role:inspection.role||null,...errorEvidence(`table:${inspection.table}`,error)});}
  }
  return tables;
}

async function genericRuns(bigquery,project,source){
  try{return await query(bigquery,{query:`SELECT status,started_at,finished_at,window_start,window_end FROM \`${project}.${CONTROL_DATASET}.collector_runs\` WHERE source=@source ORDER BY started_at DESC LIMIT 5`,params:{source}});}
  catch(error){return [errorEvidence('oracle_ops.collector_runs',error)];}
}

async function nativeEvidence(bigquery,project,source){
  try{
    if(source==='shopify_finance')return await query(bigquery,{query:`SELECT r.run_id,r.mode,r.status,r.window_start,r.window_end,r.started_at,r.finished_at,s.successful_watermark,s.updated_at state_updated_at,r.run_id=s.run_id state_owned_by_run FROM \`${project}.shopify_data.finance_refresh_runs\` r LEFT JOIN \`${project}.shopify_data.finance_refresh_state\` s ON s.collector='shopify_finance' ORDER BY r.started_at DESC LIMIT 20`});
    if(source==='klaviyo')return await query(bigquery,{query:`SELECT run_id,status,report_start,report_end,retrieved_at,started_at,completed_at,row_count FROM \`${project}.klaviyo.sync_status\` ORDER BY started_at DESC LIMIT 20`});
  }catch(error){return [errorEvidence(`native:${source}`,error)];}
  return [];
}

export function catchUp(source,tables,now,native=[]){
  const failed=tables.some(t=>t.status==='inspection_failed'&&(source!=='ga4'||t.role!=='ecommerce_instrumentation'));if(failed)return [];
  if(source==='klaviyo'){
    const collected=new Set((tables.find(t=>t.table==='window_coverage')?.windows||[]).filter(w=>w.status==='collected').map(w=>String(value(w.report_start)).slice(0,7)));
    const months=[...new Set(native.filter(r=>r.status==='failed').map(r=>String(value(r.report_start)).slice(0,7)).filter(m=>/^\d{4}-\d{2}$/.test(m)&&!collected.has(m)))].sort();
    return months.map(month=>`npm run backfill:klaviyo -- --from=${month} --through=${month} --max-months=1`);
  }
  const ends=tables.filter(t=>t.kind==='daily'&&t.role!=='ecommerce_instrumentation').map(t=>String(value(t.coverage_end)||'')).filter(Boolean).sort();
  if(!ends.length)return [];
  const start=new Date(`${ends[0]}T00:00:00Z`);start.setUTCDate(start.getUTCDate()-Math.max(0,ORACLE_SOURCE_CONTRACTS[source].late_change_overlap_days-1));const end=new Date(now);end.setUTCDate(end.getUTCDate()-ORACLE_SOURCE_CONTRACTS[source].availability_lag_days);const dates=[start.toISOString().slice(0,10),end.toISOString().slice(0,10)];
  if(dates[0]>dates[1])return [];
  if(source==='ga4')return [`npm run sync:ga4 -- --start ${dates[0]} --end ${dates[1]}`];
  if(source==='search_console')return [`npm run sync:search-console -- --start ${dates[0]} --end ${dates[1]}`];
  if(source==='shopify_conversion')return [`npm run backfill:shopify-conversion -- --mode repair --start ${dates[0]} --end ${dates[1]} --chunk-days 7 --max-chunks 2 --max-sources 40`];
  return [];
}

export async function inventory({bigquery,project,now=new Date()}){
  const out=[],dependencies=dependencyAudit();
  for(const [source,contract] of Object.entries(ORACLE_SOURCE_CONTRACTS)){
    if(contract.retired){let row={},execution_evidence=[];const sql=retiredCoverageSql(project,source);if(sql)try{[row]=await query(bigquery,{query:sql});}catch(error){execution_evidence=[errorEvidence('historical_coverage',error)];}out.push({...contract,source,table_inspections:[],historical_coverage:{start:row?.coverage_start||null,end:row?.coverage_end||null},actual_last_successful_source_collection:null,execution_evidence,recurring_collection:'retired_no_schedule',tool_dependencies:dependencies[source],bounded_catch_up_commands:[],assessment:freshnessAssessment({source,coverageStart:row?.coverage_start,coverageEnd:row?.coverage_end,storedDataAvailable:Number(row?.row_count)>0,now})});continue;}
    const table_inspections=await inspectTables({bigquery,project,source}),native_execution_evidence=await nativeEvidence(bigquery,project,source),oracle_ops_evidence=await genericRuns(bigquery,project,source);
    const good=table_inspections.filter(t=>t.status==='inspected'),stored=good.some(t=>Number(value(t.row_count))>0),inspectionFailed=table_inspections.some(t=>t.status==='inspection_failed');
    const nativeSuccess=native_execution_evidence.find(r=>r.status==='succeeded'),genericSuccess=oracle_ops_evidence.find(r=>r.status==='succeeded');
    const success=nativeSuccess||genericSuccess,lastSuccess=source==='klaviyo'?nativeSuccess?.retrieved_at:nativeSuccess?.finished_at||nativeSuccess?.state_updated_at||genericSuccess?.finished_at;
    const scheduledSuccess=native_execution_evidence.some(r=>r.status==='succeeded'&&r.mode==='scheduled');
    const starts=good.filter(t=>t.role!=='ecommerce_instrumentation').map(t=>value(t.coverage_start)).filter(Boolean).map(String).sort(),ends=good.filter(t=>(t.kind==='daily'||t.kind==='window')&&t.role!=='ecommerce_instrumentation').map(t=>value(t.coverage_end)).filter(Boolean).map(String).sort();
    const snapshotRetrieved=good.map(t=>value(t.snapshot_retrieved_at)||value(t.actual_retrieved_at)).filter(Boolean).map(String).sort().at(-1)||null;
    const ecommerce=source==='ga4'?good.filter(t=>t.role==='ecommerce_instrumentation').map(t=>({table:t.table,coverage_start:value(t.coverage_start),coverage_end:value(t.coverage_end),missing_dates:t.missing_dates||[],instrumentation_status_boundaries:t.instrumentation_status_boundaries||null,classification:'instrumentation_boundary_unverified'})):undefined;
    out.push({...contract,source,table_inspections,native_execution_evidence,oracle_ops_evidence,source_data_retrieved_at:iso(snapshotRetrieved),source_freshness_evidence:snapshotRetrieved?'verified_persisted_snapshot_timestamp':null,actual_last_successful_source_collection:iso(lastSuccess),collection_success_kind:nativeSuccess?.mode==='scheduled'?'scheduled':nativeSuccess?'manual_or_native_unspecified':genericSuccess?'orchestration_ledger':'none',verified_scheduled_execution:scheduledSuccess,tool_dependencies:dependencies[source],catch_up_basis:source==='ga4'?'current sessions/acquisition tables only; ecommerce tables cannot set the catch-up horizon':null,bounded_catch_up_commands:catchUp(source,table_inspections,now,native_execution_evidence),ecommerce_instrumentation:ecommerce?{status:'uncertain',context:'Shopify ecommerce tracking was corrected sometime in September 2026; exact date and affected events are unconfirmed.',table_evidence:ecommerce,limitations:['A collector catch-up can recover GA4-recorded events still available to the API; it cannot recreate events GA4 never recorded.','Assess sessions and acquisition separately from ecommerce events.','Use Shopify-native sales and conversion evidence with Shopify definitions; never splice it into GA4 metrics or infer zero sales from absent GA4 ecommerce events.']}:undefined,assessment:freshnessAssessment({source,coverageStart:starts[0],coverageEnd:ends[0],lastSuccess,sourceEvidenceAt:snapshotRetrieved,status:success?.status,storedDataAvailable:stored,scheduleVerified:scheduledSuccess,inspectionFailed,now})});
  }
  return {read_only:true,schedules_activated:false,historical_backfills_executed:false,audited_at:now.toISOString(),sources:out};
}

async function main(){const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),project=process.env.GOOGLE_PROJECT_ID||credentials.project_id;console.log(JSON.stringify(await inventory({project,bigquery:new BigQuery({projectId:project,credentials})}),null,2));}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(error.message);process.exitCode=1;});
