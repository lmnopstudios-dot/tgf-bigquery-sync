#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { bigQueryDateParameters,describeDateParameter } from '../bigquery/date-parameters.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { conversionQueries,createDeviceSourceConversionService } from '../oracle/device-source-conversion.js';
import { SHOPIFY_LAUNCH_COMPARISON_ARGS } from '../oracle/shopify-launch-device-conversion-request.js';
import { validationQuery } from './conversion-history-validation.js';

const MAXIMUM_BYTES_BILLED=1_000_000_000;
const expectedDays=56;
const safeId=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid project');return value;};

/** Physical labels are deliberately not normalized in this inventory's grouping. */
export function physicalShopifyDeviceQuery(project){safeId(project);return `SELECT device_type persisted_device_label,LOWER(TRIM(device_type)) normalized_device_type,
  COUNT(*) physical_rows,COUNT(DISTINCT date) covered_days,MIN(date) first_date,MAX(date) last_date,
  SUM(sessions) sessions,SUM(sessions_that_completed_checkout) completed_checkout_sessions
FROM \`${project}.shopify_data.session_conversion_by_device\`
WHERE date BETWEEN @after_start AND @after_end
GROUP BY 1,2 ORDER BY 1`;}

const bindingEvidence=(params,types)=>Object.fromEntries(Object.keys(types).map(name=>[name,describeDateParameter(params[name],types[name])]));

export async function diagnose({bigquery,project}){
  const periods={...SHOPIFY_LAUNCH_COMPARISON_ARGS};
  const params=bigQueryDateParameters(periods),types=Object.fromEntries(Object.keys(periods).map(key=>[key,'DATE']));
  const [shopifyLocation,ga4Location]=await Promise.all([datasetLocation(bigquery,project,'shopify_data',{fallback:'US'}),datasetLocation(bigquery,project,process.env.GA4_DATASET||'ga4',{fallback:'EU'})]);
  const common={params,types,useLegacySql:false,maximumBytesBilled:MAXIMUM_BYTES_BILLED};
  const physical={...common,query:physicalShopifyDeviceQuery(project),location:shopifyLocation,labels:{component:'oracle_shopify_device_physical'}};
  const validationParams=bigQueryDateParameters({start:periods.after_start,end:periods.after_end}),validationTypes={start:'DATE',end:'DATE'};
  const structural={...common,params:validationParams,types:validationTypes,query:validationQuery(project),location:shopifyLocation,labels:{component:'oracle_shopify_device_validation'}};
  for(const [stage,job] of [['physical_shopify',physical],['validated_shopify',structural]]){try{await bigquery.createQueryJob({...job,dryRun:true});}catch{throw Object.assign(new Error(`${stage} dry-run failed`),{stage:`dry_run:${stage}`});}}
  const [[physicalRows],[validationRows]]=await Promise.all([bigquery.query(physical),bigquery.query(structural)]);
  const aggregate=await createDeviceSourceConversionService({bigquery,project,dataset:process.env.GA4_DATASET||'ga4',dryRun:true})('compare_device_conversion_before_after_shopify',periods);
  const physicalByNormalized=new Map();
  for(const row of physicalRows){const key=String(row.normalized_device_type);const item=physicalByNormalized.get(key)||{covered_days:0,sessions:0,numerator:0};item.covered_days=Math.max(item.covered_days,Number(row.covered_days||0));item.sessions+=Number(row.sessions||0);item.numerator+=Number(row.completed_checkout_sessions||0);physicalByNormalized.set(key,item);}
  const helperAfter=new Map(aggregate.rows.filter(row=>row.period==='after').map(row=>[String(row.device_type).toLowerCase(),row]));
  const validated=validationRows[0]||{};
  const validationComplete=['missing_device_days','duplicate_device_keys','impossible_device_funnels'].every(key=>Number(validated[key]||0)===0);
  for(const device of ['desktop','mobile']){
    const physicalDevice=physicalByNormalized.get(device),helperDevice=helperAfter.get(device);
    if((validationComplete||physicalDevice?.covered_days===expectedDays)&&(!helperDevice||Number(helperDevice.coverage?.covered_days||0)===0))throw Object.assign(new Error(`Validated/physical ${device} coverage contradicts the Oracle helper's zero-row result`),{code:'SHOPIFY_DEVICE_ORACLE_CONTRADICTION',stage:'validate:physical_vs_oracle',device,physical_rows:physicalRows,validation:validated});
  }
  const queries=conversionQueries(project,{dataset:process.env.GA4_DATASET||'ga4'});
  return{diagnostic:'oracle_shopify_launch_device_conversion',read_only:true,range:periods,expected_days_per_period:expectedDays,storage:{project,shopify_dataset:'shopify_data',shopify_location:shopifyLocation,ga4_dataset:process.env.GA4_DATASET||'ga4',ga4_location:ga4Location},device_normalization:{persisted:'actual labels shown verbatim in physical_rows',comparison_helper:"LOWER(TRIM(device_type)) IN ('desktop','mobile')"},query_bindings:{comparison_parameters:bindingEvidence(params,types),validation_parameters:bindingEvidence(validationParams,validationTypes),physical_sql:physical.query,validation_sql:structural.query,comparison_helper_shopify_sql:queries.shopify},physical_rows:physicalRows,history_validation:validated,comparison_helper:{tool:'compare_device_conversion_before_after_shopify',rows:aggregate.rows,cross_platform_percentage_point_difference:aggregate.cross_platform_percentage_point_difference,comparability:aggregate.comparability},acceptance:{valid:true,validation_complete:validationComplete}};
}

async function main(){const {bigquery,project}=createBigQueryClient();process.stdout.write(`${JSON.stringify(await diagnose({bigquery,project}),null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(JSON.stringify({diagnostic:'oracle_shopify_launch_device_conversion',status:'failed',stage:error.stage||'unknown',error_code:error.code||'CHECK_FAILED',message:error.message,device:error.device,physical_rows:error.physical_rows,validation:error.validation}));process.exitCode=1;});
