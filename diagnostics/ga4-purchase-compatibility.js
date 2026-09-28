#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { loadConfig } from './ga4-access.js';
import { assertDate } from '../ga4/semantic.js';
import { checkMetricCompatibility } from '../ga4/sync.js';

export const PROBE_DATES=Object.freeze(['2022-08-18','2022-09-17']);
export const PURCHASE_METRICS=Object.freeze(['ecommercePurchases','totalPurchasers']);
export const PURCHASE_GRAINS=Object.freeze({device:['date','deviceCategory'],traffic_source:['date','deviceCategory','sessionDefaultChannelGroup','sessionSource','sessionMedium']});

export function parsePurchaseProbeArgs(argv){
  if(!argv.length)return{dates:[...PROBE_DATES]};
  if(argv.length!==2||argv[0]!=='--dates')throw new Error('Usage: npm run diagnose:ga4-purchase-compatibility -- [--dates YYYY-MM-DD,YYYY-MM-DD]');
  const dates=[...new Set(argv[1].split(',').map(date=>assertDate(date,'date')))];
  if(!dates.length||dates.length>2)throw new Error('Compatibility probe is bounded to one or two dates');
  if(dates.some(date=>date<'2022-08-18'||date>'2025-11-19'))throw new Error('Compatibility probe dates must be in the Woo era');
  return{dates};
}

export async function probePurchaseCompatibility({client,propertyId,dates=PROBE_DATES}){
  if(dates.length<1||dates.length>2)throw new Error('Compatibility probe is bounded to one or two dates');
  const results=[];
  for(const [grain,dimensions] of Object.entries(PURCHASE_GRAINS))for(const metric of PURCHASE_METRICS){
    const compatibility=await checkMetricCompatibility(client,propertyId,dimensions,metric);
    let execution={available:false,row_count:null,reason:compatibility.reason};
    if(compatibility.compatible)try{const [response]=await client.runReport({property:`properties/${propertyId}`,dateRanges:dates.map(date=>({startDate:date,endDate:date})),dimensions:dimensions.map(name=>({name})),metrics:[{name:metric}],limit:1000,returnPropertyQuota:true});execution={available:true,row_count:Number(response.rowCount??response.rows?.length??0),reason:'bounded report succeeded'};}catch(error){execution={available:false,row_count:null,reason:String(error?.message||error).slice(0,500)};}
    results.push({grain,dimensions,metric,compatibility,execution});
  }
  return{diagnostic:'ga4_purchase_numerator_compatibility',read_only:true,property_id:propertyId,dates,bound:{maximum_dates:2,maximum_rows_per_report:1000,reports:4},results,note:'Availability requires both the GA4 compatibility response and a successful bounded report. A missing metric row is not interpreted as zero.'};
}

async function main(){const{dates}=parsePurchaseProbeArgs(process.argv.slice(2));const{propertyId,credentials}=loadConfig();const result=await probePurchaseCompatibility({client:new BetaAnalyticsDataClient({credentials}),propertyId,dates});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
