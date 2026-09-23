import test from 'node:test';
import assert from 'node:assert/strict';
import { approvedMappingEdges, candidateDiagnostics, classifyProduct, generateMappingCandidates, validateGraphApproval } from '../oracle/product-mapping.js';
import { buildCanonicalProductGraph, mapProductPair } from '../oracle/product-identity.js';

const p=(ref,title,extra={})=>({source_product_ref:ref,source_platform:ref.split(':')[0],source_store:ref.split(':')[1],source_product_id:ref.split(':')[2],title,...extra});

test('and/ampersand and shortened titles become generic review candidates',()=>{
  const candidates=generateMappingCandidates([p('woo:ww:1','Love and Death Ring'),p('square:square:2','Love & Death Ring'),p('woo:ww:3','Double Headed Open Skull Band'),p('square:square:4','Double Headed Open Band')]);
  assert.equal(candidates.find(x=>x.left_ref.endsWith(':1'))?.confidence,'high');
  assert.ok(candidates.some(x=>x.left_ref.endsWith(':3')&&x.right_ref.endsWith(':4')));
});

test('competing candidates remain visible and are never automatically selected',()=>{
  const candidates=generateMappingCandidates([p('woo:ww:1','Skull Ring'),p('square:square:2','Silver Skull Ring'),p('shopify:shopify:3','Heavy Skull Ring')]);
  assert.ok(candidates.length>1); assert.ok(candidates.every(x=>x.status==='suggested'&&x.competing));
  assert.equal(approvedMappingEdges(candidates).length,0);
});

test('approval creates an audited explicit edge with highest mapping precedence',()=>{
  const decision={left_ref:'woo:ww:1',right_ref:'shopify:shopify:2',status:'approved',reviewed_by:'admin',reviewed_at:'2026-01-01',provenance:'review'};
  const [edge]=approvedMappingEdges([decision]); assert.equal(edge.mapping_method,'explicit_governed_mapping'); assert.equal(edge.approved_by,'admin');
  assert.equal(mapProductPair([p(decision.left_ref,'Old')],[p(decision.right_ref,'New')],{explicitMappings:[edge]})[0].mapping_method,'explicit_governed_mapping');
});

test('suggestions do not alter canonical graph; approved edges do',()=>{
  const products=[p('woo:ww:1','Bat Ring'),p('square:square:2','Bat Rings')]; const [candidate]=generateMappingCandidates(products,{minimumScore:.4});
  assert.equal(buildCanonicalProductGraph(products,[]).length,2);
  assert.equal(buildCanonicalProductGraph(products,approvedMappingEdges([{...candidate,status:'approved'}])).length,1);
});

test('rejection suppresses reuse and ready-to-ship remains candidate-only',()=>{
  const products=[p('woo:ww:1','Ready To Ship - Alphabones - A'),p('shopify:shopify:2','Alphabones')];
  const [candidate]=generateMappingCandidates(products,{minimumScore:.3}); assert.equal(candidate.candidate_evidence.ready_to_ship_prefix,true);
  assert.equal(generateMappingCandidates(products,{minimumScore:.3,decisions:[{...candidate,status:'rejected'}]}).length,0);
});

test('non-products are conservatively classified and excluded',()=>{
  assert.equal(classifyProduct('UK POSTAGE'),'shipping'); assert.equal(classifyProduct('RESIZE'),'service'); assert.equal(classifyProduct('Gift Voucher £50'),'gift_voucher');
  assert.equal(generateMappingCandidates([p('woo:ww:1','UK POSTAGE'),p('square:square:2','UK Postage')]).length,0);
});

test('approval refuses impossible same-namespace graph collisions',()=>{
  assert.throws(()=>validateGraphApproval({left_ref:'woo:ww:2',right_ref:'square:square:9'},[{left_ref:'woo:ww:1',right_ref:'square:square:9',status:'approved'}]),/conflict/);
});

test('eligibility excludes resolved, shipping, and service products',()=>{
  const products=[p('woo:ww:1','Moon Ring',{mapping_status:'resolved'}),p('square:square:2','Moon Ring'),p('woo:ww:3','Shipping'),p('square:square:4','Shipping'),p('woo:ww:5','Resize Service'),p('square:square:6','Resize Service')];
  assert.equal(generateMappingCandidates(products).length,0);
});

test('candidate normalization handles punctuation and apostrophes without authorizing an edge',()=>{
  const [candidate]=generateMappingCandidates([p('woo:usd:1',"Death's-Head Ring"),p('shopify:shopify:2','Death’s Head Ring')]);
  assert.equal(candidate.confidence,'high');
  assert.match(candidate.candidate_evidence.summary.join(' '),/equivalent title/);
  assert.equal(candidate.status,'suggested');
});

test('containment exposes one meaningful missing token at lower priority',()=>{
  const [candidate]=generateMappingCandidates([p('woo:ww:1','Double Headed Open Skull Band'),p('square:square:2','Double Headed Open Band')]);
  assert.equal(candidate.confidence,'medium');
  assert.deepEqual(candidate.candidate_evidence.unmatched_tokens,['skull']);
});

test('blocking stays bounded and priorities cover high medium and low',()=>{
  const unrelated=Array.from({length:100},(_,i)=>p(`woo:ww:${i}`,`Unique${i} Ring`));
  const diagnostics={};
  const candidates=generateMappingCandidates([...unrelated,p('square:square:x','Unique1 Ring')],{diagnostics,minimumScore:.1});
  assert.ok(diagnostics.blocked_candidate_pairs_considered < 20);
  assert.equal(candidates[0].confidence,'high');
  assert.equal(generateMappingCandidates([p('woo:ww:a','Heavy Silver Skull Ring'),p('square:square:b','Heavy Skull Ring')])[0].confidence,'medium');
  assert.equal(generateMappingCandidates([p('woo:ww:a','Heavy Silver Skull Ring'),p('square:square:b','Silver Skull Pendant')],{minimumScore:.4})[0].confidence,'low');
});

test('approved and rejected decisions suppress candidates and diagnostics retain counts',()=>{
  const products=[p('woo:ww:1','Skull Ring'),p('square:square:2','Silver Skull Ring')];
  const [candidate]=generateMappingCandidates(products);
  const rejected={...candidate,status:'rejected'};
  assert.equal(candidateDiagnostics(products,[rejected]).candidate_count,0);
  assert.equal(candidateDiagnostics(products,[rejected]).rejected_count,1);
  const approved={...candidate,status:'approved'};
  assert.equal(candidateDiagnostics(products,[approved]).eligible_products,0);
  assert.equal(candidateDiagnostics(products,[approved]).approved_count,1);
});
