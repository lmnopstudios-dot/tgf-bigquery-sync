#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { loadConfig } from './ga4-access.js';
import { assertDate } from '../ga4/semantic.js';
import { diagnoseSessionReconciliation } from './ga4-session-reconciliation.js';

// A deliberately small, seasonally spread sample. It includes the known first
// coverage day and multiple Woo-era dates in every full year before launch.
export const REPRESENTATIVE_WOO_DATES=Object.freeze([
  '2022-08-18','2023-02-15','2023-08-17','2023-11-24',
  '2024-02-15','2024-08-15','2024-11-29',
  '2025-02-13','2025-08-14','2025-11-19'
]);
const MAX_DATES=24;

export function parseCoverageProbeArgs(argv){
  if(!argv.length)return{dates:[...REPRESENTATIVE_WOO_DATES]};
  if(argv.length!==2||argv[0]!=='--dates')throw new Error('Usage: npm run diagnose:ga4-device-coverage -- [--dates YYYY-MM-DD,...]');
  const dates=[...new Set(argv[1].split(',').filter(Boolean).map(date=>assertDate(date,'date')))];
  if(!dates.length||dates.length>MAX_DATES)throw new Error(`Coverage probe requires between 1 and ${MAX_DATES} dates`);
  if(dates.some(date=>date>'2025-11-19'))throw new Error('Coverage probe dates must remain in the Woo era ending 2025-11-19');
  return{dates};
}

export async function probeDeviceCoverage({client,propertyId,dates=REPRESENTATIVE_WOO_DATES}){
  if(dates.length>MAX_DATES)throw new Error(`Coverage probe is bounded to ${MAX_DATES} dates`);
  const results=[];
  for(const date of dates){
    const result=await diagnoseSessionReconciliation({client,propertyId,date});
    const grain=result.grains.device;
    results.push({date,date_sessions:result.grains.date.sessions,device_sessions:grain.sessions,difference:grain.difference_from_date,device_reportable:grain.reconciles,first_non_reconciling_grain:result.disappearance.first_non_reconciling_grain,highest_reconciling_grain:result.disappearance.highest_reconciling_grain});
  }
  const reportable=results.filter(row=>row.device_reportable).length;
  return{diagnostic:'ga4_bounded_woo_device_coverage_probe',read_only:true,requested_dates:dates.length,api_reports:dates.length*4,bound:{maximum_dates:MAX_DATES,maximum_rows_per_report:100000},device_reportable_dates:reportable,device_incomplete_dates:dates.length-reportable,device_reconciliation_rate:dates.length?reportable/dates.length:null,excluded_dates:results.filter(row=>!row.device_reportable).map(row=>row.date),dates:results,note:'Sample evidence only. Conversion is reportable only for individually validated dates; excluded dates receive no inferred device.'};
}

async function main(){const {dates}=parseCoverageProbeArgs(process.argv.slice(2));const {propertyId,credentials}=loadConfig();const result=await probeDeviceCoverage({client:new BetaAnalyticsDataClient({credentials}),propertyId,dates});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
