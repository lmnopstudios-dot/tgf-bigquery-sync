import { BigQuery } from '@google-cloud/bigquery';
import { fileURLToPath } from 'node:url';
import { createProductMappingService } from '../oracle/product-mapping.js';
import { governanceDiagnostic } from '../oracle/governance-diagnostics.js';

/** Runs the route's default empty-search read path without schema setup or writes. */
export async function validateProductMappingReviewQueue({bigquery,project}) {
  const result=await createProductMappingService({bigquery,project}).validateReviewQueue();
  if(!result.coverage.reconciliation.reconciled||result.coverage.reconciliation.missing_products||result.coverage.reconciliation.overlap_products)throw new Error(`review queue reconciliation failed: ${JSON.stringify(result.coverage.reconciliation)}`);
  const square=result.coverage.by_source['square:square'];
  if(square.money_contract.amount_field!=='total_amount'||square.money_contract.currency_field!=='currency'||square.money_contract.monetary_unit!=='minor_unit')throw new Error('Square product impact must use the persisted retail_order_items Money amount/currency contract in minor units');
  return result;
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
