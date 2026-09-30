#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql} from '../shopify/admin-client.js';
import {createPageviewsPerSessionService,EXACT_PAGEVIEWS_ARGS,PAGEVIEWS_MAX_BYTES} from '../oracle/pageviews-per-session.js';

function normalize(tableData){const columns=tableData?.columns||[];return (tableData?.rows||[]).map(row=>Object.fromEntries(columns.map((column,index)=>[column.name,Array.isArray(row)?row[index]:row?.[column.name]])));}
export async function createProductionHelper({env=process.env,fetchImpl=fetch,BigQueryClass}={}){
  const {bigquery,project}=createBigQueryClient(env,BigQueryClass),config=loadShopifyConfig(env),token=await getShopifyAccessToken(config,fetchImpl),graphql=createShopifyGraphql({shop:config.shop,token,fetchImpl});
  const runShopifyql=async(query)=>{const data=await graphql(`query OraclePageviews($query: String!) { shopifyqlQuery(query: $query) { tableData { columns { name dataType } rows } parseErrors } }`,{query});const response=data?.shopifyqlQuery;if(response?.parseErrors?.length)throw Object.assign(new Error(`ShopifyQL parse error: ${response.parseErrors.map(x=>typeof x==='string'?x:x.message).join('; ')}`),{code:'SHOPIFYQL_PARSE_ERROR'});if(!response?.tableData)throw new Error('ShopifyQL returned no table data');return normalize(response.tableData);};
  const getShopTimezone=async()=>{const data=await graphql('{ shop { ianaTimezone } }');if(!data?.shop?.ianaTimezone)throw new Error('Shopify timezone unavailable');return data.shop.ianaTimezone;};
  return {service:createPageviewsPerSessionService({bigquery,project,runShopifyql,getShopTimezone}),project};
}
export async function diagnose(dependencies={}){const {service,project}=await createProductionHelper(dependencies);const evidence=await service(EXACT_PAGEVIEWS_ARGS);return{diagnostic:'oracle_pageviews_per_session',read_only:true,status:'SUCCEEDED',project,bigquery:{dataset:'ga4',location:'EU',typed_parameters:{start_date:'DATE',end_date:'DATE'},maximum_bytes_billed:PAGEVIEWS_MAX_BYTES},shopify:{authenticated:true,bounded:true,human_sessions:true,pagination:evidence.shopify_native.pagination,reporting_timezone:evidence.shopify_native.reporting_timezone},evidence};}
async function main(){try{process.stdout.write(`${JSON.stringify(await diagnose(),null,2)}\n`);}catch(error){process.stdout.write(`${JSON.stringify({diagnostic:'oracle_pageviews_per_session',read_only:true,status:'FAILED',failure:{classification:error.code||'RETRIEVAL_FAILED',message:String(error.message).slice(0,240)}},null,2)}\n`);process.exitCode=1;}}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main();
