import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations,cohortExecutionPlan,cohortExecutionOptions} from '../oracle/cohort-execution.js';
import {CORRELATION_PARAMS,productCorrelationValidationSql,validateProductCorrelation} from '../diagnostics/oracle-second-purchase-correlation.js';
const retained=readFileSync(new URL('./fixtures/oracle-second-purchase-c9ac538f-result.sql',import.meta.url),'utf8');
const query=()=>customerJourneySql('fixture-project','retention_product_journeys',null,null,{dataset:'identity',snapshot:'synthetic',orderLinks:true},true);
test('c9ac538f retained statement has the reported cross-table product ARRAY correlation',()=>{
 assert.ok(retained.startsWith('CREATE TEMP TABLE cohort_result AS WITH'));
 assert.match(retained,/ARRAY\(SELECT AS STRUCT p\.\* EXCEPT\(entry_product_ref,window_days\),t\.returning_customers denominator_customers/);
 assert.match(retained,/FROM pj_product_ranks p WHERE p.entry_product_ref IS NOT DISTINCT FROM t.entry_product_ref AND p.window_days=t.window_days/);
 const old=cohortRelations(retained.slice(retained.indexOf('WITH ')));
 const current=cohortRelations(cohortExecutionPlan(query()).result);
 // Only product-array construction and final projection change. All upstream
 // calculations in the actual rejected terminal statement are byte-identical.
 for(const relation of old.relations){assert.equal(current.relations.find(r=>r.name===relation.name)?.body,relation.body,relation.name);}
});
test('shared final calculation joins unique denominators before ARRAY_AGG, retaining NULL overall and empty products',()=>{
 const plan=cohortExecutionPlan(query()),{relations,result}=cohortRelations(plan.result);
 const arrays=relations.find(r=>r.name==='pj_product_arrays').body;
 assert.match(arrays,/FROM pj_product_ranks p JOIN pj_totals t/);
 assert.match(arrays,/p.entry_product_ref IS NOT DISTINCT FROM t.entry_product_ref AND p.window_days=t.window_days/);
 assert.match(arrays,/100\*SAFE_DIVIDE\(p.customers,t.returning_customers\)/);
 assert.match(arrays,/p.product_rank<=IF\(t.entry_product_ref IS NULL,20,5\)/);
 assert.match(arrays,/GROUP BY p.entry_product_ref,p.window_days/);
 assert.match(arrays,/ORDER BY p.is_sizer,p.product_rank/);
 assert.doesNotMatch(arrays,/COUNT\(/); // Already distinct per customer/product upstream; never recount joined lines.
 assert.match(result,/IFNULL\(a.products,\[\]\) products/);
 assert.match(result,/LEFT JOIN pj_product_arrays a ON a.entry_product_ref IS NOT DISTINCT FROM t.entry_product_ref AND a.window_days=t.window_days/);
 assert.doesNotMatch(result,/FROM pj_product_ranks/);
 assert.equal(plan.stages.length,8);assert.ok(BigInt(cohortExecutionOptions(query(),45000).maximumBytesBilled)*10n<=20000000000n);
});
test('BigQuery regression exercises the real session-table terminal query using synthetic fixtures only',async()=>{
 const sql=productCorrelationValidationSql();
 assert.match(sql,/CREATE TEMP TABLE cohort_result AS WITH/);assert.match(sql,/_SESSION.cohort_retention_reporting_lines/);assert.match(sql,/_SESSION.cohort_pj_members/);
 assert.doesNotMatch(sql,/`|identity_order_links|metorik_|shopify_data|\b(?:INSERT|UPDATE|DELETE|MERGE)\b/);
 assert.match(productCorrelationValidationSql({legacy:true}),/FROM pj_product_ranks p WHERE/);
 assert.match(productCorrelationValidationSql({empty:true}),/FROM fixture_orders WHERE FALSE/);
 // Verify the diagnostic passes explicit US and typed nullable dates/filters,
 // and actually validates zero-population result rows rather than a dry-run flag.
 const rows=[0,90,180,360].map(window_days=>({entry_product_ref:null,entry_product:'Overall',entry_is_sizer:false,entry_rank:0,window_days,entry_customers:0,returning_customers:0,age_eligible_customers:0,age_repeat_customers:0,verified_customers:0,verified_repeat_customers:0,missing_line_customers:0,unknown_product_customers:0,observation_coverage_status:'unverified',products:[]}));
 let calls=0;
 const result=await validateProductCorrelation({empty:true,bigquery:{query:async options=>{calls++;assert.equal(options.location,'US');assert.deepEqual(options.params,CORRELATION_PARAMS);assert.equal(options.types.coverage_start,'DATE');assert.equal(options.maximumBytesBilled,'100000000');return [[{product_journeys:rows}]];}}});
 assert.equal(calls,1);assert.equal(result.verified,true);
});
test('collaboration generator does not acquire product-journey aggregation',()=>{
 const sql=customerJourneySql('fixture','retention_windows');assert.doesNotMatch(sql,/pj_product_arrays/);assert.match(sql,/retention_product_arrays/);
});
