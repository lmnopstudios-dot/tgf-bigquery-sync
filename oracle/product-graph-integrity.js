/** Canonical product graph contract. Product refs are platform:store:product-id. */
export const PRODUCT_SOURCE_NAMESPACES = Object.freeze(['woo:ww', 'woo:usd', 'shopify:shopify', 'square:square']);

export function productNamespace(ref) {
  const parts = String(ref || '').split(':');
  return parts.length >= 3 && parts[0] && parts[1] && parts.slice(2).join(':') ? `${parts[0]}:${parts[1]}` : null;
}

const edgeId = edge => edge.relationship_id || edge.decision_id || `${edge.left_ref}<->${edge.right_ref}`;

/**
 * The one in-process graph implementation used by construction, writes and diagnostics.
 * Invalid edges are diagnosed but deliberately excluded from connectivity.
 */
export function inspectProductGraph({ products = [], explicitEdges = [], deterministicEdges = [], diagnosticLimit = 20 } = {}) {
  const productByRef = new Map(products.map(product => [product.source_product_ref, product]));
  const edges = [...deterministicEdges, ...explicitEdges].filter(edge => !edge.mapping_status || edge.mapping_status === 'resolved');
  const edgeProblems = [];
  const usable = [];
  for (const edge of edges) {
    const leftNamespace = productNamespace(edge.left_ref), rightNamespace = productNamespace(edge.right_ref);
    let reason = null;
    if (!leftNamespace || !rightNamespace) reason = 'malformed_or_missing_source_ref';
    else if (edge.left_ref === edge.right_ref) reason = 'self_edge';
    else if (leftNamespace === rightNamespace) reason = 'direct_same_namespace_edge';
    else if (!PRODUCT_SOURCE_NAMESPACES.includes(leftNamespace) || !PRODUCT_SOURCE_NAMESPACES.includes(rightNamespace)) reason = 'unknown_source_namespace';
    if (reason) edgeProblems.push({ reason, edge }); else usable.push(edge);
  }

  const refs = new Set([...products.map(p => p.source_product_ref), ...usable.flatMap(e => [e.left_ref, e.right_ref])]);
  const parent = new Map([...refs].map(ref => [ref, ref]));
  const find = ref => { const p = parent.get(ref); if (p !== ref) parent.set(ref, find(p)); return parent.get(ref); };
  const union = (a, b) => { const ar=find(a), br=find(b); if (ar !== br) parent.set(ar < br ? br : ar, ar < br ? ar : br); };
  usable.forEach(edge => union(edge.left_ref, edge.right_ref));
  const grouped = new Map();
  for (const ref of refs) { const root=find(ref); if (!grouped.has(root)) grouped.set(root, []); grouped.get(root).push(ref); }
  const components = [...grouped.values()].map(sourceProducts => {
    sourceProducts.sort();
    const set = new Set(sourceProducts), componentEdges=usable.filter(e => set.has(e.left_ref) && set.has(e.right_ref));
    const byNamespace = new Map();
    for (const ref of sourceProducts) { const ns=productNamespace(ref); if (!byNamespace.has(ns)) byNamespace.set(ns, []); byNamespace.get(ns).push(ref); }
    const duplicateNamespaces=[...byNamespace].filter(([, values]) => values.length > 1).map(([namespace, values]) => ({ namespace, source_product_refs:values }));
    const canonical_product_ref=`canonical:${sourceProducts[0]}`;
    return { canonical_product_ref, source_products:sourceProducts, edges:componentEdges, source_namespaces:Object.fromEntries(byNamespace), integrity_status:duplicateNamespaces.length?'conflicted':'valid', duplicate_namespaces:duplicateNamespaces };
  });
  const conflicted=components.filter(c=>c.integrity_status==='conflicted');
  const conflictDiagnostics=conflicted.slice(0, Math.max(0, diagnosticLimit)).flatMap(component => component.duplicate_namespaces.map(conflict => ({
    canonical_component_ref: component.canonical_product_ref,
    conflicting_namespace: conflict.namespace,
    products: conflict.source_product_refs.map(ref => ({ source_product_ref:ref, title:productByRef.get(ref)?.title || productByRef.get(ref)?.base_title || null })),
    decision_ids: [...new Set(component.edges.map(e=>e.decision_id).filter(Boolean))],
    relationship_ids: [...new Set(component.edges.map(e=>e.relationship_id).filter(Boolean))],
    direct_edges: component.edges.map(e=>({ edge_id:edgeId(e), left_ref:e.left_ref, right_ref:e.right_ref, mapping_method:e.mapping_method || 'unknown', provenance:e.provenance || null, reviewer:e.approved_by || e.reviewed_by || null, decision_timestamp:e.approved_at || e.reviewed_at || null })),
    reason:`Component ${component.canonical_product_ref} contains ${conflict.source_product_refs.length} ${conflict.namespace} products`
  })));
  return {
    nodes:[...refs].sort(), edges:usable, components,
    summary:{ active_approved_edges:explicitEdges.length, deterministic_edges:deterministicEdges.length, graph_components:components.length, valid_components:components.length-conflicted.length, conflicted_components:conflicted.length, self_edges:edgeProblems.filter(x=>x.reason==='self_edge').length, direct_same_namespace_edges:edgeProblems.filter(x=>x.reason==='direct_same_namespace_edge').length, malformed_edges:edgeProblems.filter(x=>x.reason.includes('source_ref')||x.reason==='unknown_source_namespace').length, transitive_namespace_conflicts:conflicted.reduce((n,c)=>n+c.duplicate_namespaces.length,0) },
    edge_problems:edgeProblems, conflicted_component_ids:conflicted.map(c=>c.canonical_product_ref), conflict_diagnostics:conflictDiagnostics
  };
}

