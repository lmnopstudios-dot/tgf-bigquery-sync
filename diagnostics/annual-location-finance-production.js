import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { bigQueryDateParameters, describeDateParameter } from '../bigquery/date-parameters.js';
import { ANNUAL_LOCATION_MAX_BYTES, annualLocationFinanceQuery } from '../oracle/annual-location-finance.js';

export const INCIDENT_START='2022-01-01';
export const INCIDENT_END='2026-09-30';
export const SHOPIFY_REPORTED_THROUGH='2026-09-24';
export const DISPUTED_SHOPIFY_TRANSACTION='gid://shopify/OrderTransaction/8599590666567';
const DATASETS=['finance','shopify_data','woocommerce_uk','woocommerce_us','square_data'];

export function schemaEvidenceQuery(project,dataset) {
  return `SELECT table_name,column_name,data_type FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE REGEXP_CONTAINS(LOWER(column_name),r'(tax|location|shipping|currency|refund)') ORDER BY table_name,ordinal_position LIMIT 1000`;
}

export function metadataEvidenceQueries(project,dataset) {
  return {
    [`${dataset}_tables`]:`SELECT table_name,table_type,creation_time,ddl FROM \`${project}.${dataset}.INFORMATION_SCHEMA.TABLES\` ORDER BY table_name`,
    [`${dataset}_partitions`]:`SELECT table_name,MIN(last_modified_time) earliest_partition_modified,MAX(last_modified_time) latest_partition_modified,SUM(total_rows) stored_rows FROM \`${project}.${dataset}.INFORMATION_SCHEMA.PARTITIONS\` WHERE partition_id IS NOT NULL GROUP BY table_name ORDER BY table_name`
  };
}

const ERROR_FIELD_LIMIT=500;

function safeErrorField(value) {
  if(typeof value!=='string') return undefined;
  return value.replace(/[\u0000-\u001f\u007f]+/g,' ')
    .replace(/(authorization|bearer|credential|api[_-]?key|access[_-]?token)(\s*[:=]\s*|\s+)[^\s,;]+/gi,'$1$2[REDACTED]')
    .slice(0,ERROR_FIELD_LIMIT);
}

export function bigQueryFailureDetail(error) {
  const source=Array.isArray(error?.errors)?error.errors[0]:undefined;
  return Object.fromEntries([['reason',safeErrorField(source?.reason)],['bigquery_message',safeErrorField(source?.message)],['location',safeErrorField(source?.location)]].filter(([,value])=>value));
}

function queryFailure(stage,error) {
  const causeCode=error?.code||error?.name||'QUERY_ERROR';
  return Object.assign(new Error(`Annual location finance diagnostic failed during ${stage}`),{stage,cause_code:causeCode,...bigQueryFailureDetail(error)});
}

async function dryRun(bigquery,stage,options) {
  try { await bigquery.createQueryJob({...options,dryRun:true}); }
  catch(error) { throw queryFailure(`dry_run:${stage}`,error); }
}

async function read(bigquery,stage,options) {
  try { return await bigquery.query(options); }
  catch(error) { throw queryFailure(`query:${stage}`,error); }
}

