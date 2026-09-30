#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {createKlaviyoClient,redactKlaviyo} from './client.js';

export const PILOT={start:'2026-08-01T00:00:00',end:'2026-09-01T00:00:00'};
const endpoint={campaign:'/api/campaign-values-reports',flow:'/api/flow-values-reports'};
export const REPORT_STATISTICS=['recipients','delivered','opens','opens_unique','clicks','clicks_unique','conversions','conversion_value','bounced','unsubscribes','spam_complaints'];
const integration = metric => /woocommerce/i.test(metric.attributes?.integration?.name||metric.attributes?.name||'')?'woocommerce':/shopify/i.test(metric.attributes?.integration?.name||metric.attributes?.name||'')?'shopify':'other_or_unknown';
export function metricCatalogue(metrics){return metrics.map(m=>({metric_id:m.id,name:m.attributes?.name||null,integration:integration(m)}));}
export function reportBody(kind,metricId,{timezone,start=PILOT.start,end=PILOT.end}){if(!metricId)throw new Error('Explicit conversion metric ID is required');if(!timezone)throw new Error('Recorded Klaviyo account timezone is required');return {data:{type:`${kind}-values-report`,attributes:{statistics:REPORT_STATISTICS,timeframe:{key:'custom',start,end},conversion_metric_id:metricId,filter:`equals(messages.channel,'email')`}}};}
export async function discover({client,timezone,currency,conversionMetricIds=[]}){
  if(!timezone||!currency)throw new Error('KLAVIYO_ACCOUNT_TIMEZONE and KLAVIYO_ACCOUNT_CURRENCY must be recorded; the reporting API does not supply trusted defaults');
  const [metrics,campaigns,flows]=await Promise.all([client.paginate('/api/metrics'),client.paginate("/api/campaigns?filter=equals(messages.channel,'email')&page[size]=100"),client.paginate('/api/flows')]);
  const catalogue=metricCatalogue(metrics.data),known=new Set(catalogue.map(x=>x.metric_id));for(const id of conversionMetricIds)if(!known.has(id))throw new Error(`Configured conversion metric ID is not visible: ${id}`);
  const probes=[];for(const metricId of conversionMetricIds)for(const kind of ['campaign','flow']){const result=await client.request(endpoint[kind],{method:'POST',body:reportBody(kind,metricId,{timezone})});probes.push({kind,metric_id:metricId,row_count:Array.isArray(result?.data?.attributes?.results)?result.data.attributes.results.length:0,status:'available'});}
  const manifest={gate_version:1,read_only:true,pilot:PILOT,timezone,currency,metrics:catalogue,campaign_count:campaigns.data.length,flow_count:flows.data.length,probes,approved_for_pilot:false,limitations:['Metric IDs are integration-specific provenance and are never combined automatically.','Attribution settings were not assumed; record dashboard settings during approval.']};
  manifest.discovery_fingerprint=createHash('sha256').update(JSON.stringify(manifest)).digest('hex');return manifest;
}
export function parseMetricIds(value=''){return [...new Set(value.split(',').map(x=>x.trim()).filter(Boolean))];}
export async function main({env=process.env,write=console.log}={}){const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:Number(env.KLAVIYO_MAX_API_CALLS||40),timeoutMs:Number(env.KLAVIYO_TIMEOUT_MS||15000)});const result=await discover({client,timezone:env.KLAVIYO_ACCOUNT_TIMEZONE,currency:env.KLAVIYO_ACCOUNT_CURRENCY,conversionMetricIds:parseMetricIds(env.KLAVIYO_CONVERSION_METRIC_IDS)});write(JSON.stringify(result,null,2));return result;}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',code:error.code||error.name,message:redactKlaviyo(error.message)}));process.exitCode=1;});
