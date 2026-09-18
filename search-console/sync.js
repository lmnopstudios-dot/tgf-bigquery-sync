#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BigQuery } from '@google-cloud/bigquery';
import { createSearchConsoleClient, redactSecrets } from '../diagnostics/search-console-access.js';
import { DOMAIN_PROPERTY, WWW_PROPERTY, PROPERTIES, HISTORY_START, assertDate, datesBetween, propertyMetadata, normalizePage, metricRow, canonicalDaily, validateRows } from './semantic.js';
export const TABLES=['daily','queries','pages','device_country'];
export const KEYS={daily:['source_property','date'],queries:['source_property','date','query'],pages:['source_property','date','page'],device_country:['source_property','date','device','country']};
export const SCHEMAS={daily:'source_property STRING, property_scope STRING, property_hostname STRING, date DATE, clicks INT64, impressions INT64, ctr FLOAT64, position FLOAT64, coverage_status STRING, synced_at TIMESTAMP',queries:'source_property STRING, property_scope STRING, property_hostname STRING, date DATE, query STRING, clicks INT64, impressions INT64, ctr FLOAT64, position FLOAT64, coverage_status STRING, synced_at TIMESTAMP',pages:'source_property STRING, property_scope STRING, property_hostname STRING, date DATE, page STRING, normalized_hostname STRING, normalized_path STRING, clicks INT64, impressions INT64, ctr FLOAT64, position FLOAT64, coverage_status STRING, synced_at TIMESTAMP',device_country:'source_property STRING, property_scope STRING, property_hostname STRING, date DATE, device STRING, country STRING, clicks INT64, impressions INT64, ctr FLOAT64, position FLOAT64, coverage_status STRING, synced_at TIMESTAMP',canonical_daily:'date DATE, clicks INT64, impressions INT64, ctr FLOAT64, position FLOAT64, selected_source_property STRING, selected_property_scope STRING, selection_reason STRING, coverage_status STRING, synced_at TIMESTAMP'};
const safe=v=>{if(!/^[A-Za-z0-9_-]+$/.test(v))throw new Error('Invalid BigQuery identifier');return v};
export function dateParameters(startDate,endDate){return {startDate:BigQuery.date(startDate),endDate:BigQuery.date(endDate)}}
export function parseArgs(argv,now=new Date()){const final=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()-3)).toISOString().slice(0,10),start=new Date(`${final}T00:00:00Z`);start.setUTCDate(start.getUTCDate()-6);const o={startDate:start.toISOString().slice(0,10),endDate:final,finalDataCutoff:final,dataset:'search_console',maxDays:31,maxRows:500000};for(let i=0;i<argv.length;i++){const a=argv[i],v=argv[++i];if(a==='--start')o.startDate=v;else if(a==='--end')o.endDate=v;else if(a==='--dataset')o.dataset=v;else if(a==='--max-days')o.maxDays=Number(v);else if(a==='--max-rows')o.maxRows=Number(v);else throw new Error(`Unknown argument: ${a}`)}safe(o.dataset);assertDate(o.startDate);assertDate(o.endDate);const days=datesBetween(o.startDate,o.endDate).length;if(o.startDate<HISTORY_START)throw new Error(`start precedes governed history (${HISTORY_START})`);if(o.endDate>final)throw new Error(`end exceeds latest final-data candidate (${final})`);if(days>o.maxDays)throw new Error(`date range exceeds bounded maximum of ${o.maxDays} days`);if(!Number.isInteger(o.maxRows)||o.maxRows<1||o.maxRows>1000000)throw new Error('invalid maxRows');return o}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function retry(fn,attempts=5){for(let n=0;;n++)try{return await fn()}catch(e){const code=Number(e?.code??e?.response?.status);if(n===attempts-1||![429,500,502,503,504].includes(code))throw new Error(redactSecrets(e?.message||e));await sleep(250*2**n)}}
export async function fetchRows(client,siteUrl,startDate,endDate,dimensions,{maxRows=500000,pageSize=25000}={}){const out=[];for(let offset=0;offset<maxRows;offset+=pageSize){const response=await retry(()=>client.searchanalytics.query({siteUrl,requestBody:{startDate,endDate,dimensions,dataState:'final',aggregationType:'auto',rowLimit:Math.min(pageSize,maxRows-offset),startRow:offset}}));const batch=response?.data?.rows??response?.rows??[];out.push(...batch);if(batch.length<Math.min(pageSize,maxRows-offset))return out}throw new Error(`Search Console response exceeded bounded maxRows=${maxRows}`)}
export async function validateAccess(client){const listed=(await retry(()=>client.sites.list())).data?.siteEntry??[];for(const p of PROPERTIES){const found=listed.find(x=>x.siteUrl===p.source_property);if(!found||!['siteFullUser','siteOwner'].includes(found.permissionLevel))throw new Error(`Required Search Console property is not available with full access: ${p.source_property}`)}return true}
function convert(raw,dimensions,meta,syncedAt){return raw.map(r=>{const values=Object.fromEntries(dimensions.map((d,i)=>[d,r.keys?.[i]??''])),base={...meta,date:values.date,...metricRow(r),coverage_status:'available',synced_at:syncedAt};if(values.query!==undefined)base.query=values.query;if(values.page!==undefined)Object.assign(base,{page:values.page,...normalizePage(values.page)});if(values.device!==undefined)base.device=values.device;if(values.country!==undefined)base.country=values.country;return base})}
export async function collect({client,startDate,endDate,maxRows=500000,syncedAt=new Date().toISOString()}){const data=Object.fromEntries(TABLES.map(t=>[t,[]]));for(const meta of PROPERTIES){const specs={daily:['date'],queries:['date','query'],pages:['date','page'],device_country:['date','device','country']};for(const [name,dims] of Object.entries(specs)){const raw=await fetchRows(client,meta.source_property,startDate,endDate,dims,{maxRows});data[name].push(...convert(raw,dims,meta,syncedAt))}}for(const name of TABLES)validateRows(name,data[name]);data.canonical_daily=canonicalDaily(data.daily,startDate,endDate,syncedAt);return data}
export async function ensureSchema({bigquery,project,dataset='search_console',location='EU'}){safe(project);safe(dataset);await bigquery.query({query:`CREATE SCHEMA IF NOT EXISTS \`${project}.${dataset}\` OPTIONS(location="${location}")`});for(const [name,schema] of Object.entries(SCHEMAS))await bigquery.query({query:`CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.${name}\` (${schema}) PARTITION BY date`});await bigquery.query({query:`ASSERT (SELECT COUNT(*)=${Object.keys(SCHEMAS).length} AND COUNTIF(data_type!='DATE')=0 FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN (${Object.keys(SCHEMAS).map(x=>`'${x}'`).join(',')}) AND column_name='date') AS 'Search Console tables require DATE date columns'`});for(const [view,table] of [['canonical_queries','queries'],['canonical_pages','pages'],['canonical_device_country','device_country']])await bigquery.query({query:`CREATE OR REPLACE VIEW \`${project}.${dataset}.${view}\` AS SELECT d.* FROM \`${project}.${dataset}.${table}\` d JOIN \`${project}.${dataset}.canonical_daily\` c ON d.date=c.date AND d.source_property=c.selected_source_property WHERE c.coverage_status='available'`})}
export function promotionSql(project,dataset,table,stage){safe(project);safe(dataset);safe(table);safe(stage);const keys=KEYS[table].join(',');return `BEGIN TRANSACTION;\nDELETE FROM \`${project}.${dataset}.${table}\` WHERE source_property=@sourceProperty AND date BETWEEN @startDate AND @endDate;\nINSERT INTO \`${project}.${dataset}.${table}\` SELECT * FROM \`${project}.${dataset}.${stage}\`;\nASSERT (SELECT COUNT(*)=COUNT(DISTINCT TO_JSON_STRING(STRUCT(${keys}))) FROM \`${project}.${dataset}.${table}\` WHERE source_property=@sourceProperty AND date BETWEEN @startDate AND @endDate) AS 'duplicate semantic keys';\nCOMMIT TRANSACTION;`}
export async function promote({bigquery,project,dataset,data,startDate,endDate,invocationId=randomUUID().replaceAll('-','_')}){
  const stages=[];
  try {
    const sourceStages=[];
    for(const property of PROPERTIES) for(const table of TABLES){
      const stage=`_stage_${table}_${invocationId}_${property.property_scope}`; stages.push(stage);
      const rows=data[table].filter(r=>r.source_property===property.source_property);
      await bigquery.dataset(dataset).createTable(stage,{schema:SCHEMAS[table],expirationTime:Date.now()+86400000});
      if(rows.length) await bigquery.dataset(dataset).table(stage).insert(rows);
      sourceStages.push({property,table,stage});
    }
    const canonicalStage=`_stage_canonical_daily_${invocationId}`; stages.push(canonicalStage);
    await bigquery.dataset(dataset).createTable(canonicalStage,{schema:SCHEMAS.canonical_daily,expirationTime:Date.now()+86400000});
    await bigquery.dataset(dataset).table(canonicalStage).insert(data.canonical_daily);
    const statements=['BEGIN TRANSACTION;'];
    const params={...dateParameters(startDate,endDate)},types={startDate:'DATE',endDate:'DATE'};
    for(const [i,{property,table,stage}] of sourceStages.entries()){
      const param=`sourceProperty${i}`; params[param]=property.source_property; types[param]='STRING';
      statements.push(`DELETE FROM \`${project}.${dataset}.${table}\` WHERE source_property=@${param} AND date BETWEEN @startDate AND @endDate;`);
      statements.push(`INSERT INTO \`${project}.${dataset}.${table}\` SELECT * FROM \`${project}.${dataset}.${stage}\`;`);
      statements.push(`ASSERT (SELECT COUNT(*)=COUNT(DISTINCT TO_JSON_STRING(STRUCT(${KEYS[table].join(',')}))) FROM \`${project}.${dataset}.${table}\` WHERE source_property=@${param} AND date BETWEEN @startDate AND @endDate) AS '${table} duplicate semantic keys';`);
    }
    statements.push(`DELETE FROM \`${project}.${dataset}.canonical_daily\` WHERE date BETWEEN @startDate AND @endDate;`);
    statements.push(`INSERT INTO \`${project}.${dataset}.canonical_daily\` SELECT * FROM \`${project}.${dataset}.${canonicalStage}\`;`);
    statements.push(`ASSERT (SELECT COUNT(*)=DATE_DIFF(@endDate,@startDate,DAY)+1 AND COUNT(*)=COUNT(DISTINCT date) FROM \`${project}.${dataset}.canonical_daily\` WHERE date BETWEEN @startDate AND @endDate) AS 'canonical coverage';`);
    statements.push('COMMIT TRANSACTION;');
    await bigquery.query({query:statements.join('\n'),params,types});
  } finally { for(const stage of stages) await bigquery.dataset(dataset).table(stage).delete({ignoreNotFound:true}); }
}
export function syncSummary(args,data){return {status:'success',dataset:args.dataset||'search_console',requested_range:{start_date:args.startDate,end_date:args.endDate},final_data_cutoff:args.finalDataCutoff||args.endDate,governed_properties_processed:PROPERTIES.length,property_rows:PROPERTIES.map(property=>({source_property:property.source_property,tables:Object.fromEntries(TABLES.map(table=>{const count=data[table].filter(row=>row.source_property===property.source_property).length;return [table,{staged:count,inserted:count}]}))})),canonical_daily:{row_count:data.canonical_daily.length},canonical_selection_counts:{preferred_domain:data.canonical_daily.filter(row=>row.selection_reason==='preferred_domain_property').length,fallback_www:data.canonical_daily.filter(row=>row.selection_reason==='fallback_www_property').length,unavailable:data.canonical_daily.filter(row=>row.coverage_status==='unavailable').length}}}
export async function syncSearchConsole(args){await validateAccess(args.client);await ensureSchema(args);const data=await collect(args);await promote({...args,data});return syncSummary(args,data)}
export async function emitSyncSuccess(run,log=console.log){const result=await run();log(JSON.stringify(result,null,2));return result}
export function isDirectExecution(metaUrl=import.meta.url,argv1=process.argv[1]){
  if(!argv1)return false;
  try{return realpathSync(fileURLToPath(metaUrl))===realpathSync(resolve(argv1))}catch{return false}
}
export async function main({argv=process.argv.slice(2),env=process.env,write=line=>process.stdout.write(`${line}\n`),sync=syncSearchConsole,importGoogle=()=>import('googleapis'),BigQueryClass=BigQuery,createClient=createSearchConsoleClient}={}){
  const options=parseArgs(argv),credentials=JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON),project=env.GOOGLE_PROJECT_ID||credentials.project_id,{google}=await importGoogle();
  return emitSyncSuccess(()=>sync({...options,project,credentials,client:createClient(google,credentials),bigquery:new BigQueryClass({projectId:project,credentials})}),write);
}
export async function runCli(run=()=>main(),writeError=line=>process.stderr.write(`${line}\n`)){
  try{return await run()}catch(error){writeError(redactSecrets(error?.message||error));process.exitCode=1;return undefined}
}
if(isDirectExecution())await runCli();
