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

test('default queue hides saved links and Shopify automatic matches, but never treats Woo/Square-only matches as Shopify links',async()=>{
 const catalog=[p('woo:ww:1','Shared title'),p('woo:usd:2','Shared title'),p('shopify:shopify:3','Shared title'),p('woo:ww:4','Woo/Square only'),p('woo:usd:5','Woo/Square only'),p('square:square:6','Woo/Square only'),p('woo:ww:7','Saved family'),p('woo:usd:8','Saved identity'),p('shopify:shopify:9','Current product')];
 const families=[{...family,source_ref:'woo:ww:7',shopify_parent_ref:'shopify:shopify:9'}];
 const identities=[{decision_id:'approved',status:'approved',left_ref:'woo:usd:8',right_ref:'shopify:shopify:9'}];
 const service=createProductMappingService({project:'fixture',bigquery:{query:async q=>q.query.includes('product_family_decisions')?[families]:q.query.includes('product_mapping_decisions')?[identities]:[[]]}});
 const options={products:catalog,ensureSchema:false,view:'woo_assignment',sort:'title',pageSize:1};
 const unlinked=await service.list(options);assert.equal(unlinked.pagination.total_items,2);assert.equal(unlinked.pagination.total_pages,2);assert.ok(['woo:ww:4','woo:usd:5'].includes(unlinked.items[0].historical_product.source_product_ref));
 const auto=await service.list({...options,assignmentStatus:'automatic_matches',pageSize:50});assert.equal(auto.pagination.total_items,2);assert.ok(auto.items.every(x=>x.resolution_status==='needs_review'&&x.automatic_shopify_match.source_product_ref==='shopify:shopify:3'));
 const saved=await service.list({...options,assignmentStatus:'assigned',pageSize:50});assert.equal(saved.pagination.total_items,2);
 const all=await service.list({...options,assignmentStatus:'all',pageSize:50});assert.equal(all.pagination.total_items,6);
});

test('ambiguous titles remain unlinked; unique SKU matches are separate unsaved suggestions and do not change decisions',async()=>{
 const catalog=[p('woo:ww:1','Ambiguous'),p('shopify:shopify:2','Ambiguous'),p('shopify:shopify:3','Ambiguous'),{...p('woo:usd:4','Old title'),sku:'RING-4'},{...p('shopify:shopify:5','New title'),sku:'RING-4'}];
 let writes=0;const service=createProductMappingService({project:'fixture',bigquery:{query:async q=>{if(!q.query.startsWith('SELECT'))writes++;return [[]];}}});
 const options={products:catalog,ensureSchema:false,view:'woo_assignment'};
 const missing=await service.list(options);assert.deepEqual(missing.items.map(x=>x.historical_product.source_product_ref),['woo:ww:1']);
 const auto=await service.list({...options,assignmentStatus:'automatic_matches'});assert.equal(auto.items[0].automatic_shopify_match.mapping_method,'exact_unique_sku');assert.equal(auto.items[0].active_identity_mapping,null);assert.equal(writes,0);
});

test('no-equivalent and investigation decisions need no target or preview and never send a leftover Shopify choice',()=>{
 for(const action of ['no_equivalent','needs_investigation']){
  const rows=[row('woo:ww:11737'),row('woo:usd:106660')];rows[0].target=null;rows[0].preview=null;rows[1].preview=null;
  const batch=prepareWooBatch(rows,action);assert.equal(batch.length,2);assert.ok(batch.every(x=>x.action===action&&x.shopify_parent_ref===null));assert.equal(new Set(batch.map(x=>x.request_id)).size,2);
  assert.throws(()=>prepareWooBatch([row('square:square:control')],action),/Woo/);
  const assigned=row('woo:ww:11737');assigned.item.resolution_status='active_reporting_family';assert.throws(()=>prepareWooBatch([assigned],action),/unassigned/);
  assert.throws(()=>prepareWooBatch(Array.from({length:9},(_,i)=>row('woo:ww:'+i)),action),/1–8/);
 }
});
