#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {datasetLocation} from '../bigquery/dataset-location.js';

const MAXIMUM_BYTES_BILLED=10_000_000;
const IDENTIFIER=/^[A-Za-z0-9_-]+$/;

function tableParts(value){
  const parts=String(value).split('.');
  if(parts.length!==3||!parts.every(part=>IDENTIFIER.test(part.replace(/\*$/,''))))throw new Error('Invalid configuration: GA4_SESSION_EVENTS_TABLE');
  return parts;
}

export async function runDiscovery({bigquery,project,rawTable,ga4Dataset='ga4',locationFallback='EU'}){
  if(!IDENTIFIER.test(project)||!IDENTIFIER.test(ga4Dataset))throw new Error('Invalid BigQuery project or dataset configuration');
  const aggregate=[`${project}.${ga4Dataset}.daily`,`${project}.${ga4Dataset}.ecommerce_funnel`];
  const rawParts=rawTable?tableParts(rawTable):null;
  const datasets=new Map([[`${project}.${ga4Dataset}`,[project,ga4Dataset]]]);
  if(rawParts)datasets.set(`${rawParts[0]}.${rawParts[1]}`,rawParts);
  const locations=new Map(await Promise.all([...datasets].map(async([key,[datasetProject,dataset]])=>[
    key,await datasetLocation(bigquery,datasetProject,dataset,{fallback:locationFallback})
  ])));
  const inventory=[];
  for(const name of aggregate){
    const [p,d,t]=tableParts(name);
    const [rows]=await bigquery.query({query:`SELECT table_name,column_name,data_type FROM \`${p}.${d}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name=@table ORDER BY ordinal_position`,params:{table:t},location:locations.get(`${p}.${d}`),useLegacySql:false,maximumBytesBilled:MAXIMUM_BYTES_BILLED});
    inventory.push({table:name,columns:rows});
  }
  let session_level={configured:false,available:false,table:rawTable||null,required_columns:['event_date','event_name','event_timestamp','user_pseudo_id','ga_session_id','item_id'],missing_columns:[]};
  if(rawParts){
    const [p,d,t]=rawParts;
    const [rows]=await bigquery.query({query:`SELECT column_name,data_type FROM \`${p}.${d}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name=@table ORDER BY ordinal_position`,params:{table:t.replace(/\*$/,'')},location:locations.get(`${p}.${d}`),useLegacySql:false,maximumBytesBilled:MAXIMUM_BYTES_BILLED});
    const names=new Set(rows.map(row=>row.column_name));
    session_level={...session_level,configured:true,available:session_level.required_columns.every(column=>names.has(column)),missing_columns:session_level.required_columns.filter(column=>!names.has(column)),columns:rows};
  }
  return {diagnostic:'product_view_purchase_evidence',read_only:true,configuration:{project,ga4_dataset:ga4Dataset,dataset_locations:Object.fromEntries(locations),missing:rawTable?[]:['GA4_SESSION_EVENTS_TABLE']},public_shopify_launch:'2025-11-20',requested_periods:{current:['2026-01-01','2026-09-30'],woocommerce:['2024-11-20','2025-11-19']},session_level,aggregate_sources:inventory,shopify_analytics:{status:'aggregate_only_for_this_metric',note:'Existing Shopify analytics integrations expose aggregate sessions/funnel measures, not product-ID event sequences within a session.'},determination:session_level.available?'SESSION_LEVEL_SCHEMA_PRESENT_VERIFY_COVERAGE':'METRIC_NOT_ESTABLISHED',warning:'Aggregate product views and purchase/order counts cannot establish products viewed before buying. Order data cannot reconstruct historical browsing.'};
}

export async function main({env=process.env,BigQueryClass,write=value=>process.stdout.write(value)}={}){
  const {project,bigquery}=createBigQueryClient(env,BigQueryClass);
  const report=await runDiscovery({bigquery,project,rawTable:env.GA4_SESSION_EVENTS_TABLE,ga4Dataset:env.GA4_DATASET||'ga4',locationFallback:env.GA4_SESSION_EVENTS_LOCATION||'EU'});
  write(`${JSON.stringify(report,null,2)}\n`);
  return report;
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(JSON.stringify({diagnostic:'product_view_purchase_evidence',status:'failed',message:error.message}));process.exitCode=1;});
