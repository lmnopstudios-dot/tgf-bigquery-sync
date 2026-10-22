// Read-only reconciliation starts at the same current decisions as governance.
// A collection title is a display label, never a classification or alias rule.
export function retentionCatalogueSql(project){
  return `SELECT g.collection_id,COALESCE(n.collection_title,c.title,g.collection_title) display_name,
    n.classification_value collaboration_name,
    c.product_count products,
    COALESCE(e.eligible_customers,0) eligible_customers,COALESCE(h.historical_products,0) historical_products
    FROM cr_collection_current g JOIN \`${project}.shopify_catalogue.collections\` c ON CAST(c.collection_id AS STRING)=g.collection_id LEFT JOIN cr_collection_current n ON n.collection_id=g.collection_id AND n.classification_type='collaboration_name' AND n.status='active'
    LEFT JOIN (SELECT collaboration_name,COUNT(DISTINCT governed_customer_ref) eligible_customers FROM entry_matches GROUP BY collaboration_name) e ON e.collaboration_name=n.classification_value
    LEFT JOIN (SELECT name,COUNT(DISTINCT l.source_product_ref) historical_products FROM line_classification_sets l CROSS JOIN UNNEST(l.names) name
      WHERE (@entry_source IS NULL OR l.source_platform=@entry_source) AND (@retention_source_store IS NULL OR l.source_store=@retention_source_store) AND l.collaboration_state='named' GROUP BY name) h ON h.name=n.classification_value
    WHERE g.classification_type='collection_group' AND g.status='active' AND g.classification_value='collaboration'
    ORDER BY g.collection_id`;
}

export function reconcileRetentionCatalogue(catalogue,rows,{source_platform,source_store}={}){
  if(!Array.isArray(catalogue)||catalogue.length>1000)throw Error('Invalid retention catalogue');
  const seen=new Set();
  return catalogue.map(c=>{
    if(typeof c.collection_id!=='string'||!c.collection_id||seen.has(c.collection_id)||typeof c.display_name!=='string'||!c.display_name||c.collaboration_name!=null&&typeof c.collaboration_name!=='string'||!['products','eligible_customers','historical_products'].every(k=>c[k]!=null&&c[k]!==''&&typeof c[k]!=='boolean'&&Number.isSafeInteger(Number(c[k]))&&Number(c[k])>=0))throw Error('Invalid retention catalogue entry');
    seen.add(c.collection_id);
    const generic=['collaboration','collaborations'].includes(c.collaboration_name);
    const included=rows.some(r=>!r.entry_product_ref&&r.collaboration_name===c.collaboration_name&&r.source_platform===source_platform&&r.source_store===source_store);
    const status=generic?'generic_membership':!c.collaboration_name?'missing_governed_name':included?'included':Number(c.products)===0?'no_products':Number(c.eligible_customers)>0?'truncated':Number(c.historical_products)===0?'missing_historical_mapping_or_classification':'no_eligible_first_purchase_customers';
    return {...c,products:Number(c.products),eligible_customers:Number(c.eligible_customers),historical_products:Number(c.historical_products),source_platform,source_store,status,
      governed_alias_collection_ids:generic||!c.collaboration_name?[]:catalogue.filter(x=>x.collection_id!==c.collection_id&&x.collaboration_name===c.collaboration_name).map(x=>x.collection_id)};
  });
}
