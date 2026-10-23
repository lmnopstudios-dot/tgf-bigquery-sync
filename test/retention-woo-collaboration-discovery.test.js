import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {wooCollaborationDiscoverySql,wooCollaborationDiscoverySettings} from '../diagnostics/retention-woo-collaboration-discovery.js';
import {collaborationDiscoveryReview} from '../diagnostics/retention-woo-collaboration-review.js';
const context=[{collection_id:'658016338247',shopify_review_context:[{target_ref:'shopify:shopify:fixture1',title:"Iron Maiden 'Powerslave Eddie' Ring"},{target_ref:'shopify:shopify:fixture2',title:"Iron Maiden 'Book of Souls Eddie' Ring"}]}];
const row=extra=>({collection_id:'658016338247',source_ref:'woo:ww:fixture',titles:["Ready to Ship Iron Maiden 'Powerslave Eddie' Ring size W"],review_rank:1,collaboration_candidate_products:1,scope_eligible_customers:3,eligible_customers:4,eligible_orders:4,recorded_orders:4,current_catalogue_present:false,sku_targets:[],classification_conflicts:[],existing_decisions:[],...extra});
test('discovery scans parent catalogue, variations and all historical line keys, including missing catalogue and zero-sales listings',()=>{
 for(const store of ['ww','usd']){
  const sql=wooCollaborationDiscoverySql('fixture',store),settings=wooCollaborationDiscoverySettings('fixture',store),d=store==='ww'?'metorik_uk':'metorik_us';
  for(const t of ['products','product_variations','order_line_items'])assert.ok(sql.includes(`fixture.${d}.${t}`));
  assert.match(sql,/CAST\(variation_id AS STRING\)/);assert.match(sql,/line_item_id/);assert.match(sql,/ring_size/);assert.match(sql,/attributes_json/);
  assert.match(sql,/current_catalogue_present/);assert.match(sql,/lines_missing_order_evidence/);assert.match(sql,/scope_eligible_orders/);
  assert.doesNotMatch(cohortRelations(sql).relations.find(r=>r.name==='discovery_woo_records').body,/WHERE (?:p\.)?status='(?:publish|active)'/);assert.doesNotMatch(sql,/LIMIT 501|FROM review\b/);
  assert.equal(settings.jobTimeoutMs,50000);assert.equal(settings.scriptOptions.statementByteBudget,'500000000');assert.equal(settings.maximumBytesBilled,'4500000000');
  assert.equal((settings.query.match(/CREATE TEMP TABLE/g)||[]).length,8);
  assert.deepEqual([...new Set([...settings.query.matchAll(/@([a-z_]+)/g)].map(m=>m[1]))].filter(v=>!Object.hasOwn(settings.params,v)),[]);
 }
});
test('all named catalogue entries get independent counts and candidate quotas before display; Iron Maiden text leads do not require exact SKUs',()=>{
 const relations=cohortRelations(wooCollaborationDiscoverySql('fixture','ww')).relations,body=n=>relations.find(r=>r.name===n).body;
 assert.match(body('discovery_catalogue'),/NOT IN \('collaboration','collaborations'\)/);
 assert.match(body('discovery_evidence'),/UNION DISTINCT SELECT t.collection_id,w.source_ref,CAST\(NULL AS STRING\),'title_lead_only_manual_review'/);
 assert.match(body('discovery_evidence'),/w.iron_title_lead/);assert.match(body('discovery_woo_products'),/LOGICAL_OR\(REGEXP_CONTAINS/);
 assert.match(body('discovery_ranked'),/PARTITION BY collection_id/);assert.match(cohortRelations(wooCollaborationDiscoverySql('fixture','ww')).result,/review_rank<=201/);
 assert.match(body('discovery_source_skus'),/FROM discovery_woo_records/);assert.doesNotMatch(body('discovery_source_skus'),/persisted_skus|LIMIT/);
 for(const r of relations.filter(r=>r.name.startsWith('discovery_')))assert.doesNotMatch(r.body,/\b(?:ARRAY|EXISTS)\s*\(\s*SELECT\b/i,'no table-correlated scalar lookups');
});
test('title-only archived/RTS/size listings stay distinct in both stores; no identity or family is auto-approved',()=>{
 const rows=['ww','usd'].flatMap(store=>[row({source_ref:`woo:${store}:main`,titles:["Iron Maiden 'Powerslave Eddie' Ring"]}),row({source_ref:`woo:${store}:rts`,current_catalogue_present:true,recorded_orders:0,eligible_orders:0}),row({source_ref:`woo:${store}:size`,titles:["Iron Maiden 'Book of Souls Eddie' Ring size J"]})]);
 const out=collaborationDiscoveryReview(rows,context);assert.equal(out.length,6);assert.equal(new Set(out.map(r=>r.source_ref)).size,6);
 assert.ok(out.every(r=>r.proposed_target===null&&!r.relationship_approved));assert.ok(out.every(r=>r.title_review_leads.length===1));
 assert.equal(out.find(r=>r.source_ref==='woo:ww:rts').listing_evidence,'present_in_current_catalogue');assert.match(out.find(r=>r.source_ref==='woo:ww:rts').sales_evidence,/no_eligible_sales_in_retained_orders_not_proof/);
 assert.match(out.find(r=>r.source_ref==='woo:ww:main').listing_evidence,/historical_order_line/);
});
test('SKU proposals, approved routes, rejected history and source conflicts require the appropriate graph review action',()=>{
 const out=collaborationDiscoveryReview([row({sku_targets:['shopify:shopify:fixture1']}),row({source_ref:'woo:usd:conflict',sku_targets:['a','b'],classification_conflicts:['collaboration_name']}),row({source_ref:'woo:ww:rejected',sku_targets:['a'],existing_decisions:[{status:'rejected'}]}),row({source_ref:'woo:ww:approved',approved_route_present:true,sku_targets:['a']}),row({source_ref:'woo:ww:missing',eligible_orders:0,lines_missing_order_evidence:1})],context);
 assert.equal(out.find(r=>r.source_ref==='woo:ww:fixture').proposed_target,'shopify:shopify:fixture1');assert.ok(out.every(r=>r.relationship_approved===false));
 assert.equal(out.find(r=>r.source_ref==='woo:ww:rejected').proposed_target,null);assert.equal(out.find(r=>r.source_ref==='woo:usd:conflict').proposed_target,null);
 assert.match(out.find(r=>r.source_ref==='woo:ww:approved').required_governance_action,/no_reapproval/);assert.equal(out.find(r=>r.source_ref==='woo:ww:missing').sales_evidence,'eligibility_evidence_incomplete');
});
test('generated sales aggregation counts recorded and eligible orders separately and deduplicates order-line keys (local SQLite compatibility)',()=>{
 let sql=cohortRelations(wooCollaborationDiscoverySql('fixture','ww')).relations.find(r=>r.name==='discovery_sales').body;
 sql=sql.replace(/,\s*ARRAY_AGG\(STRUCT\(order_ref,line_item_id,variation_id,ring_size,eligible,order_evidence_missing\)[\s\S]*?LIMIT 21\) order_line_references/,'').replaceAll('COUNTIF(','SUM(').replaceAll("CONCAT(order_ref,':',line_item_id)","(order_ref||':'||line_item_id)").replaceAll(',@time_zone','');
 const fixture="SELECT 'old' product_id,'1' order_ref,'1' line_item_id,1 eligible,'linked' governed_customer_ref,'2021-01-01' order_timestamp,'2021-01-01' order_created_at,0 order_evidence_missing UNION ALL SELECT 'old','2','2',1,'linked','2024-01-01','2024-01-01',0 UNION ALL SELECT 'old','2','2',1,'linked','2024-01-01','2024-01-01',0 UNION ALL SELECT 'old','3','3',0,NULL,'2024-02-01','2024-02-01',1";
 const p=spawnSync('python3',['test/helpers/retention-sqlite.py'],{input:JSON.stringify({sql:'WITH discovery_line_facts AS ('+fixture+'),sales AS ('+sql+') SELECT * FROM sales',params:{cohort_entry_start:'2022-10-19'},members:[],returns:[],classes:[]}),encoding:'utf8'});assert.equal(p.status,0,p.stderr);const r=JSON.parse(p.stdout)[0];
 assert.equal(r.recorded_orders,3);assert.equal(r.recorded_order_lines,3);assert.equal(r.eligible_orders,2);assert.equal(r.scope_eligible_orders,1);assert.equal(r.eligible_customers,1);assert.equal(r.earliest_recorded_order,'2021-01-01');assert.equal(r.lines_missing_order_evidence,1);
});
test('published discovery artifact is deterministic and portable review formatter has no imports',async()=>{
 const a=JSON.parse(gunzipSync(readFileSync(new URL('../diagnostics/retention-woo-collaboration-discovery.json.gz',import.meta.url))));
 assert.deepEqual(a.settings,['ww','usd'].map(store=>({store,...wooCollaborationDiscoverySettings('gf-full-data',store)})));
 const mod=await import('data:text/javascript;base64,'+Buffer.from(a.review_source).toString('base64'));assert.equal(typeof mod.collaborationDiscoveryReview,'function');
});
