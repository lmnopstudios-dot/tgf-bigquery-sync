#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { bigQueryDateParameters, describeDateParameter } from '../bigquery/date-parameters.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { ga4Dataset } from '../ga4/storage-contract.js';
import { assertDate, datesBetween } from '../ga4/semantic.js';
import { dateParameters as validatorDateParameters } from '../ga4/sync.js';
import { coverageQuery as validatorCoverageQuery, validationQuery } from './ga4-semantic-validation.js';
import { conversionQueries, createDeviceSourceConversionService } from '../oracle/device-source-conversion.js';
import { validateWooDeviceConversionResult } from '../oracle/woo-device-conversion-request.js';

export const DEFAULT_START = '2024-11-20';
export const DEFAULT_END = '2025-11-19';
const MAXIMUM_BYTES_BILLED = 1_000_000_000;

function safeIdentifiers(project,dataset){if(![project,dataset].every(value=>/^[A-Za-z0-9_-]+$/.test(value)))throw new Error('Invalid BigQuery identifier');}

export function comparisonQuery(project, dataset) {
  safeIdentifiers(project,dataset);
  return `WITH coverage AS (
  SELECT date,status FROM \`${project}.${dataset}.conversion_coverage\`
  WHERE date BETWEEN @start AND @end AND grain='device'
), persisted AS (
  SELECT date,LOWER(TRIM(device_category)) device_type,SUM(sessions) sessions,SUM(ecommerce_purchases) ecommerce_purchases
  FROM \`${project}.${dataset}.conversion_device\`
  WHERE date BETWEEN @start AND @end AND LOWER(TRIM(device_category)) IN ('desktop','mobile') GROUP BY 1,2
)
SELECT devices.device_type,states.status,COUNT(DISTINCT coverage.date) coverage_days,
  COUNT(DISTINCT persisted.date) persisted_days,COALESCE(SUM(persisted.sessions),0) sessions,
  COALESCE(SUM(persisted.ecommerce_purchases),0) ecommerce_purchases
FROM (SELECT device_type FROM UNNEST(['desktop','mobile']) device_type) devices
CROSS JOIN (SELECT status FROM UNNEST(['reportable','limited','unavailable']) status) states
LEFT JOIN coverage ON coverage.status=states.status
LEFT JOIN persisted ON persisted.date=coverage.date AND persisted.device_type=devices.device_type
GROUP BY 1,2 ORDER BY 1,2`;
}

/** A direct physical inventory, independent of both the validator and Oracle SQL. */
export function physicalInventoryQuery(project,dataset){
  safeIdentifiers(project,dataset);
  return `SELECT 'monthly' record_type,FORMAT_DATE('%Y-%m',date) calendar_month,grain,status,
  COUNT(*) row_count,COUNT(DISTINCT date) distinct_dates,MIN(date) min_date,MAX(date) max_date
FROM \`${project}.${dataset}.conversion_coverage\`
WHERE date BETWEEN @physical_start AND @physical_end
GROUP BY 1,2,3,4
UNION ALL
SELECT 'monthly',FORMAT_DATE('%Y-%m',date),'conversion_device','persisted',COUNT(*),COUNT(DISTINCT date),MIN(date),MAX(date)
FROM \`${project}.${dataset}.conversion_device\`
WHERE date BETWEEN @physical_start AND @physical_end GROUP BY 1,2,3,4
UNION ALL
SELECT 'table_extent',NULL,'conversion_coverage','all',COUNT(*),COUNT(DISTINCT date),MIN(date),MAX(date)
FROM \`${project}.${dataset}.conversion_coverage\`
UNION ALL
SELECT 'table_extent',NULL,'conversion_device','all',COUNT(*),COUNT(DISTINCT date),MIN(date),MAX(date)
FROM \`${project}.${dataset}.conversion_device\`
ORDER BY record_type,calendar_month,grain,status`;
}

const bindingEvidence=(params,types)=>Object.fromEntries(Object.keys(types).map(name=>[name,describeDateParameter(params[name],types[name])]));

