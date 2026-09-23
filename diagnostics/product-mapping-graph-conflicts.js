#!/usr/bin/env node
/** Read-only evidence paths for existing write-time Product Mapping conflicts. */
import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { createProductMappingService } from '../oracle/product-mapping.js';

export async function diagnoseProductMappingGraphConflicts({bigquery,project,productIds=[]}) {
  if(!Array.isArray(productIds)||productIds.length<1||productIds.length>4||productIds.some(id=>!/^[A-Za-z0-9_:/.-]{1,100}$/.test(String(id))))throw new Error('one to four bounded product ids are required');
  return createProductMappingService({bigquery,project}).diagnoseExistingConflicts(productIds);
}

async function main(){
  const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data',productIds=process.argv.slice(2);
  const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
  console.log(JSON.stringify(await diagnoseProductMappingGraphConflicts({bigquery:new BigQuery({projectId:project,credentials}),project,productIds}),null,2));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({diagnostic:'product-mapping-graph-conflicts',read_only:true,error:error.message}));process.exitCode=1});