export function incidentQueries(project) {
  const table=`\`${project}.finance.accountant_transactions\``;
  const filter=`date BETWEEN @start_date AND @end_date AND (@currency IS NULL OR UPPER(currency)=UPPER(@currency))`;
  return {
    read_path_comparison:`WITH base AS (SELECT * FROM ${table} WHERE ${filter})
      SELECT 'annual_overall' read_path,EXTRACT(YEAR FROM date) year,currency,NULL dimension,SUM(gross) net_amount_including_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) observed_net_ex_tax,COUNT(*) records FROM base GROUP BY year,currency
      UNION ALL SELECT 'annual_location',EXTRACT(YEAR FROM date) year,currency,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') dimension,SUM(gross),SUM(tax),SUM(net_ex_tax),COUNT(*) FROM base GROUP BY year,currency,dimension
      UNION ALL SELECT 'online_channel',EXTRACT(YEAR FROM date) year,currency,COALESCE(NULLIF(TRIM(source),''),'Unknown / unallocated') dimension,SUM(gross),SUM(tax),SUM(net_ex_tax),COUNT(*) FROM base WHERE LOWER(channel)='online' GROUP BY year,currency,dimension
      ORDER BY year,currency,read_path,dimension`,
    location_reconciliation:`WITH base AS (SELECT EXTRACT(YEAR FROM date) year,currency,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') location,gross,tax,net_ex_tax FROM ${table} WHERE ${filter}), locations AS (SELECT year,currency,location,SUM(gross) gross,SUM(tax) tax,SUM(net_ex_tax) ex_tax,COUNTIF(tax IS NULL) missing_tax FROM base GROUP BY 1,2,3), overall AS (SELECT year,currency,SUM(gross) gross,SUM(tax) tax,SUM(net_ex_tax) ex_tax,COUNTIF(tax IS NULL) missing_tax FROM base GROUP BY 1,2) SELECT o.*,COUNT(l.location) location_rows,SUM(l.gross)-o.gross gross_difference,IF(o.missing_tax=0 AND SUM(l.missing_tax)=0,SUM(l.tax)-o.tax,NULL) tax_difference,IF(COUNTIF(l.ex_tax IS NULL)=0,SUM(l.ex_tax)-o.ex_tax,NULL) ex_tax_difference FROM overall o JOIN locations l USING(year,currency) GROUP BY ALL ORDER BY year,currency`,
    online_difference:`WITH base AS (SELECT * FROM ${table} WHERE ${filter} AND EXTRACT(YEAR FROM date)=2026), by_channel AS (SELECT currency,SUM(gross) amount FROM base WHERE LOWER(channel)='online' GROUP BY currency), by_location AS (SELECT currency,SUM(gross) amount FROM base WHERE LOWER(COALESCE(location,''))='online' GROUP BY currency) SELECT COALESCE(c.currency,l.currency) currency,c.amount online_channel_amount,l.amount online_location_amount,l.amount-c.amount location_minus_channel FROM by_channel c FULL JOIN by_location l USING(currency)`,
    online_cross_classification:`SELECT source,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') sales_location,currency,COUNT(*) records,SUM(gross) amount,SUM(tax) observed_recorded_tax,COUNTIF(tax IS NULL) missing_tax_records FROM ${table} WHERE ${filter} AND EXTRACT(YEAR FROM date)=2026 AND (LOWER(COALESCE(channel,''))='online' OR LOWER(COALESCE(location,''))='online') GROUP BY 1,2,3,4 ORDER BY ABS(amount) DESC LIMIT 100`,
    rounding:`SELECT EXTRACT(YEAR FROM date) year,currency,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') channel,COUNT(*) records,SUM(gross) net_amount_including_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) stored_net_ex_tax,SUM(gross)-SUM(tax) derived_gross_less_tax,SUM(net_ex_tax)-(SUM(gross)-SUM(tax)) stored_component_difference,COUNTIF(tax IS NULL) missing_tax_records,COUNTIF(net_ex_tax IS NULL) missing_ex_tax_records FROM ${table} WHERE ${filter} GROUP BY 1,2,3 ORDER BY year,currency,channel`,
    disputed_location:`SELECT source,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') recorded_sales_location,currency,transaction_type,COUNT(*) records,SUM(gross) amount_including_recorded_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) observed_ex_tax,COUNTIF(tax IS NULL) missing_tax_records,ARRAY_AGG(CAST(transaction_id AS STRING) IGNORE NULLS ORDER BY date LIMIT 20) bounded_transaction_ids,'finance.accountant_transactions.location' mapping_provenance FROM ${table} WHERE ${filter} AND EXTRACT(YEAR FROM date)=2025 AND LOWER(COALESCE(location,''))=LOWER(@disputed_location) GROUP BY 1,2,3,4,5 ORDER BY ABS(amount_including_recorded_tax) DESC`,
    source_tax_coverage:`SELECT source,currency,MIN(date) earliest_evidence,MAX(date) latest_evidence,COUNT(*) records,COUNTIF(tax IS NOT NULL) recorded_tax_records,COUNTIF(tax IS NULL) missing_tax_records,COUNTIF(tax=0) observed_zero_tax_records,SUM(tax) observed_recorded_tax FROM ${table} WHERE ${filter} GROUP BY source,currency ORDER BY source,currency`,
    component_breakdown:`SELECT EXTRACT(YEAR FROM date) year,COALESCE(NULLIF(TRIM(source),''),'Unknown / unallocated') source,LOWER(transaction_type) transaction_type,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') sales_location,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,currency,COUNT(*) records,SUM(gross) net_amount_including_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) stored_net_ex_tax,SUM(net_ex_tax)-(SUM(gross)-SUM(tax)) stored_component_difference,COUNTIF(tax IS NULL) missing_tax_records,COUNTIF(net_ex_tax IS NULL) missing_ex_tax_records FROM ${table} WHERE ${filter} GROUP BY 1,2,3,4,5,6 ORDER BY year,currency,ABS(stored_component_difference) DESC`,
    component_examples:`SELECT EXTRACT(YEAR FROM date) year,source,LOWER(transaction_type) transaction_type,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') sales_location,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,currency,CAST(transaction_id AS STRING) transaction_id,date,gross amount_including_tax,tax recorded_tax,net_ex_tax stored_net_ex_tax,net_ex_tax-(gross-tax) stored_component_difference FROM ${table} WHERE ${filter} AND tax IS NOT NULL AND net_ex_tax IS NOT NULL AND ABS(net_ex_tax-(gross-tax))>=@material_difference QUALIFY ROW_NUMBER() OVER(PARTITION BY EXTRACT(YEAR FROM date),source,transaction_type,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated'),currency ORDER BY ABS(net_ex_tax-(gross-tax)) DESC,date,CAST(transaction_id AS STRING))<=@example_limit ORDER BY year,currency,ABS(stored_component_difference) DESC`,
    location_channel_population:`SELECT EXTRACT(YEAR FROM date) year,source,LOWER(transaction_type) transaction_type,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') sales_location,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,currency,COUNT(*) records,SUM(gross) amount_including_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) stored_net_ex_tax,ARRAY_AGG(CAST(transaction_id AS STRING) IGNORE NULLS ORDER BY date,CAST(transaction_id AS STRING) LIMIT 20) bounded_transaction_ids FROM ${table} WHERE ${filter} AND EXTRACT(YEAR FROM date)=2026 AND (LOWER(COALESCE(location,''))='online' OR LOWER(COALESCE(channel,''))='online') AND (LOWER(COALESCE(location,''))!='online' OR LOWER(COALESCE(channel,''))!='online') GROUP BY 1,2,3,4,5,6 ORDER BY ABS(amount_including_tax) DESC`,
    duplicate_representations:`SELECT source,currency,CAST(transaction_id AS STRING) transaction_id,LOWER(transaction_type) transaction_type,COUNT(*) representations,COUNT(DISTINCT CONCAT(CAST(date AS STRING),'|',COALESCE(location,''),'|',COALESCE(channel,''),'|',CAST(gross AS STRING),'|',COALESCE(CAST(tax AS STRING),'NULL'))) distinct_representations,ARRAY_AGG(STRUCT(date,location,channel,gross,tax,net_ex_tax) ORDER BY date LIMIT 5) bounded_rows FROM ${table} WHERE ${filter} AND transaction_id IS NOT NULL GROUP BY 1,2,3,4 HAVING COUNT(*)>1 ORDER BY representations DESC LIMIT 100`,
    annual_tax_comparison:`SELECT EXTRACT(YEAR FROM date) year,currency,SUM(IF(LOWER(transaction_type)='sale',tax,NULL)) sale_tax,SUM(IF(LOWER(transaction_type)='refund',tax,NULL)) refund_tax,SUM(tax) net_recorded_tax,COUNTIF(tax IS NULL) missing_tax_records FROM ${table} WHERE ${filter} GROUP BY 1,2 ORDER BY 1,2`
  };
}

