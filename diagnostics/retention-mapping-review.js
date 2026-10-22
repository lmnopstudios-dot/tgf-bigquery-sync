import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
// Transaction-derived inventory includes archived products: no live/publication
// status filter. A proposal is evidence for review, never an approval.
export function retentionMappingReviewSql(project){
 const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 const {relations}=cohortRelations(customerJourneySql(project,'retention_windows',null,null,identity));
 const end=relations.findIndex(r=>r.name==='retention_reporting_lines');
 return 'WITH '+relations.slice(0,end+1).map(r=>`${r.name} AS (${r.body})`).join(',\n')+`, impacts AS (
 SELECT l.source_product_ref,l.source_product_id,MIN(l.product_title) woo_title,l.source_store,
 COUNT(DISTINCT q.order_ref) affected_orders,COUNT(DISTINCT q.governed_customer_ref) affected_customers,
 ARRAY_AGG(DISTINCT l.family_status) routing_states
 FROM retention_reporting_lines l JOIN qualifying_orders q USING(source_platform,source_store,order_ref)
 WHERE l.source_platform='woo' AND DATE(q.order_timestamp,@time_zone) BETWEEN @cohort_entry_start AND @observation_end
 AND l.source_product_id IS NOT NULL AND l.source_product_id NOT IN ('','0','unknown')
 AND (l.family_status='ambiguous_family' OR NOT EXISTS(SELECT 1 FROM cr_routes r JOIN cr_resolved c ON c.subject_ref=r.classification_ref
 WHERE r.source_ref=l.source_product_ref AND c.classification_type='collaboration_name' AND c.classification_value NOT IN ('collaboration','collaborations')))
 GROUP BY l.source_product_ref,l.source_product_id,l.source_store
 ), skus AS (
 SELECT CONCAT('woo:ww:',CAST(product_id AS STRING)) source_ref,NULLIF(UPPER(TRIM(sku)),'') sku FROM \`${project}.metorik_uk.order_line_items\`
 UNION DISTINCT SELECT CONCAT('woo:usd:',CAST(product_id AS STRING)),NULLIF(UPPER(TRIM(sku)),'') FROM \`${project}.metorik_us.order_line_items\`
 ), targets AS (
 SELECT DISTINCT CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) product_ref,
 COALESCE(title,name) title,NULLIF(UPPER(TRIM(sku)),'') sku FROM \`${project}.shopify_data.order_line_items\`
 ), review AS (
 SELECT i.*,ARRAY(SELECT AS STRUCT r.classification_ref target_ref,r.mapping_type FROM cr_routes r WHERE r.source_ref=i.source_product_ref ORDER BY target_ref,mapping_type LIMIT 20) approved_routes,ARRAY(SELECT DISTINCT c.classification_type FROM cr_conflicts c WHERE c.subject_ref=i.source_product_ref) classification_conflicts,ARRAY(SELECT AS STRUCT t.product_ref,MIN(t.title) title,ARRAY_AGG(DISTINCT s.sku) exact_skus,
 ARRAY(SELECT DISTINCT c.classification_value FROM cr_resolved c WHERE c.subject_ref=t.product_ref AND c.classification_type='collaboration_name') governed_collaborations
 FROM skus s JOIN targets t USING(sku) WHERE s.source_ref=i.source_product_ref AND s.sku IS NOT NULL AND t.product_ref IS NOT NULL GROUP BY t.product_ref ORDER BY t.product_ref LIMIT 11) candidates
 FROM impacts i
 ) SELECT *,COUNT(*) OVER() total_review_products,
 IF(ARRAY_LENGTH(candidates)=1,'exact_sku_candidate_requires_graph_preview',IF(ARRAY_LENGTH(candidates)>1,'conflicting_exact_sku_candidates','no_supported_target_missing_mapping_or_history')) review_status
 FROM review ORDER BY affected_customers DESC,affected_orders DESC,source_product_ref LIMIT 501`;
}
export function mappingReviewList(rows){
 return {read_only:true,governance_written:false,ranked_by:'affected eligible analytical customer records',truncated:rows.length>500||Number(rows[0]?.total_review_products)>500,
 items:rows.slice(0,500).map(r=>({...r,proposed_target:r.candidates?.length===1?r.candidates[0].product_ref:null,
 supporting_evidence:r.candidates?.length?'Exact persisted source SKU; corroboration and existing Product Mapping/Product Families graph preview still required.':'No supported target found in this bounded SKU evidence. No title-derived relationship proposed.',
 conflicts:r.candidates?.length>1?['Multiple Shopify parents share persisted SKU evidence']:[],
 limitation:'Missing route does not establish that the collaboration was not sold. Counts overlap across products; archived products remain eligible. Use existing review workflow before any new decision.'}))};
}
