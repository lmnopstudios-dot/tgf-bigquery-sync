import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { createProductMappingService } from '../oracle/product-mapping.js';
import { governanceDiagnostic } from '../oracle/governance-diagnostics.js';

/** Runs the route's default empty-search read path without schema setup or writes. */
export async function validateProductMappingReviewQueue({bigquery,project}) {
  return createProductMappingService({bigquery,project}).validateReviewQueue();
}

async function main(){
  const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';
  const credentials=process.env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
  console.log(JSON.stringify(await validateProductMappingReviewQueue({bigquery:new BigQuery({projectId:project,credentials}),project}),null,2));
}

if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(error=>{
  const diagnostic=governanceDiagnostic(error,{operation:'list_review_candidates'});delete diagnostic.internal_message;
  console.error(JSON.stringify({validator:'product-mapping-review-queue-production',read_only:true,...diagnostic}));
  process.exitCode=1;
});
