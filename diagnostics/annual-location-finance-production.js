import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { bigQueryDateParameters, describeDateParameter } from '../bigquery/date-parameters.js';
import { ANNUAL_LOCATION_MAX_BYTES, annualLocationFinanceQuery } from '../oracle/annual-location-finance.js';

export const INCIDENT_START='2022-01-01';
export const INCIDENT_END='2026-09-30';
const DATASETS=['finance','shopify_data','woocommerce_uk','woocommerce_us','square_data'];

export function incidentQueries(project) {
  const table=`\`${project}.finance.accountant_transactions\``;
  const filter=`date BETWEEN @start_date AND @end_date AND (@currency IS NULL OR UPPER(currency)=UPPER(@currency))`;
  return {
    read_path_comparison:`WITH base AS (SELECT * FROM ${table} WHERE ${filter})
      SELECT 'annual_overall' read_path,EXTRACT(YEAR FROM date) year,currency,NULL dimension,SUM(gross) net_amount_including_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) observed_net_ex_tax,COUNT(*) records FROM base GROUP BY year,currency
      UNION ALL SELECT 'annual_location',EXTRACT(YEAR FROM date),currency,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated'),SUM(gross),SUM(tax),SUM(net_ex_tax),COUNT(*) FROM base GROUP BY year,currency,dimension
      UNION ALL SELECT 'online_channel',EXTRACT(YEAR FROM date),currency,COALESCE(NULLIF(TRIM(source),''),'Unknown / unallocated'),SUM(gross),SUM(tax),SUM(net_ex_tax),COUNT(*) FROM base WHERE LOWER(channel)='online' GROUP BY year,currency,dimension
      ORDER BY year,currency,read_path,dimension`,
    location_reconciliation:`WITH base AS (SELECT EXTRACT(YEAR FROM date) year,currency,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') location,gross,tax,net_ex_tax FROM ${table} WHERE ${filter}), locations AS (SELECT year,currency,location,SUM(gross) gross,SUM(tax) tax,SUM(net_ex_tax) ex_tax,COUNTIF(tax IS NULL) missing_tax FROM base GROUP BY 1,2,3), overall AS (SELECT year,currency,SUM(gross) gross,SUM(tax) tax,SUM(net_ex_tax) ex_tax,COUNTIF(tax IS NULL) missing_tax FROM base GROUP BY 1,2) SELECT o.*,COUNT(l.location) location_rows,SUM(l.gross)-o.gross gross_difference,IF(o.missing_tax=0 AND SUM(l.missing_tax)=0,SUM(l.tax)-o.tax,NULL) tax_difference,IF(COUNTIF(l.ex_tax IS NULL)=0,SUM(l.ex_tax)-o.ex_tax,NULL) ex_tax_difference FROM overall o JOIN locations l USING(year,currency) GROUP BY ALL ORDER BY year,currency`,
    online_difference:`WITH base AS (SELECT * FROM ${table} WHERE ${filter} AND EXTRACT(YEAR FROM date)=2026), by_channel AS (SELECT currency,SUM(gross) amount FROM base WHERE LOWER(channel)='online' GROUP BY currency), by_location AS (SELECT currency,SUM(gross) amount FROM base WHERE LOWER(COALESCE(location,''))='online' GROUP BY currency) SELECT COALESCE(c.currency,l.currency) currency,c.amount online_channel_amount,l.amount online_location_amount,l.amount-c.amount location_minus_channel FROM by_channel c FULL JOIN by_location l USING(currency)`,
    online_cross_classification:`SELECT source,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') sales_location,currency,COUNT(*) records,SUM(gross) amount,SUM(tax) observed_recorded_tax,COUNTIF(tax IS NULL) missing_tax_records FROM ${table} WHERE ${filter} AND EXTRACT(YEAR FROM date)=2026 AND (LOWER(COALESCE(channel,''))='online' OR LOWER(COALESCE(location,''))='online') GROUP BY 1,2,3,4 ORDER BY ABS(amount) DESC LIMIT 100`,
    rounding:`SELECT EXTRACT(YEAR FROM date) year,currency,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') channel,COUNT(*) records,SUM(gross) net_amount_including_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) stored_net_ex_tax,SUM(gross)-SUM(tax) derived_gross_less_tax,SUM(net_ex_tax)-(SUM(gross)-SUM(tax)) stored_component_difference,COUNTIF(tax IS NULL) missing_tax_records,COUNTIF(net_ex_tax IS NULL) missing_ex_tax_records FROM ${table} WHERE ${filter} GROUP BY 1,2,3 ORDER BY year,currency,channel`,
    disputed_location:`SELECT source,COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') recorded_sales_location,currency,transaction_type,COUNT(*) records,SUM(gross) amount_including_recorded_tax,SUM(tax) observed_recorded_tax,SUM(net_ex_tax) observed_ex_tax,COUNTIF(tax IS NULL) missing_tax_records,ARRAY_AGG(CAST(transaction_id AS STRING) IGNORE NULLS ORDER BY date LIMIT 20) bounded_transaction_ids,'finance.accountant_transactions.location' mapping_provenance FROM ${table} WHERE ${filter} AND EXTRACT(YEAR FROM date)=2025 AND LOWER(COALESCE(location,''))=LOWER(@disputed_location) GROUP BY 1,2,3,4,5 ORDER BY ABS(amount_including_recorded_tax) DESC`,
    source_tax_coverage:`SELECT source,currency,MIN(date) earliest_evidence,MAX(date) latest_evidence,COUNT(*) records,COUNTIF(tax IS NOT NULL) recorded_tax_records,COUNTIF(tax IS NULL) missing_tax_records,COUNTIF(tax=0) observed_zero_tax_records,SUM(tax) observed_recorded_tax FROM ${table} WHERE ${filter} GROUP BY source,currency ORDER BY source,currency`
  };
}

