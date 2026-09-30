#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { datasetLocation } from '../bigquery/dataset-location.js';

export const CONVERSION_TABLES = Object.freeze(['session_conversion_by_device', 'session_conversion_by_device_source']);
const safeId = value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid BigQuery identifier'); return value; };

export function retentionUpdateSql(project, dataset = 'shopify_data') {
  safeId(project); safeId(dataset);
  return CONVERSION_TABLES.map(table => `ALTER TABLE \`${project}.${dataset}.${table}\` SET OPTIONS (partition_expiration_days = NULL)`).join(';\n');
}

export function retentionVerificationSql(project, dataset = 'shopify_data') {
  safeId(project); safeId(dataset);
  return `WITH wanted AS (SELECT table_name FROM UNNEST(@tables) table_name), existing AS (
  SELECT table_name FROM \`${project}.${dataset}.INFORMATION_SCHEMA.TABLES\` WHERE table_name IN UNNEST(@tables)
), options AS (
  SELECT table_name,
    MAX(IF(option_name = 'partition_expiration_days', option_value, NULL)) AS partition_expiration_days,
    MAX(IF(option_name = 'expiration_timestamp', option_value, NULL)) AS table_expiration_timestamp
  FROM \`${project}.${dataset}.INFORMATION_SCHEMA.TABLE_OPTIONS\`
  WHERE table_name IN UNNEST(@tables) GROUP BY table_name
), partitions AS (
  SELECT table_name, MIN(PARSE_DATE('%Y%m%d', partition_id)) AS oldest_partition,
    MAX(PARSE_DATE('%Y%m%d', partition_id)) AS newest_partition, COUNT(*) AS partition_count
  FROM \`${project}.${dataset}.INFORMATION_SCHEMA.PARTITIONS\`
  WHERE table_name IN UNNEST(@tables) AND REGEXP_CONTAINS(partition_id, r'^[0-9]{8}$') GROUP BY table_name
)
SELECT wanted.table_name, existing.table_name IS NOT NULL AS table_exists,
  options.partition_expiration_days, options.table_expiration_timestamp,
  partitions.oldest_partition, partitions.newest_partition, COALESCE(partitions.partition_count, 0) AS partition_count,
  existing.table_name IS NOT NULL AND options.partition_expiration_days IS NULL AS historical_partitions_retained
FROM wanted LEFT JOIN existing USING(table_name) LEFT JOIN options USING(table_name) LEFT JOIN partitions USING(table_name) ORDER BY table_name`;
}

export async function inspectRetention({bigquery, project, dataset = 'shopify_data'}) {
  const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'});
  const [rows]=await bigquery.query({location,query:retentionVerificationSql(project,dataset),params:{tables:CONVERSION_TABLES},types:{tables:['STRING']},maximumBytesBilled:100*1024*1024,labels:{component:'shopify_conversion_retention_verification'}});
  return rows;
}

export async function assertBackfillRetention({bigquery, project, dataset = 'shopify_data', startDate, now = new Date()}) {
  const rows=await inspectRetention({bigquery,project,dataset});
  const byTable=new Map(rows.map(row=>[row.table_name,row]));
  const unsafe=[];
  for(const table of CONVERSION_TABLES){
    const value=byTable.get(table)?.partition_expiration_days;
    if(value===null||value===undefined)continue;
    const days=Number(String(value).replace(/^'|'$/g,''));
    const cutoff=new Date(now);cutoff.setUTCDate(cutoff.getUTCDate()-days);
    if(!Number.isFinite(days)||new Date(`${startDate}T00:00:00Z`)<cutoff)unsafe.push({table,partition_expiration_days:value});
  }
  if(unsafe.length)throw new Error(`Historical backfill would expire immediately; disable partition expiration first: ${unsafe.map(item=>item.table).join(', ')}`);
  return rows;
}

export async function updateRetention({bigquery,project,dataset='shopify_data'}){const location=await datasetLocation(bigquery,project,dataset,{fallback:'US'});await bigquery.query({location,query:retentionUpdateSql(project,dataset),labels:{component:'shopify_conversion_retention_update'}});return inspectRetention({bigquery,project,dataset});}

async function main(){const args=Object.fromEntries(process.argv.slice(2).map((v,i,a)=>v.startsWith('--')?[v.slice(2),a[i+1]]:null).filter(Boolean));const loaded=createBigQueryClient(process.env),project=args.project||loaded.project,dataset=args.dataset||'shopify_data',mode=args.mode||'verify';if(!['update','verify'].includes(mode))throw new Error('--mode must be update or verify');const rows=mode==='update'?await updateRetention({bigquery:loaded.bigquery,project,dataset}):await inspectRetention({bigquery:loaded.bigquery,project,dataset});console.log(JSON.stringify({diagnostic:'shopify_conversion_retention',mode,read_only:mode==='verify',tables:rows},null,2));}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
