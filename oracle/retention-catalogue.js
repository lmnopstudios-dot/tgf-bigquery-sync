// Current governed catalogue and approved routes only. Display labels never
// establish membership; missing mappings/history never establish zero customers.
export function retentionCatalogueSql(project,source=null,store=null){
  let sql=`WITH catalogue_targets AS (
    SELECT g.collection_id,COALESCE(n.collection_title,c.title,g.collection_title) display_name,n.classification_value collaboration_name,c.product_count products
    FROM cr_collection_current g JOIN \`${project}.shopify_catalogue.collections\` c ON CAST(c.collection_id AS STRING)=g.collection_id
    LEFT JOIN cr_collection_current n ON n.collection_id=g.collection_id AND n.classification_type='collaboration_name' AND n.status='active'
    WHERE g.classification_type='collection_group' AND g.status='active' AND g.classification_value='collaboration'
  ), catalogue_members AS (
    SELECT DISTINCT t.collection_id,CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(pc.product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) product_ref
    FROM catalogue_targets t JOIN \`${project}.shopify_catalogue.product_collections\` pc ON CAST(pc.collection_id AS STRING)=t.collection_id
  ), catalogue_routes AS (
    SELECT collection_id,product_ref source_ref FROM catalogue_members UNION DISTINCT SELECT m.collection_id,r.source_ref FROM catalogue_members m JOIN cr_routes r ON r.classification_ref=m.product_ref
  ) SELECT t.*,COALESCE(e.eligible_customers,0) observed_eligible_customers,COALESCE(h.historical_products,0) historical_products,
    COALESCE(m.persisted_members,0) persisted_members,COALESCE(r.source_routes,0) source_routes,
    COALESCE(hr.historical_routed_products,0) historical_routed_products,COALESCE(hr.unclassified_products,0) unclassified_products,COALESCE(hr.conflicting_products,0) conflicting_products
    FROM catalogue_targets t
    LEFT JOIN (SELECT collaboration_name,COUNT(DISTINCT governed_customer_ref) eligible_customers FROM entry_matches${source?` WHERE source_platform='${source}' AND source_store='${store}'`:''} GROUP BY collaboration_name) e USING(collaboration_name)
    LEFT JOIN (SELECT name collaboration_name,COUNT(DISTINCT l.source_product_ref) historical_products FROM line_classification_sets l CROSS JOIN UNNEST(l.names) name
      WHERE (@entry_source IS NULL OR l.source_platform=@entry_source) AND (@retention_source_store IS NULL OR l.source_store=@retention_source_store) AND l.collaboration_state='named' GROUP BY name) h USING(collaboration_name)
    LEFT JOIN (SELECT collection_id,COUNT(DISTINCT product_ref) persisted_members FROM catalogue_members GROUP BY collection_id) m USING(collection_id)
    LEFT JOIN (SELECT collection_id,COUNT(DISTINCT source_ref) source_routes FROM catalogue_routes WHERE (@entry_source IS NULL OR STARTS_WITH(source_ref,CONCAT(@entry_source,':'))) AND (@retention_source_store IS NULL OR STARTS_WITH(source_ref,CONCAT(@entry_source,':',@retention_source_store,':'))) GROUP BY collection_id) r USING(collection_id)
    LEFT JOIN (SELECT r.collection_id,COUNT(DISTINCT l.source_product_ref) historical_routed_products,
      COUNT(DISTINCT IF(l.collaboration_state='classification_absent',l.source_product_ref,NULL)) unclassified_products,
      COUNT(DISTINCT IF(l.collaboration_state='conflicting',l.source_product_ref,NULL)) conflicting_products
      FROM catalogue_routes r JOIN line_classification_sets l ON l.source_product_ref=r.source_ref
      WHERE (@entry_source IS NULL OR l.source_platform=@entry_source) AND (@retention_source_store IS NULL OR l.source_store=@retention_source_store) GROUP BY r.collection_id) hr USING(collection_id)
    ORDER BY t.collection_id`;
  if(source){if(!((source==='woo'&&['ww','usd'].includes(store))||(source==='shopify'&&store==='shopify')))throw Error('Invalid catalogue source');sql=sql.replaceAll('@entry_source',`'${source}'`).replaceAll('@retention_source_store',`'${store}'`);}
  return sql;
}

export function reconcileRetentionCatalogue(catalogue,rows,{source_platform,source_store}={}){
  if(!Array.isArray(catalogue)||catalogue.length>1000)throw Error('Invalid retention catalogue');
  const seen=new Set();
  const valid=n=>n!==null&&n!==undefined&&n!==''&&typeof n!=='boolean'&&Number.isSafeInteger(Number(n))&&Number(n)>=0;
  return catalogue.map(c=>{
    const observed=c.observed_eligible_customers??c.eligible_customers;
    const history=c.historical_products??c.historical_named_products;
    const routeKeys=['persisted_members','source_routes','historical_routed_products','unclassified_products','conflicting_products'];
    if(typeof c.collection_id!=='string'||!c.collection_id||seen.has(c.collection_id)||typeof c.display_name!=='string'||!c.display_name||c.collaboration_name!=null&&typeof c.collaboration_name!=='string'||![c.products,observed,history].every(valid)||routeKeys.some(k=>c[k]!=null&&!valid(c[k])))throw Error('Invalid retention catalogue entry');
    seen.add(c.collection_id);
    const generic=['collaboration','collaborations'].includes(c.collaboration_name);
    const included=rows.some(r=>!r.entry_product_ref&&r.collaboration_name===c.collaboration_name&&r.source_platform===source_platform&&r.source_store===source_store);
    let status=generic?'generic_membership':!c.collaboration_name?'missing_governed_name':included?'included':Number(c.products)===0?'no_products':Number(observed)>0?'truncated':Number(history)>0?'no_eligible_first_purchase_customers':null;
    if(!status)status=c.persisted_members!=null&&Number(c.persisted_members)===0?'catalogue_membership_evidence_missing':c.source_routes!=null&&Number(c.source_routes)===0?'governed_source_product_mapping_missing':Number(c.unclassified_products)>0||Number(c.conflicting_products)>0?'historical_classification_absent_or_conflicting':c.historical_routed_products!=null?'historical_product_evidence_missing_cause_unverified':'missing_historical_mapping_or_classification';
    const eligibilityKnown=Number(observed)>0||Number(history)>0;
    return {...c,products:Number(c.products),observed_eligible_customers:Number(observed),eligible_customers:eligibilityKnown?Number(observed):null,eligibility_status:eligibilityKnown?'observed_governed_history':'unknown',historical_products:Number(history),...Object.fromEntries(routeKeys.filter(k=>c[k]!=null).map(k=>[k,Number(c[k])])),source_platform,source_store,status,
      governed_alias_collection_ids:generic||!c.collaboration_name?[]:catalogue.filter(x=>x.collection_id!==c.collection_id&&x.collaboration_name===c.collaboration_name).map(x=>x.collection_id)};
  });
}
