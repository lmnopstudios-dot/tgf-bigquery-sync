import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceSummary, synthesisFailureKind } from '../oracle/evidence-summary.js';

test('failed final synthesis returns readable validated figures without raw tool names',()=>{
  const answer=evidenceSummary([{name:'get_shopify_product_performance',result:{start_date:'2025-09-25',end_date:'2026-09-25',products:[
    {product_title:'Vintage Reissue 70s UFO tshirt',net_items_sold:18,orders:16,net_sales:720},
    {product_title:'TGF Cotton Tote Bag',net_items_sold:31,orders:29,net_sales:465},
    {product_title:'TGF Socks',net_items_sold:52,orders:45,net_sales:780}
  ]}}],{unavailable:['get_shopify_customer_product_behavior']});
  for(const figure of ['18','720','31','465','52','780'])assert.match(answer,new RegExp(`\\b${figure}\\b`));
  assert.match(answer,/Partial result — final synthesis did not complete/);
  assert.match(answer,/No evidence-backed recommendation is claimed/);
  assert.match(answer,/Retry:/);
  assert.doesNotMatch(answer,/get_shopify_/);
});

test('synthesis diagnostics distinguish deadline, provider and oversized tool results',()=>{
  assert.equal(synthesisFailureKind(Object.assign(new Error(),{name:'TimeoutError'}),{deadlineAt:Date.now()+1000}),'deadline');
  assert.equal(synthesisFailureKind(new Error(),{deadlineAt:Date.now()+1000}),'provider_failure');
  assert.equal(synthesisFailureKind(Object.assign(new Error(),{status:413}),{deadlineAt:Date.now()+1000}),'tool_result_size');
});

test('conversion fallback preserves validated aggregates without inventing missing breakdowns',()=>{
  const answer=evidenceSummary([{name:'get_shopify_conversion_kpis',result:{start_date:'2025-11-16',end_date:'2025-12-15',metrics:{sessions:12500,orders:250,conversion_rate:0.02}}}],{unavailable:['pre-launch device conversion denominator','traffic-source conversion denominator']});
  assert.match(answer,/Sessions 12,500/);assert.match(answer,/Orders 250/);assert.match(answer,/Conversion Rate 0\.02/);
  assert.match(answer,/No conversion rate, device\/channel denominator, cross-platform equivalence/);
  assert.doesNotMatch(answer,/conversion rate 2%/i);
});