export function shopifyEvidenceQueries(project) {
  const f=`\`${project}.shopify_data.order_financials\``,l=`\`${project}.shopify_data.order_locations\``,r=`\`${project}.shopify_data.order_refunds\``;
  return {
    shopify_collection_freshness:`SELECT 'orders' evidence_kind,MIN(DATE(created_at)) earliest_native_date,MAX(DATE(created_at)) latest_native_date,MAX(synced_at) verified_collection_timestamp,COUNTIF(DATE(created_at)>@shopify_reported_through AND DATE(created_at)<=@end_date) native_rows_after_reported_through FROM ${f} UNION ALL SELECT 'refunds',MIN(DATE(refund_created_at)),MAX(DATE(refund_created_at)),MAX(synced_at),COUNTIF(DATE(refund_created_at)>@shopify_reported_through AND DATE(refund_created_at)<=@end_date) FROM ${r} UNION ALL SELECT 'finance_ledger',MIN(date),MAX(date),CAST(NULL AS TIMESTAMP),COUNTIF(date>@shopify_reported_through AND date<=@end_date) FROM \`${project}.finance.accountant_transactions\` WHERE REGEXP_CONTAINS(LOWER(COALESCE(source,'')),r'shopify')`,
    disputed_shopify_source:`WITH native AS (SELECT f.order_id,f.order_name,DATE(f.created_at) order_date,f.presentment_currency,f.original_total_presentment,f.original_tax_presentment,f.original_subtotal_presentment,f.original_discounts_presentment,f.original_shipping_presentment,l.order_source,l.source_app_id,l.retail_location_id,l.retail_location_name,JSON_VALUE(t,'$.id') transaction_id,JSON_VALUE(t,'$.kind') transaction_kind,JSON_VALUE(t,'$.status') transaction_status,JSON_VALUE(t,'$.amountSet.presentmentMoney.amount') transaction_amount,JSON_VALUE(t,'$.amountSet.presentmentMoney.currencyCode') transaction_currency FROM ${f} f JOIN ${l} l USING(order_id),UNNEST(JSON_QUERY_ARRAY(f.transactions_json)) t) SELECT * FROM native WHERE transaction_id=@disputed_transaction LIMIT 20`,
    shopify_native_components:`SELECT EXTRACT(YEAR FROM DATE(f.created_at)) year,IF(l.retail_location_id IS NULL,'Online',COALESCE(NULLIF(l.retail_location_name,''),'POS unknown / unallocated')) source_sales_location,UPPER(f.presentment_currency) currency,COUNT(*) orders,SUM(f.original_total_presentment) amount_including_tax,SUM(f.original_tax_presentment) recorded_tax,SUM(f.original_subtotal_presentment) subtotal,SUM(f.original_discounts_presentment) discounts,SUM(f.original_shipping_presentment) shipping,COUNTIF(f.original_total_presentment-(f.original_subtotal_presentment+f.original_shipping_presentment-f.original_discounts_presentment)!=f.original_tax_presentment) non_additive_orders FROM ${f} f JOIN ${l} l USING(order_id) WHERE DATE(f.created_at) BETWEEN @start_date AND @end_date GROUP BY 1,2,3 ORDER BY 1,3,2`,
    shopify_refund_components:`SELECT EXTRACT(YEAR FROM DATE(refund_created_at)) year,UPPER(presentment_currency) currency,COUNT(*) refund_events,SUM(refund_total_presentment) refund_total,SUM(refund_line_subtotal_presentment) line_subtotal,SUM(refund_shipping_subtotal_presentment) shipping_subtotal,SUM(refund_line_tax_presentment) line_tax,SUM(refund_shipping_tax_presentment) shipping_tax,SUM(refund_adjustment_tax_presentment) adjustment_tax,SUM(refund_tax_presentment) recorded_refund_tax,COUNTIF(has_successful_refund_transaction) successful_refund_events FROM ${r} WHERE DATE(refund_created_at) BETWEEN @start_date AND @end_date GROUP BY 1,2 ORDER BY 1,2`
  };
}

