import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductMappingService,buildProductChoicePreview,relationshipId} from '../oracle/product-mapping.js';

import {fixture} from './helpers/product-mapping-save-fixture.js';

test('eight family saves use one catalogue read and one atomic submission receipt while preserving per-row fresh family decisions',async()=>{
 const {state,service,request}=fixture();
 const result=await service.bulkReview({operation_id:'eight',decisions:Array.from({length:8},(_,i)=>request(i))},'Stuart');
 assert.equal(result.status,'complete');assert.equal(result.succeeded,8);assert.equal(state.families.length,8);
 assert.equal(state.calls.filter(q=>q.labels?.operation==='load_products').length,1);
 const submissions=state.calls.filter(q=>q.query.startsWith('MERGE')&&q.query.includes('product_mapping_operations')&&JSON.parse(q.params.payload).some(x=>x.status==='submitted'));
 assert.equal(submissions.length,1);assert.equal(JSON.parse(submissions[0].params.payload).length,8);
 assert.match(submissions[0].query,/FROM UNNEST\(JSON_QUERY_ARRAY\(@payload\)\) payload_row/);
 assert.match(submissions[0].query,/SAFE_CAST\(JSON_VALUE\(payload_row,'\$\.row_index'\) AS INT64\)/);
 assert.equal(state.familyReads,8);assert.equal(state.calls.filter(q=>q.query.startsWith('SELECT')&&q.query.includes('product_mapping_decisions')).length,0);
 assert.equal(state.calls.filter(q=>q.query.startsWith('SELECT')&&q.query.includes('product_mapping_review_outcomes')).length,0);
 assert.equal(state.calls.length,36); // Previous eight-family path submitted 66 query jobs.
 const catalogueCalls=state.calls.filter(q=>q.labels?.operation==='load_products').length;
 const replay=await service.bulkReview({operation_id:'eight',decisions:Array.from({length:8},(_,i)=>request(i))},'Stuart');
 assert.equal(replay.succeeded,8);assert.equal(state.families.length,8);assert.equal(state.calls.filter(q=>q.labels?.operation==='load_products').length,catalogueCalls);
 // Snapshot must not leak to the next operation.
 await service.bulkReview({operation_id:'next',decisions:[request(0)]},'Stuart');
 assert.equal(state.calls.filter(q=>q.labels?.operation==='load_products').length,catalogueCalls+1);
});

test('a family decision appearing between rows blocks only that row; prior successes survive',async()=>{
 const {state,service,request,sources,parents}=fixture({count:3,onFamilyRead:s=>{if(s.familyReads===2)s.families.push({decision_id:'external',event_id:'external',source_ref:'woo:usd:101',shopify_parent_ref:'shopify:shopify:901',status:'active',reviewed_at:new Date().toISOString()});}});
 const result=await service.bulkReview({operation_id:'fresh',decisions:[request(0),request(1),request(2)]},'Stuart');
 assert.deepEqual(result.results.map(x=>x.status),['saved','blocked','saved']);
 assert.equal(state.families.find(x=>x.source_ref===sources[1].source_product_ref).shopify_parent_ref,parents[1].source_product_ref);
 assert.equal(state.families.filter(x=>x.provenance==='oracle_product_mapping_bulk_review').length,2);
});

test('identity rows use the current graph after each save and never reload the batch catalogue for graph validation',async()=>{
 const {state,service,request}=fixture({count:3});
 const result=await service.bulkReview({operation_id:'graph',decisions:[request(0,'identity'),request(2,'identity'),request(1,'identity')]},'Stuart');
 assert.deepEqual(result.results.map(x=>x.status),['saved','blocked','saved']);
 assert.equal(state.mappings.length,2);assert.equal(state.families.length,0);
 assert.equal(state.calls.filter(q=>q.labels?.operation==='load_products').length,1);
});

