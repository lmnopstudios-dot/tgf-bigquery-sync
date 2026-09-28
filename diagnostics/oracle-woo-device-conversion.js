#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { ga4Dataset } from '../ga4/storage-contract.js';
import { assertDate, datesBetween } from '../ga4/semantic.js';
import { conversionQueries, createDeviceSourceConversionService } from '../oracle/device-source-conversion.js';
import { validateWooDeviceConversionResult } from '../oracle/woo-device-conversion-request.js';

export const DEFAULT_START = '2024-11-20';
export const DEFAULT_END = '2025-11-19';

export function comparisonQuery(project, dataset) {
  if (![project,dataset].every(value => /^[A-Za-z0-9_-]+$/.test(value))) throw new Error('Invalid BigQuery identifier');
  return `WITH coverage AS (
  SELECT date,status FROM \`${project}.${dataset}.conversion_coverage\`
  WHERE date BETWEEN @start AND @end AND grain='device'
), persisted AS (
  SELECT date,LOWER(TRIM(device_category)) device_type,SUM(sessions) sessions,SUM(ecommerce_purchases) ecommerce_purchases
  FROM \`${project}.${dataset}.conversion_device\`
  WHERE date BETWEEN @start AND @end AND LOWER(TRIM(device_category)) IN ('desktop','mobile') GROUP BY 1,2
)
SELECT device_type,status,COUNT(DISTINCT coverage.date) coverage_days,
  COUNT(DISTINCT persisted.date) persisted_days,COALESCE(SUM(sessions),0) sessions,
  COALESCE(SUM(ecommerce_purchases),0) ecommerce_purchases
FROM (SELECT device_type FROM UNNEST(['desktop','mobile']) device_type)
CROSS JOIN (SELECT status FROM UNNEST(['reportable','limited','unavailable']) status)
LEFT JOIN coverage ON coverage.status=status
LEFT JOIN persisted ON persisted.date=coverage.date AND persisted.device_type=device_type
GROUP BY 1,2 ORDER BY 1,2`;
}

export async function diagnose({ bigquery, project, dataset = ga4Dataset(), start = DEFAULT_START, end = DEFAULT_END }) {
  assertDate(start); assertDate(end);
  const expected = datesBetween(start,end).length;
  if (expected > 366) throw new Error('Diagnostic is bounded to at most 366 days');
  const location = await datasetLocation(bigquery,project,dataset,{fallback:'EU'});
  const options={location,params:{start,end},types:{start:'DATE',end:'DATE'},useLegacySql:false,maximumBytesBilled:1_000_000_000,labels:{component:'oracle_woo_device_diagnostic'}};
  const query=comparisonQuery(project,dataset);
  await bigquery.createQueryJob({...options,query,dryRun:true});
  const [persisted]=await bigquery.query({...options,query});
  const aggregate=await createDeviceSourceConversionService({bigquery,project,dataset})('get_woocommerce_device_conversion',{start_date:start,end_date:end});
  const validation=validateWooDeviceConversionResult(aggregate,{start_date:start,end_date:end});
  return {diagnostic:'oracle_woo_device_conversion',read_only:true,range:{start_date:start,end_date:end,expected_days:expected},storage:{project,dataset,location},tool:{name:'get_woocommerce_device_conversion',arguments:{start_date:start,end_date:end},sql:conversionQueries(project,{dataset}),status_filter:"grain='device' AND status='reportable'"},persisted_by_device_and_coverage_state:persisted,aggregate:{woo_coverage:aggregate.woo_coverage,rows:aggregate.rows},validation:{valid:true,expected_days:validation.expected_days,reportable_days:validation.covered_days,limited_or_unavailable_days:validation.limited_days}};
}

function parse(argv){const values={};for(const arg of argv){const match=arg.match(/^--(start|end)=(\d{4}-\d{2}-\d{2})$/);if(match)values[match[1]]=match[2];else throw new Error(`Unknown argument: ${arg}`);}return values;}
async function main(){const {bigquery,project}=createBigQueryClient();const args=parse(process.argv.slice(2));process.stdout.write(`${JSON.stringify(await diagnose({bigquery,project,...args}),null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(JSON.stringify({diagnostic:'oracle_woo_device_conversion',status:'failed',error_code:error.code||'CHECK_FAILED',message:error.message}));process.exitCode=1;});
