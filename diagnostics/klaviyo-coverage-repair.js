#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {BigQuery} from '@google-cloud/bigquery';
import {createBigQueryClient} from '../bigquery/client.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
import {resolveReportWindow} from '../klaviyo/discovery.js';
import {serializeAttributionSettings} from '../klaviyo/sync.js';

const CONFIG_URL=new URL('../config/klaviyo-account.json',import.meta.url);
export const REPAIR_MONTHS=Object.freeze(['2026-08','2026-09']);
export const HISTORY_MONTHS=Object.freeze(['2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06','2026-07',...REPAIR_MONTHS]);
const safe=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid BigQuery identifier');return value};

export function repairWindows(timezone){return REPAIR_MONTHS.map(month=>{const start=`${month}-01T00:00:00`,date=new Date(`${month}-01T00:00:00Z`);date.setUTCMonth(date.getUTCMonth()+1);const end=`${date.toISOString().slice(0,10)}T00:00:00`,resolved=resolveReportWindow({timezone,start,end});return {month,report_start:resolved.startInstant,report_end:resolved.endInstant};});}

function windowCte(){return `windows AS (SELECT month_value AS month,report_start_value AS report_start,report_end_value AS report_end FROM UNNEST(@months) month_value WITH OFFSET month_offset JOIN UNNEST(@report_starts) report_start_value WITH OFFSET start_offset ON month_offset=start_offset JOIN UNNEST(@report_ends) report_end_value WITH OFFSET end_offset ON month_offset=end_offset)`;}

/** Existing report rows are candidates, never completeness evidence by themselves. */
export function repairAuditQuery(project){safe(project);return `WITH ${windowCte()},
successful_runs AS (SELECT w.month,s.run_id,s.started_at,s.completed_at,s.retrieved_at,s.row_count,ROW_NUMBER() OVER(PARTITION BY w.month ORDER BY s.completed_at DESC,s.started_at DESC)=1 latest FROM windows w JOIN \`${project}.klaviyo.sync_status\` s ON s.report_start=w.report_start AND s.report_end=w.report_end WHERE s.status='succeeded' AND s.completed_at IS NOT NULL AND s.retrieved_at IS NOT NULL),
reports AS (SELECT w.month,COUNT(r.report_kind) row_count,COUNT(DISTINCT TO_JSON_STRING(STRUCT(r.report_kind,r.entity_id,r.message_id,r.report_start,r.report_end,r.conversion_metric_id))) identity_count,ARRAY_AGG(DISTINCT r.report_kind IGNORE NULLS ORDER BY r.report_kind) report_kinds,ARRAY_AGG(DISTINCT r.conversion_metric_id IGNORE NULLS ORDER BY r.conversion_metric_id) metric_ids,ARRAY_AGG(DISTINCT r.currency IGNORE NULLS ORDER BY r.currency) currencies,ARRAY_AGG(DISTINCT r.reporting_timezone IGNORE NULLS ORDER BY r.reporting_timezone) timezones,ARRAY_AGG(DISTINCT r.attribution_settings IGNORE NULLS ORDER BY r.attribution_settings) attribution_settings,MIN(r.retrieved_at) min_retrieved_at,MAX(r.retrieved_at) max_retrieved_at FROM windows w LEFT JOIN \`${project}.klaviyo.message_performance\` r ON r.report_start=w.report_start AND r.report_end=w.report_end GROUP BY w.month),
coverage AS (SELECT w.month,COUNTIF(c.status='collected') collected_rows FROM windows w LEFT JOIN \`${project}.klaviyo.window_coverage\` c ON c.report_start=w.report_start AND c.report_end=w.report_end AND c.reporting_timezone=@timezone GROUP BY w.month)
SELECT w.month,w.report_start,w.report_end,s.run_id,s.started_at,s.completed_at,s.retrieved_at run_retrieved_at,s.row_count run_row_count,r.row_count,r.identity_count,r.report_kinds,r.metric_ids,r.currencies,r.timezones,r.attribution_settings,r.min_retrieved_at,r.max_retrieved_at,c.collected_rows,
  s.run_id IS NOT NULL AND r.row_count>0 AND r.row_count=r.identity_count AND r.row_count=s.row_count AND r.min_retrieved_at=s.retrieved_at AND r.max_retrieved_at=s.retrieved_at AND r.report_kinds=['campaign','flow'] AND r.metric_ids=@metric_ids AND r.currencies=[@currency] AND r.timezones=[@timezone] AND r.attribution_settings=[@attribution_settings] AS evidence_complete,
  CASE WHEN c.collected_rows>0 THEN 'already_collected' WHEN s.run_id IS NULL THEN 'refresh_required_no_successful_run' WHEN r.row_count=0 THEN 'refresh_required_no_exact_rows' WHEN r.report_kinds!=['campaign','flow'] THEN 'refresh_required_campaign_and_flow_not_both_evidenced' WHEN r.metric_ids!=@metric_ids OR r.currencies!=[@currency] OR r.timezones!=[@timezone] OR r.attribution_settings!=[@attribution_settings] THEN 'refresh_required_settings_mismatch' WHEN r.row_count!=r.identity_count OR r.row_count!=s.row_count OR r.min_retrieved_at!=s.retrieved_at OR r.max_retrieved_at!=s.retrieved_at THEN 'refresh_required_run_correlation_mismatch' ELSE 'eligible_for_coverage_repair' END disposition
FROM windows w LEFT JOIN successful_runs s ON s.month=w.month AND s.latest JOIN reports r ON r.month=w.month JOIN coverage c ON c.month=w.month ORDER BY w.month`;}

