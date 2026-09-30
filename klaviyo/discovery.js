#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {createKlaviyoClient,redactKlaviyo} from './client.js';

export const PILOT={start:'2026-08-01T00:00:00',end:'2026-09-01T00:00:00'};
const endpoint={campaign:'/api/campaign-values-reports',flow:'/api/flow-values-reports'};
export const REPORT_STATISTICS={
  campaign:['recipients','delivered','opens','opens_unique','clicks','clicks_unique','conversions','conversion_value','bounced','unsubscribes','spam_complaints'],
  flow:['recipients','delivered','opens','opens_unique','clicks','clicks_unique','conversions','conversion_value','bounced','unsubscribes','spam_complaints']
};
// The 2026-07-15 campaign- and flow-values contracts share this report filter.
// Do not reuse the campaign-listing messages.channel contract here.
const reportFilter={campaign:`equals(send_channel,'email')`,flow:`equals(send_channel,'email')`};
const integration = metric => /woocommerce/i.test(metric.attributes?.integration?.name||metric.attributes?.name||'')?'woocommerce':/shopify/i.test(metric.attributes?.integration?.name||metric.attributes?.name||'')?'shopify':'other_or_unknown';
export function metricCatalogue(metrics){return metrics.map(m=>({metric_id:m.id,name:m.attributes?.name||null,integration:integration(m)}));}
function zonedDateTime(value,timezone){
  if(/[zZ]|[+-]\d\d:\d\d$/.test(value))return value;
  const instant=new Date(`${value}Z`),parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(instant).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  const represented=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second),offsetMinutes=Math.round((represented-instant.getTime())/60000),sign=offsetMinutes>=0?'+':'-',absolute=Math.abs(offsetMinutes),offset=`${sign}${String(Math.floor(absolute/60)).padStart(2,'0')}:${String(absolute%60).padStart(2,'0')}`;
  return `${value}${offset}`;
}
export function resolveReportWindow({timezone,start=PILOT.start,end=PILOT.end}){if(!timezone)throw new Error('Recorded Klaviyo account timezone is required');const timeframe={start:zonedDateTime(start,timezone),end:zonedDateTime(end,timezone)};const startInstant=new Date(timeframe.start),endInstant=new Date(timeframe.end);if(!Number.isFinite(startInstant.valueOf())||!Number.isFinite(endInstant.valueOf())||startInstant>=endInstant)throw new Error('Invalid report window');return {timeframe,startInstant:startInstant.toISOString(),endInstant:endInstant.toISOString()};}
export function reportBody(kind,metricId,{timezone,start=PILOT.start,end=PILOT.end,pageCursor}={}){if(!metricId)throw new Error('Explicit conversion metric ID is required');if(!endpoint[kind])throw new Error(`Unsupported report kind: ${kind}`);const attributes={statistics:REPORT_STATISTICS[kind],timeframe:resolveReportWindow({timezone,start,end}).timeframe,conversion_metric_id:metricId,filter:reportFilter[kind]};if(pageCursor!==undefined)attributes.page_cursor=pageCursor;return {data:{type:`${kind}-values-report`,attributes}};}
function probeError(kind,error){return {kind,endpoint:endpoint[kind],http_status:error.status||null,errors:(error.validationErrors?.length?error.validationErrors:[{code:error.code||error.name,title:null,detail:redactKlaviyo(error.message),source:{pointer:null,parameter:null}}])};}
export async function discover({client,timezone,currency,conversionMetricIds=[]}){
  if(!timezone||!currency)throw new Error('KLAVIYO_ACCOUNT_TIMEZONE and KLAVIYO_ACCOUNT_CURRENCY must be recorded; the reporting API does not supply trusted defaults');
  const [metrics,campaigns,flows]=await Promise.all([client.paginate('/api/metrics'),client.paginate("/api/campaigns?filter=equals(messages.channel,'email')&page[size]=100"),client.paginate('/api/flows')]);
  const catalogue=metricCatalogue(metrics.data),known=new Set(catalogue.map(x=>x.metric_id));for(const id of conversionMetricIds)if(!known.has(id))throw new Error(`Configured conversion metric ID is not visible: ${id}`);
  const probes=[];for(const metricId of conversionMetricIds)for(const kind of ['campaign','flow']){try{const result=await client.request(endpoint[kind],{method:'POST',body:reportBody(kind,metricId,{timezone})});probes.push({kind,metric_id:metricId,row_count:Array.isArray(result?.data?.attributes?.results)?result.data.attributes.results.length:0,status:'available'});}catch(error){probes.push({kind,metric_id:metricId,status:'failed',error:probeError(kind,error)});}}
  const manifest={gate_version:1,read_only:true,pilot:PILOT,timezone,currency,metrics:catalogue,campaign_count:campaigns.data.length,flow_count:flows.data.length,probes,approved_for_pilot:false,limitations:['Metric IDs are integration-specific provenance and are never combined automatically.','Attribution settings were not assumed; record dashboard settings during approval.']};
  manifest.discovery_fingerprint=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');return manifest;
}
export function parseMetricIds(value=''){return [...new Set(value.split(',').map(x=>x.trim()).filter(Boolean))];}
export async function main({env=process.env,write=console.log}={}){const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:Number(env.KLAVIYO_MAX_API_CALLS||40),timeoutMs:Number(env.KLAVIYO_TIMEOUT_MS||15000)});const result=await discover({client,timezone:env.KLAVIYO_ACCOUNT_TIMEZONE,currency:env.KLAVIYO_ACCOUNT_CURRENCY,conversionMetricIds:parseMetricIds(env.KLAVIYO_CONVERSION_METRIC_IDS)});write(JSON.stringify(result,null,2));if(result.probes.some(x=>x.status==='failed'))throw Object.assign(new Error('One or more Klaviyo report probes failed; see sanitized probe evidence'),{code:'REPORT_PROBE_FAILED'});return result;}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',code:error.code||error.name,message:redactKlaviyo(error.message)}));process.exitCode=1;});
