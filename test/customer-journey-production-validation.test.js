import test from 'node:test';
import assert from 'node:assert/strict';
import { customerJourneyValidationQueries, validateCustomerJourneyProduction } from '../diagnostics/customer-journey-production-validation.js';

test('journey production join-path diagnostic is read-only, bounded, aggregate-only and parent-product based',()=>{
  const queries=customerJourneyValidationQueries('demo');
  const sql=queries.product_join_path;
  assert.doesNotMatch(Object.values(queries).join('\n'),/\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER)\b/i);
  assert.match(sql,/source_lines/);
  assert.match(sql,/catalogue_matched_products/);
  assert.match(sql,/actively_classified_products/);
  assert.match(sql,/null_or_blank_source_product_lines/);
  assert.match(sql,/LIMIT 3/);
  assert.match(sql,/ProductVariant.*variant_gid_rejected/);
  assert.doesNotMatch(sql,/customer_id|email|phone|address/i);
  assert.match(sql,/source_units/);
  assert.match(sql,/post_join_units/);
  assert.match(sql,/source_sales/);
  assert.match(sql,/post_join_sales/);
});

test('acceptance uses normalized Shopify coverage rather than another source row',async()=>{
  const calls=[];
  const bigquery={query:async options=>{
    calls.push(options);
    switch(options.labels.operation){
      case 'classification_table': return [[{table_count:1}]];
      case 'classification': return [[{source:'woo_ww',collaboration_products:0},{source:'shopify',collaboration_products:21}]];
      case 'analyze_customer_journey': return [[{product:'Normal Ring',cohort_customers:2,cohort_returning_customers:1,product_returning_customers:1,repeat_rate_percentage:50,returning_cohort_penetration_percentage:100}]];
      default:return [[]];
    }
  }};
  const result=await validateCustomerJourneyProduction({bigquery,project:'demo',start_date:'2024-01-01',end_date:'2024-12-31'});
  assert.equal(result.read_only,true);
  assert.equal(result.aggregate_only,true);
  assert.equal(result.pii_free,true);
  assert.equal(result.evidence.journey_acceptance.cohort.customers,2);
  assert.ok(calls.some(call=>call.labels.operation==='product_join_path'));
});
