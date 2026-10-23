const names={'woo:ww':'WooCommerce WW','woo:usd':'WooCommerce USD','square:square':'Square','shopify:shopify':'Shopify'};
export function mappingProductLabel(product){
 const ref=String(product.source_product_ref||'');
 const source=ref.split(':').slice(0,2).join(':');
 return `${names[source]||source||'Unknown source'} — ${product.title||'Untitled product'} · ${ref||'source reference unavailable'}${product.sku?` · SKU ${product.sku}`:''} · ${product.line_items||0} lines`;
}
export function mappingEvidenceLabel(product){
 if(product.explicit_mapping_status==='approved')return 'Persisted identity approval; report use still requires active graph and classification checks.';
 if(product.mapping_status==='resolved')return 'Heuristic title/SKU match only — no persisted identity approval established; not report-ready approval.';
 return 'No persisted identity approval established. Reporting-family membership is reviewed separately.';
}