export async function diagnose({bigquery,project,start=INCIDENT_START,end=INCIDENT_END,currency=null,disputedLocation='Online Ready to Ship',shopifyReportedThrough=SHOPIFY_REPORTED_THROUGH,disputedTransaction=DISPUTED_SHOPIFY_TRANSACTION}) {
  const locations={};
  for(const dataset of DATASETS) try { locations[dataset]=await datasetLocation(bigquery,project,dataset,{fallback:'EU'}); }
  catch(error) { throw queryFailure(`dataset_location:${dataset}`,error); }
  const commonParams={...bigQueryDateParameters({start_date:start,end_date:end}),currency};
  const commonTypes={start_date:'DATE',end_date:'DATE',currency:'STRING'};
  const schemaJobs=Object.fromEntries(DATASETS.map(dataset=>[dataset,{query:schemaEvidenceQuery(project,dataset),location:locations[dataset],maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,labels:{component:'annual_location_incident',operation:'schema_evidence'}}]));
  const metadataJobs={};
  for(const dataset of DATASETS) for(const [name,query] of Object.entries(metadataEvidenceQueries(project,dataset))) metadataJobs[name]={query,location:locations[dataset],maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,labels:{component:'annual_location_incident',operation:name}};
  const evidenceJobs={};
  for(const [name,query] of Object.entries(incidentQueries(project))){
    const disputed=name==='disputed_location';
    const examples=name==='component_examples';
    evidenceJobs[name]={query,params:disputed?{...commonParams,disputed_location:disputedLocation}:examples?{...commonParams,material_difference:0.005,example_limit:5}:commonParams,types:disputed?{...commonTypes,disputed_location:'STRING'}:examples?{...commonTypes,material_difference:'NUMERIC',example_limit:'INT64'}:commonTypes,location:locations.finance,maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,labels:{component:'annual_location_incident',operation:name}};
  }
  const shopifyJobs={};
  for(const [name,query] of Object.entries(shopifyEvidenceQueries(project))) {
    const source=name==='disputed_shopify_source';
    const freshness=name==='shopify_collection_freshness';
    shopifyJobs[name]={query,params:source?{disputed_transaction:disputedTransaction}:freshness?{shopify_reported_through:bigQueryDateParameters({shopify_reported_through:shopifyReportedThrough}).shopify_reported_through,end_date:commonParams.end_date}:{start_date:commonParams.start_date,end_date:commonParams.end_date},types:source?{disputed_transaction:'STRING'}:freshness?{shopify_reported_through:'DATE',end_date:'DATE'}:{start_date:'DATE',end_date:'DATE'},location:locations.shopify_data,maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,labels:{component:'annual_location_incident',operation:name}};
  }
  const annualJob={query:annualLocationFinanceQuery(project),params:commonParams,types:commonTypes,location:locations.finance,maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,labels:{component:'annual_location_incident',operation:'oracle_exact_path'}};

  // Preflight the complete statement set before the first diagnostic query read.
  for(const [dataset,options] of Object.entries(schemaJobs)) await dryRun(bigquery,`schema_evidence:${dataset}`,options);
  for(const [name,options] of Object.entries(metadataJobs)) await dryRun(bigquery,name,options);
  for(const [name,options] of Object.entries(evidenceJobs)) await dryRun(bigquery,name,options);
  for(const [name,options] of Object.entries(shopifyJobs)) await dryRun(bigquery,name,options);
  await dryRun(bigquery,'oracle_exact_path',annualJob);

  const schemas={};
  for(const [dataset,options] of Object.entries(schemaJobs)) [schemas[dataset]]=await read(bigquery,`schema_evidence:${dataset}`,options);
  const metadata={};
  for(const [name,options] of Object.entries(metadataJobs)) [metadata[name]]=await read(bigquery,name,options);
  const evidence={};
  for(const [name,options] of Object.entries(evidenceJobs)) [evidence[name]]=await read(bigquery,name,options);
  for(const [name,options] of Object.entries(shopifyJobs)) [evidence[name]]=await read(bigquery,name,options);
  const allJobs={...schemaJobs,...metadataJobs,...evidenceJobs,...shopifyJobs,oracle_exact_path:annualJob};
  const statement_manifest=Object.fromEntries(Object.entries(allJobs).map(([name,options])=>[name,{sql:options.query,typed_bindings:Object.fromEntries(Object.entries(options.params||{}).map(([key,value])=>{const described=describeDateParameter(value,options.types?.[key]||null);return [key,{type:options.types?.[key]||null,value:described.date_value??value}]})),dataset_location:options.location,maximum_bytes_billed:options.maximumBytesBilled}]));
  return {diagnostic:'annual_location_finance_incident',read_only:true,pii_free:true,bounded_transaction_ids:20,period:{requested_start:start,requested_end:end,observation_end:INCIDENT_END,shopify_reported_evidence_through:shopifyReportedThrough},filters:{currency,disputed_location:disputedLocation,disputed_transaction:disputedTransaction},bindings:{start_date:describeDateParameter(commonParams.start_date),end_date:describeDateParameter(commonParams.end_date)},maximum_bytes_billed:ANNUAL_LOCATION_MAX_BYTES,dataset_locations:locations,statement_manifest,source_schema_evidence:schemas,source_storage_metadata:metadata,retirement_status:{square:{operationally_retired:true,confirmed_operational_end:null,status:'end_date_unconfirmed',warning:'Latest transaction date is evidence coverage, not a governed operational end date. Do not restart Square collection.'},woocommerce:{operationally_retired_or_migrated:true,confirmed_operational_end:null,status:'end_dates_unconfirmed',refund_policy:'Post-migration refunds remain visible on their recorded refund dates.'}},limitations:{fulfilment_inventory_location:'Not present in the governed finance projection; no inventory selector is used or substituted.',source_report_validation:'Source-native BigQuery rows are reconciliation evidence, not an independently run provider report or accountant acceptance.',non_shopify_native_reconciliation:'Schemas, ledger populations, definitions and storage timestamps are exposed. Exact non-Shopify native joins require a governed source-to-ledger identity contract; no speculative join is made.'},evidence};
}

async function main(){
  const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';
  const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'null');
  if(!credentials)throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  const args=Object.fromEntries(process.argv.slice(2).map(value=>value.replace(/^--/,'').split('=')));
  console.log(JSON.stringify(await diagnose({bigquery:new BigQuery({projectId:project,credentials}),project,start:args.start||INCIDENT_START,end:args.end||INCIDENT_END,currency:args.currency||null,disputedLocation:args.location||'Online Ready to Ship'}),null,2));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(JSON.stringify({error:error.message,stage:error.stage||'startup',cause_code:error.cause_code||error.code||error.name||'ERROR',...Object.fromEntries([['reason',error.reason],['message',error.bigquery_message],['location',error.location]].filter(([,value])=>value))}));process.exitCode=1;});