export function assertProductGraphIntegrity(input) {
  const result=inspectProductGraph(input);
  const issue=result.edge_problems[0];
  if (issue) throw new Error(`product mapping rejected: ${issue.reason} (${issue.edge.left_ref || 'missing'} ↔ ${issue.edge.right_ref || 'missing'})`);
  if (result.summary.conflicted_components) {
    const conflict=result.conflict_diagnostics[0];
    throw new Error(`product mapping would create a canonical graph conflict: ${conflict.reason}; conflicting products: ${conflict.products.map(p=>`${p.source_product_ref}${p.title?` (${p.title})`:''}`).join(', ')}`);
  }
  return result;
}

const conflictPairKeys = graph => new Set(graph.components.flatMap(component => component.duplicate_namespaces.flatMap(duplicate =>
  duplicate.source_product_refs.flatMap((left,index) => duplicate.source_product_refs.slice(index+1).map(right => [left,right].sort().join('\0')))
)));

/**
 * Validate one proposed edge without allowing unrelated, pre-existing bad data to
 * block all governance writes.  The invariant is still strict: the proposal may
 * not introduce even one new same-namespace pair.
 */
export function assertProductGraphExtensionIntegrity({products=[],explicitEdges=[],deterministicEdges=[],candidate}={}) {
  if(!candidate?.left_ref||!candidate?.right_ref) throw new Error('candidate endpoints are required');
  const proposed={...candidate,mapping_status:'resolved'};
  const before=inspectProductGraph({products,explicitEdges,deterministicEdges});
  const after=inspectProductGraph({products,explicitEdges:[...explicitEdges,proposed],deterministicEdges});
  const proposedProblem=after.edge_problems.find(problem=>problem.edge===proposed);
  if(proposedProblem) throw new Error(`product mapping rejected: ${proposedProblem.reason} (${proposed.left_ref} ↔ ${proposed.right_ref})`);
  const prior=conflictPairKeys(before);
  const introduced=[...conflictPairKeys(after)].filter(key=>!prior.has(key));
  if(introduced.length){
    const [left,right]=introduced[0].split('\0'),byRef=new Map(products.map(product=>[product.source_product_ref,product]));
    const label=ref=>`${ref}${byRef.get(ref)?.title?` (${byRef.get(ref).title||byRef.get(ref).base_title})`:''}`;
    throw new Error(`product mapping would create a canonical graph conflict: ${productNamespace(left)} would contain distinct products; conflicting products: ${label(left)}, ${label(right)}`);
  }
  return after;
}

const diagnosticEdge = (edge, proposed) => ({
  edge_source: edge === proposed ? 'proposed_candidate' : edge.decision_id ? 'governed_approval' : 'deterministic_identity',
  mapping_method: edge.mapping_method || 'unknown', left_ref:edge.left_ref, right_ref:edge.right_ref,
  decision_id:edge.decision_id || null, relationship_id:edge.relationship_id || null
});

