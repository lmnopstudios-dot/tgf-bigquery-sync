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
  return Object.fromEntries(Object.entries(ORACLE_SOURCE_CONTRACTS).map(([source,contract])=>[source,{registered:contract.tools,missing_implementations:contract.tools.filter(name=>!implemented.has(name)),valid:contract.tools.every(name=>implemented.has(name))}]));
}

async function inspectTables({bigquery,project,source}){
  const tables=[];
  for(const inspection of sourceInspections(project,source)){
    try{const rows=await query(bigquery,{query:inspection.query});tables.push({table:inspection.table,kind:inspection.kind,status:'inspected',...(rows[0]||{})});}
    catch(error){tables.push({table:inspection.table,kind:inspection.kind,...errorEvidence(`table:${inspection.table}`,error)});}
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

function catchUp(source,tables,now,native=[]){
  const failed=tables.some(t=>t.status==='inspection_failed');if(failed)return [];
  if(source==='klaviyo'){
    const collected=new Set((tables.find(t=>t.table==='window_coverage')?.windows||[]).filter(w=>w.status==='collected').map(w=>String(value(w.report_start)).slice(0,7)));
    const months=[...new Set(native.filter(r=>r.status==='failed').map(r=>String(value(r.report_start)).slice(0,7)).filter(m=>/^\d{4}-\d{2}$/.test(m)&&!collected.has(m)))].sort();
    return months.map(month=>`npm run backfill:klaviyo -- --from=${month} --through=${month} --max-months=1`);
  }
  const ends=tables.filter(t=>t.kind==='daily').map(t=>String(value(t.coverage_end)||'')).filter(Boolean).sort();
  if(!ends.length)return [];
  const start=new Date(`${ends[0]}T00:00:00Z`);start.setUTCDate(start.getUTCDate()-ORACLE_SOURCE_CONTRACTS[source].late_change_overlap_days);const end=new Date(now);end.setUTCDate(end.getUTCDate()-ORACLE_SOURCE_CONTRACTS[source].availability_lag_days);const dates=[start.toISOString().slice(0,10),end.toISOString().slice(0,10)];
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
    const scheduledSuccess=[...native_execution_evidence,...oracle_ops_evidence].some(r=>r.status==='succeeded'&&(r.mode==='scheduled'||oracle_ops_evidence.includes(r)));
    const starts=good.map(t=>value(t.coverage_start)).filter(Boolean).map(String).sort(),ends=good.filter(t=>t.kind==='daily'||t.kind==='window').map(t=>value(t.coverage_end)).filter(Boolean).map(String).sort();
    out.push({...contract,source,table_inspections,native_execution_evidence,oracle_ops_evidence,actual_last_successful_source_collection:iso(lastSuccess),collection_success_kind:nativeSuccess?.mode==='scheduled'?'scheduled':nativeSuccess?'manual_or_native_unspecified':genericSuccess?'orchestration_ledger':'none',verified_scheduled_execution:scheduledSuccess,tool_dependencies:dependencies[source],bounded_catch_up_commands:catchUp(source,table_inspections,now,native_execution_evidence),assessment:freshnessAssessment({source,coverageStart:starts[0],coverageEnd:ends[0],lastSuccess,status:success?.status,storedDataAvailable:stored,scheduleVerified:scheduledSuccess,inspectionFailed,now})});
  }
  return {read_only:true,schedules_activated:false,historical_backfills_executed:false,audited_at:now.toISOString(),sources:out};
}

async function main(){const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),project=process.env.GOOGLE_PROJECT_ID||credentials.project_id;console.log(JSON.stringify(await inventory({project,bigquery:new BigQuery({projectId:project,credentials})}),null,2));}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(error.message);process.exitCode=1;});
