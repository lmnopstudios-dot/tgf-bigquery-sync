import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductMappingService,buildHistoricalReviewIndex,buildHistoricalReviewQueue} from '../oracle/product-mapping.js';
import {prepareWooBatch} from '../public/oracle/woo-assignment.js';
const p=(ref,title='Powerslave')=>{const [source_platform,source_store,source_product_id]=ref.split(':');return {source_product_ref:ref,source_platform,source_store,source_product_id,title,mapping_status:'resolved',line_items:2};};
const products=[p('woo:ww:11737'),p('woo:usd:106660'),p('square:square:control'),p('shopify:shopify:10434361590087')];
const family={source_ref:'woo:ww:11737',shopify_parent_ref:'shopify:shopify:10434361590087',decision_id:'family',status:'active'};
test('Woo assignment inventory exposes heuristic matches without changing the legacy review queue',()=>{
 assert.equal(buildHistoricalReviewQueue(products,[]).length,0);
 assert.equal(buildHistoricalReviewIndex(products).length,0);
 assert.equal(buildHistoricalReviewIndex(products,{includeHeuristic:true}).length,3);
 const index=buildHistoricalReviewIndex(products,{includeHeuristic:true,familyDecisions:[family],reviewOutcomes:[{source_ref:'woo:usd:106660',outcome:'no_equivalent'}]});
 assert.equal(index.find(x=>x.historical_product.source_store==='ww').resolution_status,'active_reporting_family');
 assert.equal(index.find(x=>x.historical_product.source_store==='usd').resolution_status,'no_equivalent');
});
test('assignment listing scopes stores and saved/outcome status before pagination; Square is never included',async()=>{
 const service=createProductMappingService({project:'fixture',bigquery:{query:async q=>q.query.includes('product_family_decisions')?[[family]]:q.query.includes('product_mapping_review_outcomes')?[[{source_ref:'woo:usd:106660',outcome:'no_equivalent'}]]:[[]]}});
 const options={products,ensureSchema:false,view:'woo_assignment'};
 const all=await service.list({...options,assignmentStatus:'all'});assert.equal(all.pagination.total_items,2);assert.ok(all.items.every(x=>x.historical_product.source_platform==='woo'));
 assert.equal((await service.list({...options})).items.length,0);
 assert.equal((await service.list({...options,assignmentStatus:'assigned',source:'woo:ww'})).items[0].historical_product.source_product_ref,'woo:ww:11737');
 assert.equal((await service.list({...options,assignmentStatus:'no_equivalent',source:'woo:usd'})).items[0].historical_product.source_product_ref,'woo:usd:106660');
 await assert.rejects(service.list({...options,source:'square:square'}),/invalid Woo/);
});
function row(ref){const target={source_product_ref:'shopify:shopify:10434361590087',title:'Powerslave'};return {item:{historical_product:p(ref),resolution_status:'needs_review'},target,preview:{selected_product:target,family_preview:{allowed:true},identity_preview:{allowed:false}}};}
test('explicit bulk choices retain WW/USD keys, use distinct idempotency keys and reject unsafe or unreviewed rows',()=>{
 const batch=prepareWooBatch([row('woo:ww:11737'),row('woo:usd:106660')],'family');
 assert.deepEqual(batch.map(x=>x.source_ref),['woo:ww:11737','woo:usd:106660']);assert.equal(new Set(batch.map(x=>x.request_id)).size,2);assert.ok(batch.every(x=>x.action==='family'));
 for(const bad of [[row('square:square:control')],[row('woo:ww:11737'),row('woo:ww:11737')],Array.from({length:9},(_,i)=>row('woo:ww:'+i))])assert.throws(()=>prepareWooBatch(bad,'family'));
 assert.throws(()=>prepareWooBatch([row('woo:ww:11737')],'identity'),/allowed preview/);
 const noEquivalent=row('woo:ww:11737');noEquivalent.item.resolution_status='no_equivalent';assert.throws(()=>prepareWooBatch([noEquivalent],'family'),/unassigned/);
 const changed=row('woo:ww:11737');changed.target={source_product_ref:'shopify:shopify:gid://shopify/ProductVariant/1'};assert.throws(()=>prepareWooBatch([changed],'family'),/allowed preview/);
});
