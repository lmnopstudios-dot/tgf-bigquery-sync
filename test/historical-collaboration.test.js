import test from 'node:test';
import assert from 'node:assert/strict';
import {historicalFixture} from './helpers/historical-collaboration-fixture.js';
import {historicalCollaborationRequest} from '../public/oracle/historical-collaboration.js';
import {createProductClassificationService,validateProductClassification} from '../oracle/product-classification.js';
import {historicalClassificationReadSql} from '../oracle/historical-collaboration.js';

const user='Stuart';
async function request(f,choiceIndex=0,action='assign'){const data=await f.service.list({inventory:'all'});return historicalCollaborationRequest(data.items,data.collaborations[choiceIndex],action);}
test('historical Woo selection uses reviewed names, preserves stores and requires no Shopify target or title inference',async()=>{
 const f=historicalFixture(),data=await f.service.list({inventory:'all'});
 assert.deepEqual(data.collaborations.map(c=>c.title),['Alpha','Beta']);assert.ok(data.items.every(i=>i.classification.direct.length===0&&i.classification.names.length===0));
 const input=historicalCollaborationRequest(data.items,data.collaborations[0]);assert.equal(input.source_refs.length,2);assert.ok(!('shopify_parent_ref' in input));
 const result=await f.service.save(input,user);assert.equal(result.status,'complete');assert.ok(result.results.every(r=>r.status==='saved'));assert.equal(f.state.rows.length,4);
 for(const row of f.state.rows){assert.equal(validateProductClassification(row).provenance,'human_approved');assert.equal(row.reviewed_by,user);assert.equal(row.subject_grain,'source_product');assert.equal(row.canonical_product_ref,null);}
 assert.deepEqual(new Set(f.state.rows.map(r=>r.subject_ref)),new Set(['woo:ww:100','woo:usd:101']));
 assert.ok(f.state.rows.every(r=>['collaboration','alpha'].includes(r.classification_value)));
 const append=f.state.calls.find(q=>q.labels.operation==='append_classifications');assert.doesNotMatch(append.query,/WHEN MATCHED|UPDATE SET|DELETE/i);assert.equal(append.types.payload,'STRING');
 assert.equal(f.mapping.state.families.length,0);assert.equal(f.mapping.state.mappings.length,0);assert.equal(f.mapping.state.outcomes.length,0);
 const after=await f.service.list({inventory:'all'});assert.ok(after.items.every(i=>i.classification.names.includes('alpha')));
});
test('changes and removals append supersession records without deleting history or unrelated categories',async()=>{
 const f=historicalFixture();await f.service.save(await request(f),user);const original=structuredClone(f.state.rows);
 f.state.rows.push({...original[0],classification_id:'pc_12345678',classification_type:'product_category',classification_value:'ring'});
 await f.service.save(await request(f,1),user);assert.deepEqual(f.state.rows.slice(0,4),original);assert.ok(f.active('woo:ww:100').every(r=>['collaboration','beta'].includes(r.classification_value)));
 assert.ok(f.state.rows.some(r=>r.status==='revoked'&&original.some(o=>o.classification_id===r.supersedes_classification_id)));
 await f.service.save(await request(f,0,'revoke'),user);assert.equal(f.active('woo:ww:100').length,0);assert.equal(f.active('woo:usd:101').length,0);assert.ok(f.state.rows.some(r=>r.classification_id==='pc_12345678'&&r.status==='active'));
});
test('stale product evidence and contradictory inherited names block independently; successful rows survive',async()=>{
 const f=historicalFixture(),input=await request(f);f.state.inherited.push({subject_ref:'woo:usd:101',mapping_type:'approved_reporting_family',classification_type:'collaboration_name',classification_value:'beta',status:'active'});
 const result=await f.service.save(input,user);assert.equal(result.results.find(r=>r.source_ref==='woo:ww:100').status,'saved');assert.match(result.results.find(r=>r.source_ref==='woo:usd:101').error,/inherited/);assert.equal(f.state.rows.length,2);
 const second=await request(f);f.state.rows.push({...f.state.rows[0],classification_id:'pc_88888888',classification_value:'other',subject_ref:'woo:ww:100'});
 const stale=await f.service.save(second,user);const ww=stale.results.find(r=>r.source_ref==='woo:ww:100');assert.equal(ww.status,'blocked');assert.match(ww.error,/changed/);
});
test('revoked or renamed collection choices cannot be silently assigned from stale UI state',async()=>{
 const f=historicalFixture(),input=await request(f);f.collections[0].collaboration_name='renamed';await assert.rejects(f.service.save(input,user),/governed collaboration/);assert.equal(f.state.rows.length,0);assert.equal(f.mapping.state.operations.length,0);
});
test('Square, Shopify, arbitrary names, oversized batches and foreign operations are rejected',async()=>{
 const f=historicalFixture(),input=await request(f);
 for(const ref of ['square:square:100','shopify:shopify:100'])await assert.rejects(f.service.save({...input,source_refs:[ref]},user),/invalid selection/);
 await assert.rejects(f.service.save({...input,classification_value:'invented'},user),/invalid/);
 await assert.rejects(f.service.save({...input,source_refs:Array.from({length:9},(_,i)=>'woo:ww:'+i)},user),/invalid selection/);
 await f.service.save(input,user);await assert.rejects(f.service.status(input.operation_id,'Another user'),/ownership/);
 await assert.rejects(f.service.save({...input,collection_id:'11'},user),/different submission/);
});
test('saved decisions recover after lost acknowledgement; replay is idempotent and does not require collection reapproval',async()=>{
 const f=historicalFixture(),input=await request(f);f.state.loseAppendAck=true;await assert.rejects(f.service.save(input,user),/acknowledgement/);assert.equal(f.state.rows.length,4);
 const recovered=await f.service.status(input.operation_id,user);assert.equal(recovered.status,'complete');assert.ok(recovered.results.every(r=>r.status==='already_applied'));
 f.collections[0].governance_status='other';const replay=await f.service.save(input,user);assert.equal(replay.status,'complete');assert.equal(f.state.rows.length,4);
});
test('failed appends stay pending and explicit same-operation retry saves exactly one set',async()=>{
 const f=historicalFixture(),input=await request(f);f.state.failAppend=true;await assert.rejects(f.service.save(input,user),/append failed/);assert.equal(f.state.rows.length,0);assert.equal((await f.service.status(input.operation_id,user)).status,'processing');
 f.state.failAppend=false;assert.equal((await f.service.save(input,user)).status,'complete');assert.equal(f.state.rows.length,4);
});
test('classification sync preserves direct human decisions; bounded reads fail closed',async()=>{
 const f=historicalFixture();await f.service.save(await request(f),user);const before=structuredClone(f.state.rows);
 const sync=createProductClassificationService({bigquery:f.bigquery,project:'fixture',evidenceLoader:async()=>[]});await sync.sync();assert.deepEqual(f.state.rows,before);
 f.state.overflow=true;await assert.rejects(f.service.list({inventory:'all'}),/bounded read/);
 assert.match(historicalClassificationReadSql('fixture'),/cr_evidence/);assert.match(historicalClassificationReadSql('fixture'),/LIMIT 1001$/);
});