export async function diagnose({ bigquery, project, dataset = ga4Dataset(), start = DEFAULT_START, end = DEFAULT_END }) {
  assertDate(start);assertDate(end);if(start>end)throw new Error('start must not exceed end');
  const expected=datesBetween(start,end).length;if(expected>366)throw new Error('Diagnostic is bounded to at most 366 days');
  const location=await datasetLocation(bigquery,project,dataset,{fallback:'EU'});
  const base={location,useLegacySql:false,maximumBytesBilled:MAXIMUM_BYTES_BILLED};
  const comparisonParams=bigQueryDateParameters({start,end}),comparisonTypes={start:'DATE',end:'DATE'};
  const comparison={...base,query:comparisonQuery(project,dataset),params:comparisonParams,types:comparisonTypes,labels:{component:'oracle_woo_device_diagnostic'}};
  const physicalParams=bigQueryDateParameters({physical_start:start,physical_end:end}),physicalTypes={physical_start:'DATE',physical_end:'DATE'};
  const physical={...base,query:physicalInventoryQuery(project,dataset),params:physicalParams,types:physicalTypes,labels:{component:'oracle_woo_device_physical_inventory'}};
  const periods={before_start:start,before_end:end,after_start:end,after_end:end};
  const oracleParams=bigQueryDateParameters(periods),oracleTypes=Object.fromEntries(Object.keys(periods).map(key=>[key,'DATE']));
  const oracleQueries=conversionQueries(project,{dataset});
  const shopifyLocation=await datasetLocation(bigquery,project,'shopify_data',{fallback:'US'});
  const oracleCommon={params:oracleParams,types:oracleTypes,useLegacySql:false,maximumBytesBilled:MAXIMUM_BYTES_BILLED,labels:{component:'oracle_device_conversion'}};
  const preflight=[['comparison',comparison],['physical_inventory',physical],['oracle_boundary',{...oracleCommon,query:oracleQueries.boundary,location:shopifyLocation}],['oracle_woo',{...oracleCommon,query:oracleQueries.woo,location}],['oracle_coverage',{...oracleCommon,query:oracleQueries.coverage,location}]];
  for(const [stage,job] of preflight){try{await bigquery.createQueryJob({...job,dryRun:true});}catch{throw Object.assign(new Error(`${stage} dry-run failed`),{stage:`dry_run:${stage}`});}}
  let persisted,physicalRows;
  try{[[persisted],[physicalRows]]=await Promise.all([bigquery.query(comparison),bigquery.query(physical)]);}catch{throw Object.assign(new Error('physical evidence query failed'),{stage:'query:physical_evidence'});}
  const aggregate=await createDeviceSourceConversionService({bigquery,project,dataset})('get_woocommerce_device_conversion',{start_date:start,end_date:end});
  const physicalReportableDays=physicalRows.filter(row=>row.record_type==='monthly'&&row.grain==='device'&&row.status==='reportable').reduce((sum,row)=>sum+Number(row.distinct_dates||0),0);
  const physicalDeviceDays=new Set(physicalRows.filter(row=>row.record_type==='monthly'&&row.grain==='conversion_device').map(row=>String(row.calendar_month))).size ? physicalRows.filter(row=>row.record_type==='monthly'&&row.grain==='conversion_device').reduce((sum,row)=>sum+Number(row.distinct_dates||0),0) : 0;
  if((physicalReportableDays===expected||physicalDeviceDays===expected)&&(Number(aggregate.woo_coverage?.covered_days||0)===0||!aggregate.rows?.length)){
    throw Object.assign(new Error('Physical rows cover the requested interval but the Oracle aggregate returned zero coverage or device rows'),{code:'GA4_VALIDATOR_ORACLE_CONTRADICTION',stage:'validate:physical_vs_oracle',physical_rows:physicalRows});
  }
  const validation=validateWooDeviceConversionResult(aggregate,{start_date:start,end_date:end});
  const validatorParams=validatorDateParameters(start,end),validatorTypes={startDate:'DATE',endDate:'DATE'};
  return {diagnostic:'oracle_woo_device_conversion',read_only:true,range:{start_date:start,end_date:end,expected_days:expected},storage:{project,dataset,location},physical_inventory:{sql:physical.query,rows:physicalRows},query_bindings:{comparison:{sql:comparison.query,parameters:bindingEvidence(comparisonParams,comparisonTypes)},oracle_boundary:{sql:oracleQueries.boundary,parameters:bindingEvidence(oracleParams,oracleTypes)},oracle_woo:{sql:oracleQueries.woo,parameters:bindingEvidence(oracleParams,oracleTypes)},oracle_coverage:{sql:oracleQueries.coverage,parameters:bindingEvidence(oracleParams,oracleTypes)},validator_structural:{sql:validationQuery(project,dataset),parameters:bindingEvidence(validatorParams,validatorTypes)},validator_coverage:{sql:validatorCoverageQuery(project,dataset),parameters:bindingEvidence(validatorParams,validatorTypes)}},tool:{name:'get_woocommerce_device_conversion',arguments:{start_date:start,end_date:end},status_filter:"grain='device' AND status='reportable'"},persisted_by_device_and_coverage_state:persisted,aggregate:{woo_coverage:aggregate.woo_coverage,rows:aggregate.rows},validation:{valid:true,expected_days:validation.expected_days,reportable_days:validation.covered_days,limited_or_unavailable_days:validation.limited_days}};
}

function parse(argv){const values={};for(const arg of argv){const match=arg.match(/^--(start|end)=(\d{4}-\d{2}-\d{2})$/);if(match)values[match[1]]=match[2];else throw new Error(`Unknown argument: ${arg}`);}return values;}
async function main(){const {bigquery,project}=createBigQueryClient();const args=parse(process.argv.slice(2));process.stdout.write(`${JSON.stringify(await diagnose({bigquery,project,...args}),null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(JSON.stringify({diagnostic:'oracle_woo_device_conversion',status:'failed',stage:error.stage||'unknown',error_code:error.code||'CHECK_FAILED',message:error.message,physical_rows:error.physical_rows}));process.exitCode=1;});
