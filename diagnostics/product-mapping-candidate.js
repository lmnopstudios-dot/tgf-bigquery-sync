#!/usr/bin/env node
/** Read-only explanation of the graph-safety result for exactly one candidate. */
import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { createProductMappingService } from '../oracle/product-mapping.js';

export async function diagnoseProductMappingCandidate({bigquery,project,candidateId,selectedRef=null}) {
  if(!/^[a-f0-9]{24}$/i.test(String(candidateId||'')))throw new Error('a 24-character candidate id is required');
  return createProductMappingService({bigquery,project}).diagnoseCandidate(candidateId,selectedRef);
}

export function parseCandidateDiagnosticSpec(value) {
  const [candidateId,selectedRef]=String(value||'').split('=',2);
  return {candidateId,selectedRef:selectedRef||null};
}

async function main(){
  const {candidateId,selectedRef}=parseCandidateDiagnosticSpec(process.argv[2]);
  const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';
  const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
  console.log(JSON.stringify(await diagnoseProductMappingCandidate({bigquery:new BigQuery({projectId:project,credentials}),project,candidateId,selectedRef:selectedRef||null}),null,2));
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{console.error(JSON.stringify({diagnostic:'product-mapping-candidate',read_only:true,error:error.message}));process.exitCode=1});