export async function diagnose({bigquery,project,start=INCIDENT_START,end=INCIDENT_END,currency=null,disputedLocation='Online Ready to Ship'}) {
  const locations={};
  for(const dataset of DATASETS) locations[dataset]=await datasetLocation(bigquery,project,dataset,{fallback:'EU'});
  const schemas={};
  for(const dataset of DATASETS){
    const [rows]=await bigquery.query({query:`SELECT table_name,column_name,data_type FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE REGEXP_CONTAINS(LOWER(column_name),r'(tax|location|shipping|currency|refund)') ORDER BY table_name,ordinal_position LIMIT 1000`,location:locations[dataset],maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,labels:{component:'annual_location_incident',operation:'schema_evidence'}});
    schemas[dataset]=rows;
  }
  const commonParams={...bigQueryDateParameters({start_date:start,end_date:end}),currency};
  const commonTypes={start_date:'DATE',end_date:'DATE',currency:'STRING'};
  const evidence={};
  for(const [name,query] of Object.entries(incidentQueries(project))){
    const disputed=name==='disputed_location';
    const options={query,params:disputed?{...commonParams,disputed_location:disputedLocation}:commonParams,types:disputed?{...commonTypes,disputed_location:'STRING'}:commonTypes,location:locations.finance,maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,labels:{component:'annual_location_incident',operation:name}};
    await bigquery.createQueryJob({...options,dryRun:true});
    [evidence[name]]=await bigquery.query(options);
  }
  const annualQuery=annualLocationFinanceQuery(project);
  await bigquery.createQueryJob({query:annualQuery,params:commonParams,types:commonTypes,location:locations.finance,maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,useLegacySql:false,dryRun:true,labels:{component:'annual_location_incident',operation:'oracle_exact_path'}});
  return {diagnostic:'annual_location_finance_incident',read_only:true,pii_free:true,bounded_transaction_ids:20,period:{start,end,observation_end:INCIDENT_END},filters:{currency,disputed_location:disputedLocation},bindings:{start_date:describeDateParameter(commonParams.start_date),end_date:describeDateParameter(commonParams.end_date)},maximum_bytes_billed:ANNUAL_LOCATION_MAX_BYTES,dataset_locations:locations,source_schema_evidence:schemas,limitations:{fulfilment_inventory_location:'Not present in the governed finance projection; no inventory selector is used or substituted.',source_report_validation:'Run matching source-native reports after this diagnostic; this command does not establish accountant acceptance.'},evidence};
}

async function main(){
  const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';
  const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'null');
  if(!credentials)throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  const args=Object.fromEntries(process.argv.slice(2).map(value=>value.replace(/^--/,'').split('=')));
  console.log(JSON.stringify(await diagnose({bigquery:new BigQuery({projectId:project,credentials}),project,start:args.start||INCIDENT_START,end:args.end||INCIDENT_END,currency:args.currency||null,disputedLocation:args.location||'Online Ready to Ship'}),null,2));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(error);process.exitCode=1;});
