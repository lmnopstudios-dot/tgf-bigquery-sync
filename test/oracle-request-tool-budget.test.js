import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestToolBudget, toolCallSignature } from '../oracle/request-tool-budget.js';

const DANIELLE_PRODUCTS = [
  'Large Anatomical Heart Ring',
  'Small Anatomical Heart Ring',
  'Anatomical Heart Pendant'
];

test('Danielle evidence may cover the full product list without an arbitrary call ceiling', async () => {
  const budget = new RequestToolBudget({deadlineAt:Date.now()+10_000,synthesisReserveMs:100});
  const covered=[];
  for(const product of DANIELLE_PRODUCTS) {
    assert.equal(budget.admit().admitted,true);
    covered.push({product,stock_units:product.length,sales_units:1});
    budget.complete();
  }
  for(const evidenceType of ['catalogue','soho_stock','east_stock','la_stock','recent_sales','velocity']) {
    for(const product of DANIELLE_PRODUCTS) {
      assert.equal(budget.admit().admitted,true,`${evidenceType}: ${product}`);
      budget.complete();
    }
  }
  assert.deepEqual(covered.map(row=>row.product),DANIELLE_PRODUCTS);
  assert.equal(covered.every(row=>Number.isFinite(row.stock_units)&&Number.isFinite(row.sales_units)),true);
  assert.equal(budget.dispatched,21);
});

test('equivalent lookups deduplicate while legitimate product lookups stay distinct',()=>{
  const first=toolCallSignature('get_shopify_inventory_by_location',{query:'  title:"Heart Ring"  ',location:'Soho',limit:10});
  const reordered=toolCallSignature('get_shopify_inventory_by_location',{limit:10,location:'Soho',query:'title:"Heart Ring"'});
  const differentProduct=toolCallSignature('get_shopify_inventory_by_location',{query:'title:"Heart Pendant"',location:'Soho',limit:10});
  assert.equal(first,reordered);
  assert.notEqual(first,differentProduct);
});

test('deadline reserve, bounded concurrency and cancellation stop new work',()=>{
  let now=1_000;
  const controller=new AbortController();
  const budget=new RequestToolBudget({deadlineAt:2_000,signal:controller.signal,maxConcurrency:2,synthesisReserveMs:200,now:()=>now});
  assert.equal(budget.admit().admitted,true);
  assert.equal(budget.admit().admitted,true);
  assert.deepEqual(budget.admit(),{admitted:false,code:'REQUEST_CONCURRENCY_LIMIT'});
  budget.complete();budget.complete();
  now=1_800;
  assert.deepEqual(budget.admit(),{admitted:false,code:'SYNTHESIS_TIME_RESERVED'});
  controller.abort();now=1_100;
  assert.deepEqual(budget.admit(),{admitted:false,code:'REQUEST_CANCELLED'});
  assert.equal(budget.canContinueModel(),false);
});

test('inventory implementation batches variant-level Shopify work with two workers',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../server.js',import.meta.url),'utf8'));
  assert.match(source,/mapWithConcurrency\(variants, 2/);
  assert.match(source,/Multiple named products should be batched|combine exact title terms with OR/);
});
