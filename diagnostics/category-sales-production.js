#!/usr/bin/env node
/** Read-only production reproduction for Oracle's governed category-sales query. */
import crypto from 'node:crypto';
import {BigQuery} from '@google-cloud/bigquery';
import {fileURLToPath} from 'node:url';
import {assertCategorySalesReconciles,categorySalesQueryOptions} from '../oracle/category-sales.js';

export const ORACLE_CATEGORY_SALES_INPUT=Object.freeze({start_date:'2026-01-01',end_date:'2026-09-28'});

const clean=value=>String(value||'BigQuery query failed')
  .replace(/`[^`]*`/g,'[identifier]')
  .replace(/\b(?:ya29\.|AIza|-----BEGIN)[^\s]*/gi,'[credential]')
  .replace(/\s+/g,' ').trim().slice(0,240);

export function sanitizeBigQueryError(error){
  const detail=Array.isArray(error?.errors)&&error.errors.length?error.errors[0]:{};
  return {reason:String(detail.reason||error?.reason||'unknown').slice(0,80),code:Number(error?.code)||null,stage:String(detail.location||error?.stage||'query').slice(0,80),message:clean(detail.message||error?.message||error)};
}

export async function diagnoseCategorySales({bigquery,project}){
  const options=categorySalesQueryOptions(project,ORACLE_CATEGORY_SALES_INPUT);
  const trace={tool:'get_governed_category_sales',period:{...ORACLE_CATEGORY_SALES_INPUT},query_sha256:crypto.createHash('sha256').update(options.query).digest('hex'),use_legacy_sql:false,maximum_bytes_billed:options.maximumBytesBilled,read_only:true};
  try{
    const [rows]=await bigquery.query(options);assertCategorySalesReconciles(rows);
    const groups=new Map();for(const row of rows){const key=[row.source_platform,row.source_store,row.sales_channel,row.currency,row.monetary_unit].join(':');if(!groups.has(key))groups.set(key,{source_platform:row.source_platform,source_store:row.source_store,sales_channel:row.sales_channel,currency:row.currency,monetary_unit:row.monetary_unit,requested_end_date:row.requested_end_date,latest_synced_order_date:row.latest_synced_order_date,eligible_sales:row.eligible_sales,classified_lines:row.classified_lines,unclassified_lines:row.unclassified_lines,eligible_lines:row.eligible_lines,categories:{}});groups.get(key).categories[row.sales_category]={lines:row.line_items,units:row.units,sales:row.sales,combined_lines:row.combined_line_items,combined_units:row.combined_units,combined_sales:row.combined_sales}}
    return {ok:true,trace,reconciled:true,source_currency_channel_groups:[...groups.values()]};
  }catch(error){return {ok:false,error:sanitizeBigQueryError(error)};}
}

async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data',credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;const result=await diagnoseCategorySales({project,bigquery:new BigQuery({projectId:project,credentials})});console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1}
if(process.argv[1]===fileURLToPath(import.meta.url))main();