export function repairPromotionQuery(project){safe(project);return `BEGIN TRANSACTION;
CREATE TEMP TABLE candidates AS ${repairAuditQuery(project)};
ASSERT (SELECT COUNT(*)=2 FROM candidates) AS 'KLAVIYO_REPAIR_WINDOW_COUNT_MISMATCH';
ASSERT (SELECT COUNTIF(disposition NOT IN ('eligible_for_coverage_repair','already_collected'))=0 FROM candidates) AS 'KLAVIYO_REPAIR_REQUIRES_BOUNDED_REFRESH';
MERGE \`${project}.klaviyo.window_coverage\` T USING (SELECT report_start,report_end,@timezone reporting_timezone,'collected' status,run_row_count row_count,run_retrieved_at retrieved_at,run_id,CAST(NULL AS STRING) failure_class FROM candidates WHERE disposition='eligible_for_coverage_repair') S ON T.report_start=S.report_start AND T.report_end=S.report_end AND T.reporting_timezone=S.reporting_timezone
WHEN MATCHED THEN UPDATE SET status=S.status,row_count=S.row_count,retrieved_at=S.retrieved_at,run_id=S.run_id,failure_class=NULL
WHEN NOT MATCHED THEN INSERT ROW;
COMMIT TRANSACTION;`;}

export function historyCoverageQuery(project){safe(project);return `SELECT FORMAT_DATE('%Y-%m',DATE(report_start,reporting_timezone)) month,status,row_count,retrieved_at,run_id,DATE_DIFF(CURRENT_DATE(reporting_timezone),DATE_SUB(DATE(report_end,reporting_timezone),INTERVAL 1 DAY),DAY)<5 attribution_provisional FROM \`${project}.klaviyo.window_coverage\` WHERE FORMAT_DATE('%Y-%m',DATE(report_start,reporting_timezone)) IN UNNEST(@history_months) AND reporting_timezone=@timezone QUALIFY ROW_NUMBER() OVER(PARTITION BY report_start,report_end,reporting_timezone ORDER BY retrieved_at DESC)=1 ORDER BY month`;}

function parameters(config){const windows=repairWindows(config.timezone);return {params:{months:windows.map(x=>x.month),report_starts:windows.map(x=>BigQuery.timestamp(x.report_start)),report_ends:windows.map(x=>BigQuery.timestamp(x.report_end)),timezone:config.timezone,currency:config.currency,metric_ids:[...config.approved_metric_ids].sort(),attribution_settings:serializeAttributionSettings(config.attribution_settings)},types:{months:['STRING'],report_starts:['TIMESTAMP'],report_ends:['TIMESTAMP'],timezone:'STRING',currency:'STRING',metric_ids:['STRING'],attribution_settings:'STRING'}};}

