import {retentionSectionProjection,RETENTION_SHARED_ROW_SQL} from './retention-sections.js';
import {retentionCatalogueSql} from './retention-catalogue.js';
// A combined population is an explicit contract, never a relabelled source sum.
export function isRetentionPopulation(row){
 return row.population_scope==='linked_tgf'
  ? row.source_platform==='tgf'&&row.source_store==='combined'
  : row.population_scope==null&&((row.source_platform==='woo'&&['ww','usd'].includes(row.source_store))||(row.source_platform==='shopify'&&row.source_store==='shopify'));
}
export function combinedRetentionSql(sql,project,group){
 // This projection is downstream of linked first-order assignment. Actual entry
 // and return source keys remain intact for line/classification joins.
 const catalogue=group==='retention_windows'?'ARRAY('+[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source,store])=>`SELECT AS STRUCT '${source}' source_platform,'${store}' source_store,c.* FROM (${retentionCatalogueSql(project,source,store)}) c`).join(' UNION ALL ')+') catalogue_source_reconciliation,':'';
 const breakdown=`${group==='retention_piece_windows'?`IF(${RETENTION_SHARED_ROW_SQL},`:''}ARRAY(SELECT AS STRUCT entry_source_platform source_platform,entry_source_store source_store,collaboration_name,${group==='retention_piece_windows'?'entry_product_ref,':''}window_days,COUNT(*) cohort_customers,COUNTIF(provisional_eligible) provisional_eligible_customers,COUNTIF(provisional_eligible AND days_to_second IS NOT NULL) provisional_repeat_customers FROM retention_members GROUP BY entry_source_platform,entry_source_store,collaboration_name,${group==='retention_piece_windows'?'entry_product_ref,':''}window_days ORDER BY source_platform,source_store,collaboration_name,window_days LIMIT 300)${group==='retention_piece_windows'?',[])':''} entry_platform_rows,`;
 const combined=sql.replace('SELECT em.*,d.source_platform',"SELECT em.* REPLACE('tgf' AS source_platform,'combined' AS source_store),em.source_platform entry_source_platform,em.source_store entry_source_store,d.source_platform")
  .replace('SELECT e.governed_customer_ref,e.source_platform,e.source_store,e.order_timestamp entry_timestamp,',"SELECT e.governed_customer_ref,'tgf' source_platform,'combined' source_store,e.order_timestamp entry_timestamp,")
  // SQL contains $' regex anchors: a replacement string expands them as JS tokens.
  .replace('r.*,IFNULL',()=>catalogue+breakdown+"'linked_tgf' population_scope,r.*,IFNULL")
  ;
 // Tag the exact owned section projection, including * REPLACE. Formatting a
 // projection must not silently remove its linked-population proof.
 return [false,true].reduce((query,baseline)=>[false,true].reduce((text,compact)=>{
  const projection=retentionSectionProjection(baseline,compact);
  return text.replace(projection,()=>projection.replace('SELECT AS STRUCT ',"SELECT AS STRUCT 'linked_tgf' population_scope,"));
 },query),combined);
}