test('stale preview tokens remain blocked against freshly read governance',async()=>{
 const {service,request,state,parents,sources}=fixture({count:1});
 const selectedRef=parents[0].source_product_ref,candidate={left_ref:sources[0].source_product_ref,right_ref:selectedRef,candidate_id:relationshipId(sources[0].source_product_ref,selectedRef)};
 const old=buildProductChoicePreview({products:state.products,candidate,selectedRef});
 state.families.push({source_ref:'woo:ww:other',shopify_parent_ref:selectedRef,status:'active',decision_id:'new-governance'});
 const result=await service.bulkReview({operation_id:'token',decisions:[{...request(0),preview_token:old.preview_token}]},'Stuart');
 assert.equal(result.blocked,1);assert.match(result.results[0].error,/stale preview/);assert.equal(state.families.length,1);
});

test('interrupted terminal receipts recover the original decision and replay cannot duplicate it',async()=>{
 const {state,service,request}=fixture({count:1});state.terminalFailures=2;
 const input={operation_id:'recover',decisions:[request(0)]};
 await assert.rejects(service.bulkReview(input,'Stuart'),/Terminal receipt unavailable/);
 assert.equal(state.families.length,1);assert.equal(state.operations.length,1);assert.equal(state.operations[0].status,'submitted');
 const recovered=await service.bulkReviewStatus('recover','Stuart');assert.equal(recovered.results[0].status,'already_applied');
 const replay=await service.bulkReview(input,'Stuart');assert.equal(replay.results[0].status,'already_applied');assert.equal(state.families.length,1);
});

test('submission receipt failure performs no catalogue read or governance write; outcomes read only outcome history',async()=>{
 const first=fixture({count:2});first.state.submissionFailure=true;
 await assert.rejects(first.service.bulkReview({operation_id:'no-receipt',decisions:[first.request(0),first.request(1)]},'Stuart'),/Submission receipt unavailable/);
 assert.equal(first.state.calls.filter(q=>q.labels?.operation==='load_products').length,0);assert.equal(first.state.families.length,0);
 const {state,service,request}=fixture({count:2});
 const result=await service.bulkReview({operation_id:'outcomes',decisions:[request(0,'no_equivalent'),request(1,'needs_investigation')]},'Stuart');
 assert.equal(result.succeeded,2);assert.equal(state.outcomes.length,2);assert.equal(state.familyReads,0);
 assert.equal(state.calls.filter(q=>q.query.startsWith('SELECT')&&q.query.includes('product_mapping_decisions')).length,0);
 assert.equal(state.calls.filter(q=>q.query.startsWith('SELECT')&&q.query.includes('product_mapping_review_outcomes')).length,2);
});

test('a matching preview token still performs full current-governance validation and saves once',async()=>{
 const {state,service,request,sources,parents}=fixture({count:1});
 const selectedRef=parents[0].source_product_ref,candidate={left_ref:sources[0].source_product_ref,right_ref:selectedRef,candidate_id:relationshipId(sources[0].source_product_ref,selectedRef)};
 const preview=buildProductChoicePreview({products:state.products,candidate,selectedRef});
 const result=await service.bulkReview({operation_id:'matching-token',decisions:[{...request(0),preview_token:preview.preview_token}]},'Stuart');
 assert.equal(result.succeeded,1);assert.equal(state.families.length,1);
 assert.equal(state.calls.filter(q=>q.query.startsWith('SELECT')&&q.query.includes('product_mapping_decisions')).length,1);
});

test('fast family saves retain duplicate-source blocking and reject Shopify variant targets independently',async()=>{
 const {state,service,request}=fixture({count:2});
 state.products.push({source_platform:'shopify',source_store:'shopify',source_product_id:'gid://shopify/ProductVariant/902',source_product_ref:'shopify:shopify:gid://shopify/ProductVariant/902',title:'Variant'});
 const result=await service.bulkReview({operation_id:'invalid-target',decisions:[request(0),{...request(0),request_id:'duplicate-source'},{...request(1),shopify_parent_ref:'shopify:shopify:gid://shopify/ProductVariant/902'}]},'Stuart');
 assert.deepEqual(result.results.map(x=>x.status),['saved','blocked','failed']);assert.equal(state.families.length,1);
 assert.match(result.results[2].error,/not a variant/);
});
