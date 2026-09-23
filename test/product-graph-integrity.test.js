import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductGraphExtensionIntegrity, assertProductGraphIntegrity, diagnoseProposedProductEdge, inspectProductGraph, preserveConflictedProductIdentity } from '../oracle/product-graph-integrity.js';

const p=(ref,title=ref)=>({source_product_ref:ref,title});
const e=(left_ref,right_ref,extra={})=>({left_ref,right_ref,mapping_status:'resolved',...extra});

test('valid cross-namespace component and Shopify channel identity satisfy canonical contract',()=>{
  const products=[p('woo:ww:a'),p('square:square:x'),p('shopify:shopify:b')];
  const graph=inspectProductGraph({products,deterministicEdges:[e('woo:ww:a','square:square:x',{mapping_method:'exact_unique_sku'}),e('square:square:x','shopify:shopify:b',{mapping_method:'exact_unique_normalized_base_title'})]});
  assert.equal(graph.summary.conflicted_components,0);assert.equal(graph.components.length,1);
  assert.equal(inspectProductGraph({products:[p('shopify:shopify:42')]}).nodes.length,1);
});

test('candidate diagnostic shows endpoint components and the complete conflict path without changing safety',()=>{
  const products=[p('woo:ww:heart','Heart With Love Banner'),p('shopify:shopify:10434340258119','Brat Devil Pendant'),p('shopify:shopify:10434342093127','Rascal Devil Pendant')];
  const deterministicEdges=[e('woo:ww:heart','shopify:shopify:10434340258119',{mapping_method:'exact_unique_sku'})];
  const explicitEdges=[];
  const candidate={candidate_id:'0e0bcd00a8eda894832d7dc6',left_ref:'woo:ww:heart',right_ref:'shopify:shopify:10434342093127',left_title:products[0].title,right_title:'Ready To Ship - Heart & Banner “Love” Ring - O'};
  const result=diagnoseProposedProductEdge({products,deterministicEdges,explicitEdges,candidate});
  assert.equal(result.read_only,true);assert.equal(result.endpoints.length,2);assert.equal(result.new_conflicts.length,1);
  assert.equal(result.graph_comparison.governed_only_validator_graph.deterministic_edges,0);
  assert.equal(result.graph_comparison.write_time_graph.deterministic_edges,1);
  const pendantConflict=result.new_conflicts.find(x=>x.conflicting_namespace==='shopify:shopify');
  assert.deepEqual(pendantConflict.products.map(x=>x.product_id),['10434340258119','10434342093127']);
  assert.deepEqual(pendantConflict.edges.map(x=>x.edge_source),['deterministic_identity','proposed_candidate']);
  assert.equal(pendantConflict.edges[1].decision_id,null);
  assert.equal(inspectProductGraph({products,deterministicEdges,explicitEdges}).summary.conflicted_components,0);
});

test('direct same-namespace edge is rejected with edge-level reason',()=>{
  assert.throws(()=>assertProductGraphIntegrity({explicitEdges:[e('woo:ww:a','woo:ww:c')]}),/direct_same_namespace_edge/);
});

test('transitive deterministic and explicit conflict has actionable non-PII path',()=>{
  const products=[p('woo:ww:a','A'),p('woo:ww:c','C'),p('square:square:x','X'),p('shopify:shopify:b','B')];
  const deterministicEdges=[e('woo:ww:a','square:square:x',{mapping_method:'exact_unique_sku'}),e('square:square:x','shopify:shopify:b',{mapping_method:'exact_unique_normalized_base_title'})];
  const explicitEdges=[e('woo:ww:c','shopify:shopify:b',{decision_id:'decision-def',relationship_id:'rel-def',mapping_method:'explicit_governed_mapping',provenance:'oracle_product_mapping_review',approved_by:'reviewer',approved_at:'2026-01-01'})];
  const graph=inspectProductGraph({products,deterministicEdges,explicitEdges});
  assert.equal(graph.summary.conflicted_components,1);assert.equal(graph.summary.transitive_namespace_conflicts,1);
  assert.deepEqual(graph.conflict_diagnostics[0].decision_ids,['decision-def']);
  assert.equal(graph.conflict_diagnostics[0].direct_edges.length,3);
  assert.doesNotMatch(JSON.stringify(graph),/customer|email|order/i);
  assert.throws(()=>assertProductGraphIntegrity({products,deterministicEdges,explicitEdges}),/woo:ww.*woo:ww:a \(A\).*woo:ww:c \(C\)/);
  const safe=preserveConflictedProductIdentity(products.map(x=>({...x,canonical_product_ref:'canonical:bad'})),graph);
  assert.ok(safe.every(x=>x.mapping_status==='conflicted_unresolved'&&x.canonical_product_ref===null));
  const resolved=inspectProductGraph({products,deterministicEdges,explicitEdges:[]});
  assert.equal(resolved.summary.conflicted_components,0); // revocation removes only the active edge; history is external and retained.
});

test('an unrelated existing deterministic conflict does not block a safe approval',()=>{
  const products=[p('woo:ww:brat','Brat Devil Pendant'),p('woo:ww:rascal','Rascal Devil Pendant'),p('shopify:shopify:devil','Devil Pendant'),p('square:square:brat','Brat Devil Pendant'),p('woo:usd:love','Ready To Ship - Love Ring - O'),p('shopify:shopify:love','Love Ring')];
  const deterministicEdges=[e('woo:ww:brat','shopify:shopify:devil',{mapping_method:'exact_unique_sku'}),e('shopify:shopify:devil','square:square:brat',{mapping_method:'exact_unique_sku'}),e('square:square:brat','woo:ww:rascal',{mapping_method:'exact_unique_normalized_base_title'})];
  const candidate=e('woo:usd:love','shopify:shopify:love',{mapping_method:'explicit_governed_mapping'});
  const graph=assertProductGraphExtensionIntegrity({products,deterministicEdges,candidate});
  assert.equal(graph.summary.conflicted_components,1);
  assert.ok(graph.edges.some(edge=>edge.left_ref===candidate.left_ref&&edge.right_ref===candidate.right_ref));
});

test('Woo size products cannot both be merged into one Shopify variant parent',()=>{
  const products=[p('woo:ww:size-n','Ready To Ship - Love Ring - N'),p('woo:ww:size-o','Ready To Ship - Love Ring - O'),p('shopify:shopify:love','Love Ring')];
  const deterministicEdges=[e('woo:ww:size-n','shopify:shopify:love',{mapping_method:'exact_unique_sku'})];
  assert.throws(()=>assertProductGraphExtensionIntegrity({products,deterministicEdges,candidate:e('woo:ww:size-o','shopify:shopify:love')}),/would create.*conflict/);
});
