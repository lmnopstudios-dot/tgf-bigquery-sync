#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { loadConfig } from './ga4-access.js';
import { assertDate } from '../ga4/semantic.js';
import { checkMetricCompatibility } from '../ga4/sync.js';

export const PROBE_DATES=Object.freeze(['2022-08-18']);
export const PURCHASE_METRICS=Object.freeze(['ecommercePurchases','totalPurchasers']);
export const PURCHASE_GRAINS=Object.freeze({device:['date','deviceCategory'],traffic_source:['date','deviceCategory','sessionDefaultChannelGroup','sessionSource','sessionMedium']});

export function parsePurchaseProbeArgs(argv){
  if(!argv.length)return{dates:[...PROBE_DATES]};
  if(argv.length!==2||argv[0]!=='--dates')throw new Error('Usage: npm run diagnose:ga4-purchase-compatibility -- [--dates YYYY-MM-DD]');
  const dates=[...new Set(argv[1].split(',').map(date=>assertDate(date,'date')))];
  if(dates.length!==1)throw new Error('Compatibility probe is bounded to exactly one Woo date');
  if(dates.some(date=>date<'2022-08-18'||date>'2025-11-19'))throw new Error('Compatibility probe dates must be in the Woo era');
  return{dates};
}

export async function probePurchaseCompatibility({client,propertyId,dates=PROBE_DATES}){
  if(dates.length!==1)throw new Error('Compatibility probe is bounded to exactly one Woo date');
  const results=[];
  for(const [grain,dimensions] of Object.entries(PURCHASE_GRAINS))for(const metric of PURCHASE_METRICS){
    const compatibility=await checkMetricCompatibility(client,propertyId,dimensions,metric);
    let execution={executed:false,succeeded:false,row_count:null,totals:null,metadata:null,reason:compatibility.reason};
    if(compatibility.compatible)try{const [response]=await client.runReport({property:`properties/${propertyId}`,dateRanges:dates.map(date=>({startDate:date,endDate:date})),dimensions:dimensions.map(name=>({name})),metrics:[{name:metric}],metricAggregations:['TOTAL'],limit:1000,returnPropertyQuota:true});const totals=(response.totals||[]).map(total=>Object.fromEntries([metric].map((name,index)=>[name,total.metricValues?.[index]?.value??null])));execution={executed:true,succeeded:true,row_count:Number(response.rowCount??response.rows?.length??0),totals,metadata:{report:response.metadata||null,property_quota:response.propertyQuota||null},reason:'bounded report succeeded'};}catch(error){const safe=String(error?.message||error).replace(/-----BEGIN[\s\S]+?END PRIVATE KEY-----/g,'[REDACTED]');execution={executed:true,succeeded:false,row_count:null,totals:null,metadata:null,reason:safe.slice(0,500)};}
    results.push({grain,dimensions,metric,compatibility,execution});
  }
  return{diagnostic:'ga4_purchase_numerator_compatibility',read_only:true,property_id:propertyId,dates,bound:{maximum_dates:1,maximum_rows_per_report:1000,reports:4},results,note:'The diagnostic emits compatibility names/enums plus only aggregate report counts, totals, and metadata. An uninterpretable compatibility response fails the diagnostic and is not classified as GA4 data unavailable.'};
}

async function main(){const{dates}=parsePurchaseProbeArgs(process.argv.slice(2));const{propertyId,credentials}=loadConfig();const result=await probePurchaseCompatibility({client:new BetaAnalyticsDataClient({credentials}),propertyId,dates});process.stdout.write(`${JSON.stringify(result,null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
