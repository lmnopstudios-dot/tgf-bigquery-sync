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

/** Prevent a conflicted component from becoming a single report aggregate. */
export function preserveConflictedProductIdentity(rows, graph) {
  const conflictedRefs=new Set(graph.components.filter(c=>c.integrity_status==='conflicted').flatMap(c=>c.source_products));
  return rows.map(row => conflictedRefs.has(row.source_product_ref) ? {...row, canonical_product_ref:null, product_ref:`source:${row.source_product_ref}`, mapping_status:'conflicted_unresolved'} : row);
}
