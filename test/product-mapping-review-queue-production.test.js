import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateProductMappingReviewQueue } from '../diagnostics/product-mapping-review-queue-production.js';

test('review queue production validator uses the empty-search read path and never writes',async()=>{
  const products=[
    {source_product_ref:'woo:ww:1',source_platform:'woo',source_store:'ww',source_product_id:'1',title:'Moon Skull Ring',sku:null,line_items:2,sales:10,mapping_status:'source_specific'},
    {source_product_ref:'shopify:shopify:2',source_platform:'shopify',source_store:'shopify',source_product_id:'2',title:'Moon Skull Ring',sku:null,line_items:3,sales:20,mapping_status:'source_specific'}
  ];
  const calls=[];const bigquery={query:async options=>{calls.push(options);if(options.labels?.operation==='load_products')return[products];return[[]]}};
  const result=await validateProductMappingReviewQueue({bigquery,project:'demo'});
  assert.equal(result.read_only,true);assert.equal(result.search_empty,true);assert.equal(result.stage,'complete');assert.equal(result.counts.products,2);assert.equal(result.counts.needs_review,1);assert.deepEqual(Object.keys(result.timing_ms).sort(),['candidate_generation','family_decisions','historical_grouping','mapping_decisions','products']);assert.equal(calls.length,3);
  const source=fs.readFileSync(new URL('../diagnostics/product-mapping-review-queue-production.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\.insert\(|INSERT\s+INTO|\.create\(|\.setMetadata\(/i);
});
