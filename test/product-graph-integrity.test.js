import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductGraphIntegrity, inspectProductGraph, preserveConflictedProductIdentity } from '../oracle/product-graph-integrity.js';

const p=(ref,title=ref)=>({source_product_ref:ref,title});
const e=(left_ref,right_ref,extra={})=>({left_ref,right_ref,mapping_status:'resolved',...extra});

test('valid cross-namespace component and Shopify channel identity satisfy canonical contract',()=>{
  const products=[p('woo:ww:a'),p('square:square:x'),p('shopify:shopify:b')];
  const graph=inspectProductGraph({products,deterministicEdges:[e('woo:ww:a','square:square:x',{mapping_method:'exact_unique_sku'}),e('square:square:x','shopify:shopify:b',{mapping_method:'exact_unique_normalized_base_title'})]});
  assert.equal(graph.summary.conflicted_components,0);assert.equal(graph.components.length,1);
  assert.equal(inspectProductGraph({products:[p('shopify:shopify:42')]}).nodes.length,1);
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
