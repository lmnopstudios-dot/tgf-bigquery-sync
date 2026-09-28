#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createShopifyGraphql, getShopifyAccessToken, loadShopifyConfig, missingShopifyConfig } from '../shopify/admin-client.js';
import { decode, pagedQuery } from '../shopify/conversion-backfill.js';
import { duplicateDiagnostics } from '../shopify/conversion-analytics.js';

export const PROBE_RANGE=Object.freeze({startDate:'2026-09-03',endDate:'2026-09-09'});
const GRAPHQL=`query ConversionDuplicateProbe($query:String!){shopifyqlQuery(query:$query){tableData{columns{name} rows} parseErrors}}`;

export async function runProbe({query,timezone,maxSources=40}) {
  if(!timezone)throw new Error('SHOPIFY_REPORTING_TIMEZONE is required');
  const collections=[];
  for(const withSource of [false,true]){
    const data=await pagedQuery({chunk:PROBE_RANGE,query,withSource});
    const rows=decode(data);
    collections.push({grain:withSource?'device_source':'device',rows:rows.length,pagination:data.pagination,grouping_columns:withSource?['day','session_device_type','referrer_source']:['day','session_device_type'],duplicate_identities:duplicateDiagnostics(rows,{withSource,maxSourcesPerDeviceDay:maxSources,timezone})});
  }
  return {diagnostic:'shopify_conversion_duplicate_probe',read_only:true,range:{start:'2026-09-03',end:'2026-09-09'},measurement_era_marker:{date:'2026-09-01',expected:'from_2026_09_session_measurement_change'},collections,safety:{shopifyql_reads_only:true,raw_referrers_logged:false,customer_data_logged:false,credentials_logged:false}};
}

async function main(){const missing=missingShopifyConfig(process.env);if(missing.length)throw new Error(`Missing configuration: ${missing.join(', ')}`);const timezone=process.env.SHOPIFY_REPORTING_TIMEZONE;if(!timezone)throw new Error('Missing configuration: SHOPIFY_REPORTING_TIMEZONE');const config=loadShopifyConfig(process.env),token=await getShopifyAccessToken(config),graphql=createShopifyGraphql({...config,token});const query=async statement=>{const result=(await graphql(GRAPHQL,{query:statement}))?.shopifyqlQuery;if(result?.parseErrors?.length)throw new Error(`ShopifyQL parse error: ${result.parseErrors.join('; ')}`);if(!result?.tableData)throw new Error('ShopifyQL returned no table data');return result.tableData;};process.stdout.write(`${JSON.stringify(await runProbe({query,timezone}),null,2)}\n`);}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(error=>{console.error(String(error.message).slice(0,500));process.exitCode=1;});
