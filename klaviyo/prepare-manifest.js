#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {parseMetricIds,PILOT} from './discovery.js';
import {requireGate} from './sync.js';

export const REVIEWED_ATTRIBUTION_SETTINGS={
  email_open_window_days:5,
  email_click_window_days:5,
  sms_delivery_window_hours:12,
  sms_click_window_days:5,
  exclude_transactional_messages:false,
  exclude_email_bot_clicks:true,
  exclude_sms_bot_clicks:true,
  exclude_apple_mpp_opens:false
};

export function extractDiscoveryJson(raw){
  for(let start=raw.indexOf('{');start>=0;start=raw.indexOf('{',start+1)){
    let depth=0,quoted=false,escaped=false;
    for(let i=start;i<raw.length;i++){const c=raw[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0){try{const value=JSON.parse(raw.slice(start,i+1));if(value?.gate_version===1)return value;}catch{}break;}}
  }
  throw new Error('No discovery manifest JSON object found in captured output');
}

export function prepareManifest(raw,{reviewer,reviewedAt,metricIds,evidencePath}){
  if(!reviewer?.trim())throw new Error('--reviewer is required');
  if(!Number.isFinite(new Date(reviewedAt).valueOf()))throw new Error('--reviewed-at must be an ISO timestamp');
  const source=extractDiscoveryJson(raw),selected=parseMetricIds(metricIds);
  const manifest={...source,pilot:{...PILOT},approved_for_pilot:true,approved_metric_ids:selected,attribution_settings:{...REVIEWED_ATTRIBUTION_SETTINGS},review:{reviewer:reviewer.trim(),reviewed_at:new Date(reviewedAt).toISOString(),source_evidence:evidencePath,source_sha256:createHash('sha256').update(raw).digest('hex'),method:'prepare:klaviyo-manifest'}};
  requireGate(manifest,{timezone:'Europe/London',currency:'GBP',metricIds:selected});
  return manifest;
}

function arg(name){const prefix=`--${name}=`;return process.argv.find(x=>x.startsWith(prefix))?.slice(prefix.length);}
export async function main(){const input=arg('input'),output=arg('output'),reviewer=arg('reviewer'),reviewedAt=arg('reviewed-at'),metricIds=arg('metric-ids');if(!input||!output)throw new Error('--input and --output are required');const raw=await readFile(input,'utf8'),evidencePath=`${output}.discovery.log`,manifest=prepareManifest(raw,{reviewer,reviewedAt,metricIds,evidencePath});await writeFile(evidencePath,raw,{flag:'wx'});await writeFile(output,`${JSON.stringify(manifest,null,2)}\n`,{flag:'wx'});console.log(JSON.stringify({status:'prepared',manifest:output,source_evidence:evidencePath,metric_ids:manifest.approved_metric_ids}));}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',message:error.message}));process.exitCode=1;});
