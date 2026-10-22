import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';
// Transaction-derived inventory includes archived products: no live/publication
// status filter. A proposal is evidence for review, never an approval.
export function retentionMappingReviewSql(project){
 const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 const {relations}=cohortRelations(customerJourneySql(project,'retention_windows',null,null,identity));
 const end=relations.findIndex(r=>r.name==='entry_matches');
 return 'WITH '+relations.slice(0,end+1).map(r=>`${r.name} AS (${r.body})`).join(',\n')+`, impacts AS (
 SELECT l.source_product_ref,l.source_product_id,MIN(l.product_title) woo_title,l.source_store,
 COUNT(DISTINCT IF(DATE(q.order_timestamp,@time_zone)>=@cohort_entry_start,q.order_ref,NULL)) affected_orders,COUNT(DISTINCT IF(DATE(q.order_timestamp,@time_zone)>=@cohort_entry_start,q.governed_customer_ref,NULL)) affected_customers,
 COUNT(DISTINCT q.order_ref) historical_eligible_orders,
 LOGICAL_OR(EXISTS(SELECT 1 FROM UNNEST(l.classifications) c WHERE STARTS_WITH(c,'collaboration_name=') AND c NOT IN ('collaboration_name=collaboration','collaboration_name=collaborations')) AND 'classification_conflict=true' NOT IN UNNEST(l.classifications)) named_classification_consumed,
 ARRAY_AGG(DISTINCT l.family_status) routing_states
 FROM retention_reporting_lines l JOIN qualifying_orders q USING(source_platform,source_store,order_ref)
 WHERE l.source_platform='woo' AND DATE(q.order_timestamp,@time_zone)<=@observation_end
 AND l.source_product_id IS NOT NULL AND l.source_product_id NOT IN ('','0','unknown')
 AND NOT (('product_group=core' IN UNNEST(l.classifications) OR 'product_group=core_range' IN UNNEST(l.classifications)) AND 'classification_conflict=true' NOT IN UNNEST(l.classifications))

 GROUP BY l.source_product_ref,l.source_product_id,l.source_store
 ), skus AS (
 SELECT CONCAT('woo:ww:',CAST(product_id AS STRING)) source_ref,NULLIF(UPPER(TRIM(sku)),'') sku FROM \`${project}.metorik_uk.order_line_items\`
 UNION DISTINCT SELECT CONCAT('woo:usd:',CAST(product_id AS STRING)),NULLIF(UPPER(TRIM(sku)),'') FROM \`${project}.metorik_us.order_line_items\`
 ), targets AS (
 SELECT DISTINCT CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) product_ref,
 COALESCE(title,name) title,NULLIF(UPPER(TRIM(sku)),'') sku FROM \`${project}.shopify_data.order_line_items\`
 ), review_routes AS (
 SELECT source_ref,ARRAY_AGG(STRUCT(classification_ref AS target_ref,mapping_type) ORDER BY classification_ref,mapping_type LIMIT 20) approved_routes
 FROM cr_routes GROUP BY source_ref
 ), review_conflicts AS (
 SELECT subject_ref,ARRAY_AGG(DISTINCT classification_type ORDER BY classification_type) classification_conflicts
 FROM cr_conflicts GROUP BY subject_ref
 ), review_names AS (
 SELECT subject_ref,ARRAY_AGG(DISTINCT classification_value ORDER BY classification_value) governed_collaborations,
 COUNTIF(classification_value NOT IN ('collaboration','collaborations'))>0 has_named
 FROM cr_resolved WHERE classification_type='collaboration_name' GROUP BY subject_ref
 ), review_families AS (
 SELECT classification_ref,ARRAY_AGG(DISTINCT classification_ref) existing_reporting_families
 FROM cr_family GROUP BY classification_ref
 ), review_candidate_pairs AS (
 SELECT s.source_ref,t.product_ref,MIN(t.title) title,ARRAY_AGG(DISTINCT s.sku ORDER BY s.sku) exact_skus
 FROM skus s JOIN targets t USING(sku) WHERE s.sku IS NOT NULL AND t.product_ref IS NOT NULL GROUP BY s.source_ref,t.product_ref
 ), review_candidates AS (
 SELECT p.source_ref,ARRAY_AGG(STRUCT(p.product_ref,p.title,p.exact_skus,n.governed_collaborations,IFNULL(f.existing_reporting_families,[]) AS existing_reporting_families) ORDER BY p.product_ref LIMIT 11) candidates
 FROM review_candidate_pairs p JOIN review_names n ON n.subject_ref=p.product_ref AND n.has_named
 LEFT JOIN review_families f ON f.classification_ref=p.product_ref GROUP BY p.source_ref
 ), review AS (
 SELECT i.*,IFNULL(r.approved_routes,[]) approved_routes,IFNULL(f.classification_conflicts,[]) classification_conflicts,IFNULL(c.candidates,[]) candidates
 FROM impacts i LEFT JOIN review_routes r ON r.source_ref=i.source_product_ref
 LEFT JOIN review_conflicts f ON f.subject_ref=i.source_product_ref LEFT JOIN review_candidates c ON c.source_ref=i.source_product_ref
 WHERE NOT i.named_classification_consumed OR 'ambiguous_family' IN UNNEST(i.routing_states) OR (i.named_classification_consumed AND 'unmapped_item' IN UNNEST(i.routing_states))
 ) SELECT *,COUNT(*) OVER() total_review_products,
 IF(named_classification_consumed,'named_classification_consumed_product_route_missing',IF(ARRAY_LENGTH(candidates)=1,'exact_sku_candidate_requires_graph_preview',IF(ARRAY_LENGTH(candidates)>1,'conflicting_exact_sku_candidates','no_supported_target_missing_mapping_or_history'))) review_status,
 IF(ARRAY_LENGTH(approved_routes)>0,'inspect_existing_route_or_classification_conflict',IF(ARRAY_LENGTH(candidates)=1,'preview_identity_or_reporting_family_then_review',IF(ARRAY_LENGTH(candidates)>1,'resolve_conflicting_candidates_in_product_mapping','retain_unattributed_request_product_key_evidence'))) required_governance_action
 FROM review ORDER BY affected_customers DESC,affected_orders DESC,source_product_ref LIMIT 501`;
}
export function mappingReviewList(rows){
 return {read_only:true,governance_written:false,ranked_by:'affected eligible analytical customer records',truncated:rows.length>500||Number(rows[0]?.total_review_products)>500,
 items:rows.slice(0,500).map(r=>({...r,proposed_target:r.candidates?.length===1?r.candidates[0].product_ref:null,
 supporting_evidence:r.candidates?.length?'Case/whitespace-normalized persisted SKU; corroboration and existing Product Mapping/Product Families graph preview still required.':'No supported target found in this bounded SKU evidence. No title-derived relationship proposed.',
 conflicts:[...(r.classification_conflicts||[]),...(r.candidates?.length>1?['Multiple Shopify parents share persisted SKU evidence']:[]),...(r.candidates?.length===1&&(r.approved_routes||[]).some(x=>x.target_ref!==r.candidates[0].product_ref)?['Existing approved target differs from SKU candidate; inspect identity versus reporting-family relationship in graph preview']:[])],
 required_governance_action:r.required_governance_action||'inspect_existing_route_or_request_missing_product_key_evidence',
 limitation:'Missing route does not establish that the collaboration was not sold. Counts overlap across products; archived products remain eligible. Use existing review workflow before any new decision.'}))};
}
