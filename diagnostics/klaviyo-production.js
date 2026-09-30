#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {createKlaviyoEmailService,klaviyoAggregateQuery} from '../oracle/klaviyo-email.js';
import {requireGate,collectPilot} from '../klaviyo/sync.js';
import {createKlaviyoClient,redactKlaviyo} from '../klaviyo/client.js';
import {parseMetricIds,resolveReportWindow} from '../klaviyo/discovery.js';
import {datasetLocation} from '../bigquery/dataset-location.js';

const MAX_BYTES=1_000_000_000;
const stats=['recipients','delivered','opens_unique','clicks_unique','conversions','conversion_value','bounced','unsubscribes','spam_complaints'];
const identity=row=>[row.report_kind,row.entity_id,row.message_id,row.report_start?.value??row.report_start,row.report_end?.value??row.report_end,row.conversion_metric_id].join('\u0000');
const number=value=>Number(value?.value??value??0);
const instant=value=>new Date(value?.value??value).toISOString();

export function inventoryQuery(project){return `SELECT report_kind, conversion_metric_id, report_start, report_end, reporting_timezone, COUNT(*) row_count
FROM \`${project}.klaviyo.message_performance\`
WHERE report_start >= TIMESTAMP('2026-07-31') AND report_start < TIMESTAMP('2026-09-02')
GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5 LIMIT 100`;}

export function physicalRowsQuery(project){return `SELECT report_kind, entity_id, message_id, report_start, report_end, conversion_metric_id, reporting_timezone, recipients, delivered, opens_unique, clicks_unique, conversions, conversion_value, bounced, unsubscribes, spam_complaints
FROM \`${project}.klaviyo.message_performance\`
WHERE report_start=@report_start AND report_end=@report_end AND reporting_timezone=@reporting_timezone AND conversion_metric_id IN UNNEST(@metric_ids)
ORDER BY report_kind, entity_id, message_id, conversion_metric_id LIMIT 500`;}

function compareRows(apiRows,storedRows){
  const api=new Map(apiRows.map(row=>[identity(row),row])),stored=new Map(storedRows.map(row=>[identity({...row,report_start:instant(row.report_start),report_end:instant(row.report_end)}),row]));
  const missing=[...api.keys()].filter(key=>!stored.has(key)),unexpected=[...stored.keys()].filter(key=>!api.has(key)),statistic_mismatches=[];
  for(const [key,left] of api)if(stored.has(key))for(const field of stats)if(number(left[field])!==number(stored.get(key)[field]))statistic_mismatches.push({identity:key,field,api:number(left[field]),stored:number(stored.get(key)[field])});
  return {consistent:missing.length===0&&unexpected.length===0&&statistic_mismatches.length===0,api_identity_count:api.size,stored_identity_count:stored.size,missing_identities:missing.slice(0,20),unexpected_identities:unexpected.slice(0,20),statistic_mismatches:statistic_mismatches.slice(0,20)};
}

function compareOracleStatistics(storedRows,oracleRows){
  const mappings={recipients:'recipients',delivered:'delivered',opens_unique:'unique_opens',clicks_unique:'unique_clicks',conversions:'attributed_conversions',conversion_value:'attributed_conversion_value',bounced:'bounces',unsubscribes:'unsubscribes',spam_complaints:'spam_complaints'};
  const differences=[];
  for(const [storedField,oracleField] of Object.entries(mappings)){
    const stored=storedRows.reduce((sum,row)=>sum+number(row[storedField]),0),oracle=oracleRows.reduce((sum,row)=>sum+number(row[oracleField]),0);
    if(stored!==oracle)differences.push({statistic:storedField,stored,oracle});
  }
  return {consistent:differences.length===0,differences};
}

export async function diagnose({bigquery,project,apiRows,timezone,metricIds}){
  const window=resolveReportWindow({timezone}),location=await datasetLocation(bigquery,project,'klaviyo',{fallback:'US'}),base={useLegacySql:false,maximumBytesBilled:MAX_BYTES,location,labels:{component:'klaviyo_pilot_diagnostic'}};
  const [inventory]=await bigquery.query({...base,query:inventoryQuery(project)});
  const bindings={report_start:window.startInstant,report_end:window.endInstant,reporting_timezone:timezone,metric_ids:metricIds};
  const [storedRows]=await bigquery.query({...base,query:physicalRowsQuery(project),params:bindings,types:{report_start:'TIMESTAMP',report_end:'TIMESTAMP',reporting_timezone:'STRING',metric_ids:['STRING']}});
  const oracleArgs={start_date:'2026-08-01',end_date:'2026-08-31'},oracle=await createKlaviyoEmailService({bigquery,project})('get_klaviyo_email_performance',oracleArgs),comparison=compareRows(apiRows,storedRows);
  const oracleEvidenceRows=oracle.rows.reduce((sum,row)=>sum+number(row.evidence_rows),0),oracleStatistics=compareOracleStatistics(storedRows,oracle.rows);
  const consistent=comparison.consistent&&oracleStatistics.consistent&&apiRows.length===storedRows.length&&storedRows.length===oracleEvidenceRows;
  return {status:consistent?'read_only_diagnostic_passed':'read_only_diagnostic_failed',read_only:true,project,dataset:'klaviyo',table:'message_performance',location,physical_inventory:inventory,selected_window:window,selected_metric_ids:metricIds,physical_bindings:bindings,oracle_query:klaviyoAggregateQuery(project),oracle_bindings:oracleArgs,api_rows:apiRows.length,stored_rows:storedRows.length,persisted_evidence_rows:oracleEvidenceRows,oracle_result_groups:oracle.rows.length,comparison:{...comparison,oracle_statistics:oracleStatistics,consistent},note:'No data was written.'};
}

export async function main(env=process.env){
  const manifest=JSON.parse(await readFile(env.KLAVIYO_DISCOVERY_MANIFEST,'utf8')),metricIds=parseMetricIds(env.KLAVIYO_CONVERSION_METRIC_IDS),timezone=env.KLAVIYO_ACCOUNT_TIMEZONE;
  requireGate(manifest,{timezone,currency:env.KLAVIYO_ACCOUNT_CURRENCY,metricIds});
  const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:12,timeoutMs:15000});
  const apiRows=await collectPilot({client,manifest,revision:env.KLAVIYO_API_REVISION,timezone,currency:env.KLAVIYO_ACCOUNT_CURRENCY,metricIds}),{bigquery,project}=createBigQueryClient(env),result=await diagnose({bigquery,project,apiRows,timezone,metricIds});
  console.log(JSON.stringify(result,null,2));if(result.status!=='read_only_diagnostic_passed')process.exitCode=1;
}

if(import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({status:'read_only_diagnostic_failed',message:redactKlaviyo(error.message)}));process.exitCode=1;});
