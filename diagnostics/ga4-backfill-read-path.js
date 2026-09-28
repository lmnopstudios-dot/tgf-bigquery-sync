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
  SELECT status,reason,COUNT(*) days FROM coverage GROUP BY 1,2
), bounded_reason_counts AS (
  SELECT * FROM reason_counts QUALIFY ROW_NUMBER() OVER (ORDER BY days DESC,reason,status)<=100
), coverage_reasons AS (
  SELECT status,ARRAY_AGG(STRUCT(reason,days) ORDER BY days DESC,reason LIMIT 25) bounded_coverage_reasons
  FROM bounded_reason_counts GROUP BY status
), coverage_totals AS (
  SELECT COUNT(DISTINCT IF(status='reportable',date,NULL)) reportable_days,
    COUNT(DISTINCT IF(status='limited',date,NULL)) limited_days,
    COUNT(DISTINCT IF(status='unavailable',date,NULL)) unavailable_days
  FROM coverage
), coverage_by_status AS (
  SELECT status,COUNT(DISTINCT date) coverage_record_days FROM coverage GROUP BY status
), persisted_by_device_status AS (
  SELECT p.device,c.status,COUNT(DISTINCT p.date) persisted_conversion_device_days,
    SUM(p.persisted_rows) persisted_conversion_device_rows,SUM(p.sessions) sessions,
    SUM(p.ecommerce_purchases) ecommerce_purchases
  FROM persisted p JOIN coverage c USING(date) GROUP BY 1,2
)
SELECT d.device,s.status,DATE_DIFF(@endDate,@startDate,DAY)+1 expected_days,
 COALESCE(c.coverage_record_days,0) coverage_record_days,
 t.reportable_days,t.limited_days,t.unavailable_days,
 COALESCE(p.persisted_conversion_device_days,0) persisted_conversion_device_days,
 COALESCE(p.persisted_conversion_device_rows,0) persisted_conversion_device_rows,
 COALESCE(p.sessions,0) sessions,
 COALESCE(p.ecommerce_purchases,0) ecommerce_purchases,
 COALESCE(r.bounded_coverage_reasons,[]) bounded_coverage_reasons
FROM devices d CROSS JOIN status_values s CROSS JOIN coverage_totals t
LEFT JOIN coverage_by_status c ON c.status=s.status
LEFT JOIN persisted_by_device_status p ON p.status=s.status AND p.device=d.device
LEFT JOIN coverage_reasons r ON r.status=s.status
ORDER BY d.device,s.status`;
}

const stageError = (stage,error) => { const failure=new Error(`GA4 backfill read-path ${stage} failed`); failure.stage=stage; failure.code=Number.isFinite(Number(error?.code))?Number(error.code):'BIGQUERY_CHECK_FAILED'; return failure; };

export async function diagnose({ bigquery, project, dataset = ga4Dataset(), startDate = DIAGNOSTIC_START, endDate = DIAGNOSTIC_END }) {
  assertDate(startDate); assertDate(endDate);
  if (datesBetween(startDate,endDate).length > 93) throw new Error('Diagnostic is bounded to at most 93 days');
  const location = await datasetLocation(bigquery, project, dataset, { fallback: 'EU' });
  const query=diagnosticQuery(project,dataset);
  const options={query,location,params:dateParameters(startDate,endDate),types:{startDate:'DATE',endDate:'DATE'},useLegacySql:false,maximumBytesBilled:1_000_000_000,labels:{component:'ga4_backfill_read_path'}};
  try { await bigquery.createQueryJob({...options,dryRun:true}); } catch(error) { throw stageError('dry_run',error); }
  let rows;
  try { [rows] = await bigquery.query(options); } catch(error) { throw stageError('query',error); }
  return { read_only:true, range:{start_date:startDate,end_date:endDate,expected_days:datesBetween(startDate,endDate).length}, contract:{writer:{project,dataset,location,coverage_table:GA4_COVERAGE_TABLE,device_table:GA4_DEVICE_TABLE,date_field:GA4_DATE_FIELD,status_values:GA4_COVERAGE_STATUSES},oracle:{project,dataset,location,coverage_table:GA4_COVERAGE_TABLE,device_table:GA4_DEVICE_TABLE,date_field:GA4_DATE_FIELD,status_values:GA4_COVERAGE_STATUSES},same_read_write_contract:true}, rows };
}

async function main(){const {credentials}=loadConfig();const project=process.env.GOOGLE_PROJECT_ID||credentials.project_id;const result=await diagnose({bigquery:new BigQuery({projectId:project,credentials}),project});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(JSON.stringify({diagnostic:'ga4_backfill_read_path',status:'failed',stage:error.stage||'setup',error_code:error.code||'CHECK_FAILED'}));process.exitCode=1;});