const bounded=(value,max=240)=>String(value??'').replace(/\s+/g,' ').slice(0,max);
export class CoverageRepairStageError extends Error{
  constructor(stage,error){super(`Klaviyo coverage repair ${stage} failed`);this.name='CoverageRepairStageError';this.code='KLAVIYO_COVERAGE_REPAIR_FAILED';this.stage=stage;this.reason=bounded(error?.errors?.[0]?.reason||error?.reason||error?.code||error?.name||'unknown');}
}
async function atStage(stage,operation){try{return await operation();}catch(error){throw new CoverageRepairStageError(stage,error);}}

export async function repairCoverage({bigquery,project,config,apply=false}){
  const location=await atStage('dataset_location',()=>datasetLocation(bigquery,project,'klaviyo'));
  const bound=parameters(config),options={...bound,location,useLegacySql:false,maximumBytesBilled:10_000_000_000,labels:{component:'klaviyo_coverage_repair'}};
  const audit=repairAuditQuery(project),promotion=repairPromotionQuery(project);
  await atStage('dry_run:before_audit',()=>bigquery.createQueryJob({...options,query:audit,dryRun:true}));
  const [before]=await atStage('query:before_audit',()=>bigquery.query({...options,query:audit}));
  await atStage('dry_run:repair_transaction',()=>bigquery.createQueryJob({...options,query:promotion,dryRun:true}));
  if(apply)await atStage('query:repair_transaction',()=>bigquery.query({...options,query:promotion}));
  let after=before;
  if(apply){await atStage('dry_run:after_audit',()=>bigquery.createQueryJob({...options,query:audit,dryRun:true}));[after]=await atStage('query:after_audit',()=>bigquery.query({...options,query:audit}));}
  const historyOptions={query:historyCoverageQuery(project),params:{history_months:HISTORY_MONTHS,timezone:config.timezone},types:{history_months:['STRING'],timezone:'STRING'},location,useLegacySql:false,maximumBytesBilled:1_000_000_000,labels:{component:'klaviyo_coverage_repair'}};
  await atStage('dry_run:history_audit',()=>bigquery.createQueryJob({...historyOptions,dryRun:true}));
  const [history]=await atStage('query:history_audit',()=>bigquery.query(historyOptions));
  const collected=new Set(history.filter(x=>x.status==='collected').map(x=>String(x.month)));
  return {mode:apply?'repair_applied':'read_only_audit',bounded_months:REPAIR_MONTHS,before,after,history:{expected_months:HISTORY_MONTHS,collected_months:[...collected].sort(),missing_months:HISTORY_MONTHS.filter(x=>!collected.has(x)),complete:HISTORY_MONTHS.every(x=>collected.has(x)),september_attribution_provisional:history.find(x=>String(x.month)==='2026-09')?.attribution_provisional??null,windows:history},refresh_commands:after.filter(x=>String(x.disposition).startsWith('refresh_required')).map(x=>`npm run refresh:klaviyo -- --start=${x.month}-01 --end=${x.month==='2026-08'?'2026-08-31':'2026-09-30'}`),retrieval_settings_caveat:'Stored current attribution settings establish retrieval settings only; they do not prove those settings applied historically.'};
}

export async function main({env=process.env,args=process.argv.slice(2)}={}){const config=JSON.parse(await readFile(env.KLAVIYO_ACCOUNT_CONFIG||CONFIG_URL,'utf8')),{bigquery,project}=createBigQueryClient(env),result=await repairCoverage({bigquery,project,config,apply:args.includes('--apply')});console.log(JSON.stringify(result,null,2));if(result.refresh_commands.length||result.history.missing_months.length)process.exitCode=2;}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',stage:error.stage||'startup',code:bounded(error.code||error.name,80),reason:bounded(error.reason||'unknown',80),message:bounded(error.message)}));process.exitCode=1;});
