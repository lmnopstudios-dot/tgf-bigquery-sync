#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { loadConfig } from './ga4-access.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { dateParameters } from '../ga4/sync.js';
import { assertDate, datesBetween } from '../ga4/semantic.js';
import { GA4_COVERAGE_STATUSES, GA4_COVERAGE_TABLE, GA4_DATE_FIELD, GA4_DEVICE_TABLE, ga4Dataset } from '../ga4/storage-contract.js';

export const DIAGNOSTIC_START = '2022-08-18';
export const DIAGNOSTIC_END = '2022-11-18';

const safe = value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid BigQuery identifier'); return value; };

export function diagnosticQuery(project, dataset = ga4Dataset()) {
  safe(project); safe(dataset);
  return `WITH coverage AS (
  SELECT date,status,reason FROM \`${project}.${dataset}.${GA4_COVERAGE_TABLE}\`
  WHERE date BETWEEN @startDate AND @endDate AND grain='device'
), devices AS (SELECT device FROM UNNEST(['desktop','mobile']) device),
status_values AS (SELECT status FROM UNNEST(['reportable','limited','unavailable']) status),
persisted AS (
  SELECT date,device_category device,COUNT(*) AS persisted_rows,SUM(sessions) sessions,SUM(ecommerce_purchases) ecommerce_purchases
  FROM \`${project}.${dataset}.${GA4_DEVICE_TABLE}\`
  WHERE date BETWEEN @startDate AND @endDate AND device_category IN ('desktop','mobile') GROUP BY 1,2
), reason_counts AS (
  SELECT status,reason,COUNT(*) days FROM coverage GROUP BY 1,2 ORDER BY days DESC,reason LIMIT 100
)
SELECT d.device,s.status,DATE_DIFF(@endDate,@startDate,DAY)+1 expected_days,
 COUNT(DISTINCT IF(COALESCE(c.status,'missing')=s.status,c.date,NULL)) coverage_record_days,
 COUNT(DISTINCT IF(c.status='reportable',c.date,NULL)) reportable_days,
 COUNT(DISTINCT IF(c.status='limited',c.date,NULL)) limited_days,
 COUNT(DISTINCT IF(c.status='unavailable',c.date,NULL)) unavailable_days,
 COUNT(DISTINCT IF(COALESCE(c.status,'missing')=s.status,p.date,NULL)) persisted_conversion_device_days,
 COALESCE(SUM(IF(COALESCE(c.status,'missing')=s.status,p.persisted_rows,0)),0) persisted_conversion_device_rows,
 COALESCE(SUM(IF(COALESCE(c.status,'missing')=s.status,p.sessions,0)),0) sessions,
 COALESCE(SUM(IF(COALESCE(c.status,'missing')=s.status,p.ecommerce_purchases,0)),0) ecommerce_purchases,
 ARRAY(SELECT AS STRUCT reason,days FROM reason_counts r WHERE r.status=s.status ORDER BY days DESC,reason LIMIT 25) bounded_coverage_reasons
FROM devices d CROSS JOIN status_values s LEFT JOIN coverage c ON TRUE LEFT JOIN persisted p ON p.date=c.date AND p.device=d.device
GROUP BY d.device,s.status ORDER BY d.device,s.status`;
}

export async function diagnose({ bigquery, project, dataset = ga4Dataset(), startDate = DIAGNOSTIC_START, endDate = DIAGNOSTIC_END }) {
  assertDate(startDate); assertDate(endDate);
  if (datesBetween(startDate,endDate).length > 93) throw new Error('Diagnostic is bounded to at most 93 days');
  const location = await datasetLocation(bigquery, project, dataset, { fallback: 'EU' });
  const [rows] = await bigquery.query({ query: diagnosticQuery(project,dataset), location, params: dateParameters(startDate,endDate), types:{startDate:'DATE',endDate:'DATE'}, maximumBytesBilled:1_000_000_000, labels:{component:'ga4_backfill_read_path'} });
  return { read_only:true, range:{start_date:startDate,end_date:endDate,expected_days:datesBetween(startDate,endDate).length}, contract:{writer:{project,dataset,location,coverage_table:GA4_COVERAGE_TABLE,device_table:GA4_DEVICE_TABLE,date_field:GA4_DATE_FIELD,status_values:GA4_COVERAGE_STATUSES},oracle:{project,dataset,location,coverage_table:GA4_COVERAGE_TABLE,device_table:GA4_DEVICE_TABLE,date_field:GA4_DATE_FIELD,status_values:GA4_COVERAGE_STATUSES},same_read_write_contract:true}, rows };
}

async function main(){const {credentials}=loadConfig();const project=process.env.GOOGLE_PROJECT_ID||credentials.project_id;const result=await diagnose({bigquery:new BigQuery({projectId:project,credentials}),project});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
