import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonicalFinanceQuery, canonicalFinanceCtes, createCanonicalFinanceService, FINANCE_SEMANTICS, MATRIXIFY_APP_ID } from '../finance/canonical.js';
import { createEcommerceReportV2 } from '../oracle/ecommerce-report-v2.js';
import { createOracleFinanceService } from '../oracle/finance.js';
import { validate, validationQueries } from '../diagnostics/canonical-finance-production-validation.js';

test('canonical Shopify sales and refunds use presentment money, refund event date, event identity and negative sign',()=>{
  const sql=canonicalFinanceCtes('p');
  assert.match(sql,/original_total_presentment/);
  assert.match(sql,/original_tax_presentment/);
  assert.match(sql,/DATE\(r\.refund_created_at\)/);
  assert.match(sql,/-ABS\(CAST\(r\.refund_total_presentment/);
  assert.match(sql,/UPPER\(COALESCE\(r\.presentment_currency,f\.presentment_currency\)\)/);
  assert.match(sql,/r\.refund_id/);
  assert.doesNotMatch(sql,/DATE\(f\.created_at\),'refund'/);
  assert.match(FINANCE_SEMANTICS.refund_date,/refund_created_at/);
});

test('partial and multiple refunds remain one row per refund event without component double counting',()=>{
  const sql=canonicalFinanceCtes('p');
  assert.match(sql,/shopify_data\.order_refunds/);
  assert.match(sql,/refund_total_presentment/);
  assert.doesNotMatch(sql,/refund_line_subtotal_presentment\s*\+/);
  assert.doesNotMatch(sql,/total_refunded_presentment/);
});

test('Matrixify is excluded, Online and POS are distinct, and residual Woo has no migration cutoff',()=>{
  const sql=canonicalFinanceCtes('p');
  assert.match(sql,/source_app_id!=@matrixify_app_id/);
  assert.match(sql,/retail_location_id IS NULL,'Online','POS'/);
  assert.match(sql,/legacy_non_shopify/);
  assert.doesNotMatch(sql,/2025-11-20/);
  assert.equal(MATRIXIFY_APP_ID,'gid://shopify/App/1758145');
});

test('aggregation supports daily weekly monthly grains, filters, counts and currency separation',()=>{
  for(const grain of ['day','week','month']){
    const sql=buildCanonicalFinanceQuery('p',{grain,dimensions:['currency','source','channel','transaction_type']});
    assert.match(sql,/@currency/);assert.match(sql,/COUNT\(DISTINCT IF\(transaction_type='refund',order_id,NULL\)\)/);
  }
  assert.match(buildCanonicalFinanceQuery('p',{grain:'week'}),/%G-W%V/);
  assert.throws(()=>buildCanonicalFinanceQuery('p',{grain:'quarter'}),/grain/);
});

test('canonical service uses bounded parameterized read-only SQL',async()=>{
  const calls=[];const service=createCanonicalFinanceService({project:'p',bigquery:{query:async o=>{calls.push(o);return [[{period:'2026-01',amount:-10}]];}}});
  const rows=await service({start_date:'2026-01-01',end_date:'2026-01-31',grain:'month',currency:'USD',transaction_type:'refund'});
  assert.equal(rows[0].amount,-10);assert.equal(calls[0].params.currency,'USD');assert.match(calls[0].query,/DATE\(@start_date\)/);assert.match(calls[0].query,/^WITH/);
});

test('Report v2 consumes the shared canonical finance service contract',async()=>{
  const calls=[];const bigquery={query:async o=>{calls.push(o);return [[{period:'2026-01-01',currency:'USD',channel:'Online',source:'Shopify',transaction_type:'refund',transaction_count:1,amount:-12}]];}};
  const report=await createEcommerceReportV2({bigquery,project:'p',knowledgeService:{}})('sales',{start_date:'2026-01-01',end_date:'2026-01-31'});
  assert.equal(report.rows[0].refunds,-12);assert.match(calls[0].query,/native_shopify_refunds/);assert.match(calls[0].query,/order_refunds/);
});

test('Oracle and shared finance return the same aggregate with only documented sign presentation added',async()=>{
  const fixture=[{period:'2026-01',currency:'USD',source:'Shopify',channel:'Online',transaction_type:'refund',transaction_count:2,refund_events:2,distinct_refunded_orders:1,amount:-15,tax:-2,net_ex_tax:-13}];
  const bigquery={query:async()=>[fixture]};
  const shared=await createCanonicalFinanceService({bigquery,project:'p'})({start_date:'2026-01-01',end_date:'2026-01-31',grain:'month',currency:'USD',transaction_type:'refund',dimensions:['source']});
  const oracle=await createOracleFinanceService({bigquery,project:'p'}).getRefunds({start_date:'2026-01-01',end_date:'2026-01-31',currency:'USD',group_by:'month_source'});
  assert.equal(oracle[0].refunds_gross,shared[0].amount);assert.equal(oracle[0].refunded_amount,Math.abs(shared[0].amount));assert.equal(oracle[0].refund_count,shared[0].refund_events);
});

test('production validator is SELECT-only, aggregate-only, PII-free and reconciles same semantic',async()=>{
  const queries=validationQueries('p');
  for(const query of Object.values(queries)){assert.match(query,/^\s*(SELECT|WITH)/);assert.doesNotMatch(query,/email|phone|first_name|last_name/i);}
  assert.match(queries.reconciliation,/difference/);assert.match(queries.historical_oracle_usd,/currency='USD'/);assert.match(queries.native_shopify_refunds,/refund_created_at/);
  const calls=[];const result=await validate({project:'p',bigquery:{query:async o=>{calls.push(o);return calls.length===1?[[{cutoff:'2026-09-22'}]]:[[]];}}});
  assert.deepEqual(result.contract,{read_only:true,aggregate_only:true,pii_free:true,canonical_sign:'negative',display_sign:'positive_magnitude',refund_count:'persisted refund events',refund_date:'refund_created_at'});
  assert.equal(calls.length,5);
});