/** Explain only the new conflicts introduced by one proposed edge; never mutates graph state. */
export function diagnoseProposedProductEdge({products=[],explicitEdges=[],deterministicEdges=[],candidate}={}) {
  if(!candidate?.left_ref||!candidate?.right_ref) throw new Error('candidate endpoints are required');
  const proposed={...candidate,mapping_status:'resolved',mapping_method:candidate.mapping_method||'explicit_governed_mapping'};
  const before=inspectProductGraph({products,explicitEdges,deterministicEdges});
  const governedOnly=inspectProductGraph({products,explicitEdges});
  const after=inspectProductGraph({products,explicitEdges:[...explicitEdges,proposed],deterministicEdges});
  const productByRef=new Map(products.map(p=>[p.source_product_ref,p]));
  const componentFor=(graph,ref)=>graph.components.find(c=>c.source_products.includes(ref));
  const endpoints=[candidate.left_ref,candidate.right_ref].map(ref=>{const c=componentFor(before,ref);return {source_product_ref:ref,title:productByRef.get(ref)?.title||null,canonical_component_ref:c?.canonical_product_ref||null,component_products:c?.source_products||[ref]};});
  const adjacency=new Map();
  const add=(ref,item)=>{const values=adjacency.get(ref)||[];values.push(item);adjacency.set(ref,values);};
  for(const edge of after.edges){add(edge.left_ref,{ref:edge.right_ref,edge});add(edge.right_ref,{ref:edge.left_ref,edge});}
  const path=(start,end)=>{const queue=[start],seen=new Set([start]),previous=new Map();while(queue.length){const ref=queue.shift();if(ref===end)break;for(const item of adjacency.get(ref)||[]){if(seen.has(item.ref))continue;seen.add(item.ref);previous.set(item.ref,{ref,edge:item.edge});queue.push(item.ref);}}if(!seen.has(end))return null;const edges=[];for(let ref=end;ref!==start;){const item=previous.get(ref);edges.unshift(diagnosticEdge(item.edge,proposed));ref=item.ref;}return edges;};
  const merged=componentFor(after,candidate.left_ref);
  const beforeConflicts=conflictPairKeys(before);
  const conflict_paths=[];
  for(const duplicate of merged?.duplicate_namespaces||[])for(let i=0;i<duplicate.source_product_refs.length;i++)for(let j=i+1;j<duplicate.source_product_refs.length;j++){
    const refs=[duplicate.source_product_refs[i],duplicate.source_product_refs[j]].sort();
    if(beforeConflicts.has(refs.join('\0')))continue;
    conflict_paths.push({conflicting_namespace:duplicate.namespace,products:refs.map(ref=>({source_product_ref:ref,product_id:ref.split(':').slice(2).join(':'),title:productByRef.get(ref)?.title||null})),edges:path(refs[0],refs[1])});
  }
  return {read_only:true,candidate:{candidate_id:candidate.candidate_id||null,left_ref:candidate.left_ref,right_ref:candidate.right_ref,left_title:candidate.left_title||productByRef.get(candidate.left_ref)?.title||null,right_title:candidate.right_title||productByRef.get(candidate.right_ref)?.title||null},endpoints,graph_comparison:{governed_only_validator_graph:governedOnly.summary,write_time_graph:before.summary,missing_from_governed_only_validator:{products:true,deterministic_edges:deterministicEdges.length}},new_conflicts:conflict_paths,existing_graph_conflicts:before.summary.conflicted_components,proposed_graph_conflicts:after.summary.conflicted_components,diagnosis:conflict_paths.length?'proposed edge joins components containing different products from the same source namespace':before.summary.conflicted_components?'existing graph is already conflicted; candidate-specific cause is ambiguous':'candidate does not reproduce a graph conflict with the supplied graph'};
}

/** Prevent a conflicted component from becoming a single report aggregate. */
export function preserveConflictedProductIdentity(rows, graph) {
  const conflictedRefs=new Set(graph.components.filter(c=>c.integrity_status==='conflicted').flatMap(c=>c.source_products));
  return rows.map(row => conflictedRefs.has(row.source_product_ref) ? {...row, canonical_product_ref:null, product_ref:`source:${row.source_product_ref}`, mapping_status:'conflicted_unresolved'} : row);
}
