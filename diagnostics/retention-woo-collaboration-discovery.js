import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations,auditExecutionOptions} from '../oracle/cohort-execution.js';
export function wooCollaborationDiscoverySql(project,store){
 if(!/^[A-Za-z0-9_-]+$/.test(project)||!['ww','usd'].includes(store))throw Error('Invalid discovery source');
 const dataset=store==='ww'?'metorik_uk':'metorik_us',table=name=>`\`${project}.${dataset}.${name}\``;
 const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 const all=cohortRelations(customerJourneySql(project,'retention_windows',null,null,identity)).relations;
 const end=all.findIndex(r=>r.name==='entry_matches');
 return 'WITH '+all.slice(0,end+1).map(r=>`${r.name} AS (${r.body})`).join(',\n')+`, discovery_catalogue AS (
 SELECT g.collection_id,COALESCE(n.collection_title,c.title,g.collection_title) display_name,n.classification_value collaboration_name,c.product_count current_product_count
 FROM cr_collection_current g JOIN \`${project}.shopify_catalogue.collections\` c ON CAST(c.collection_id AS STRING)=g.collection_id
 JOIN cr_collection_current n ON n.collection_id=g.collection_id AND n.classification_type='collaboration_name' AND n.status='active'
 WHERE g.classification_type='collection_group' AND g.status='active' AND g.classification_value='collaboration' AND n.classification_value NOT IN ('collaboration','collaborations')
 ), discovery_target_refs AS (
 SELECT DISTINCT t.collection_id,CONCAT('shopify:shopify:',CAST(p.product_id AS STRING)) target_ref
 FROM discovery_catalogue t JOIN \`${project}.shopify_catalogue.product_collections\` p ON CAST(p.collection_id AS STRING)=t.collection_id
 UNION DISTINCT SELECT t.collection_id,c.subject_ref FROM discovery_catalogue t JOIN cr_resolved c ON c.classification_value=t.collaboration_name AND c.classification_type='collaboration_name' WHERE STARTS_WITH(c.subject_ref,'shopify:shopify:')
 ), discovery_shopify_titles AS (
 SELECT CONCAT('shopify:shopify:',CAST(product_id AS STRING)) target_ref,title FROM \`${project}.shopify_catalogue.products\`
 UNION ALL SELECT CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')),COALESCE(title,name) FROM \`${project}.shopify_data.order_line_items\`
 ), discovery_target_rows AS (
 SELECT r.collection_id,r.target_ref,MIN(t.title) title FROM discovery_target_refs r LEFT JOIN discovery_shopify_titles t USING(target_ref) GROUP BY r.collection_id,r.target_ref
 ), discovery_target_arrays AS (
 SELECT collection_id,ARRAY_AGG(STRUCT(target_ref,title) ORDER BY target_ref) shopify_review_context FROM discovery_target_rows GROUP BY collection_id
 ), discovery_target_skus AS (
 SELECT DISTINCT CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) target_ref,NULLIF(UPPER(TRIM(sku)),'') sku FROM \`${project}.shopify_data.order_line_items\`
 ), discovery_raw_lines AS (
 SELECT DISTINCT CAST(order_id AS STRING) order_ref,CAST(line_item_id AS STRING) line_item_id,CAST(product_id AS STRING) product_id,NULLIF(CAST(variation_id AS STRING),'0') variation_id,name title,sku,ring_size,order_created_at
 FROM ${table('order_line_items')}
 ), discovery_line_facts AS (
 SELECT l.*,o.order_timestamp,q.governed_customer_ref,q.order_ref IS NOT NULL eligible,o.order_ref IS NULL order_evidence_missing
 FROM discovery_raw_lines l LEFT JOIN orders o ON o.source_store='${store}' AND o.source_platform='woo' AND o.order_ref=l.order_ref
 LEFT JOIN qualifying_orders q ON q.source_store='${store}' AND q.source_platform='woo' AND q.order_ref=l.order_ref
 WHERE COALESCE(o.order_timestamp,l.order_created_at) IS NULL OR DATE(COALESCE(o.order_timestamp,l.order_created_at),@time_zone)<=@observation_end
 ), discovery_woo_records AS (
 SELECT CAST(product_id AS STRING) product_id,CAST(NULL AS STRING) variation_id,title,sku,status,CAST(NULL AS STRING) attributes_json,CAST(NULL AS STRING) ring_size,'current_catalogue_product' evidence_source FROM ${table('products')}
 UNION ALL SELECT CAST(product_id AS STRING),CAST(variation_id AS STRING),name,sku,CAST(NULL AS STRING),attributes_json,CAST(NULL AS STRING),'current_catalogue_variation' FROM ${table('product_variations')}
 UNION ALL SELECT DISTINCT product_id,variation_id,title,sku,CAST(NULL AS STRING),CAST(NULL AS STRING),ring_size,'historical_order_line' FROM discovery_line_facts
 ), discovery_woo_products AS (
 SELECT product_id,CONCAT('woo:${store}:',product_id) source_ref,
 ARRAY_AGG(DISTINCT title IGNORE NULLS ORDER BY title LIMIT 31) titles,
 ARRAY_AGG(DISTINCT NULLIF(UPPER(TRIM(sku)),'') IGNORE NULLS LIMIT 51) persisted_skus,
 COUNTIF(evidence_source='current_catalogue_product')>0 current_catalogue_present,
 LOGICAL_OR(REGEXP_CONTAINS(LOWER(COALESCE(title,'')),r'iron[ -]*maiden|eddie|powerslave|book[ -]*of[ -]*souls|killers')) iron_title_lead,
 LOGICAL_OR(REGEXP_CONTAINS(LOWER(COALESCE(title,'')),r'mot[oö]rhead')) motorhead_title_lead,
 ARRAY_AGG(DISTINCT status IGNORE NULLS) current_catalogue_statuses,
 ARRAY_AGG(STRUCT(variation_id,title,sku,status,attributes_json,ring_size,evidence_source) ORDER BY evidence_source,variation_id,title LIMIT 101) listing_records,
 COUNT(*) listing_evidence_records
 FROM discovery_woo_records WHERE product_id IS NOT NULL AND product_id NOT IN ('','0') GROUP BY product_id
 ), discovery_source_skus AS (
 SELECT DISTINCT CONCAT('woo:${store}:',product_id) source_ref,NULLIF(UPPER(TRIM(sku)),'') sku FROM discovery_woo_records WHERE product_id IS NOT NULL AND product_id NOT IN ('','0')
 ), discovery_sales AS (
 SELECT product_id,COUNT(DISTINCT order_ref) recorded_orders,COUNT(DISTINCT CONCAT(order_ref,':',line_item_id)) recorded_order_lines,
 COUNT(DISTINCT IF(eligible,order_ref,NULL)) eligible_orders,COUNT(DISTINCT IF(eligible,governed_customer_ref,NULL)) eligible_customers,
 COUNT(DISTINCT IF(eligible AND DATE(order_timestamp,@time_zone)>=@cohort_entry_start,order_ref,NULL)) scope_eligible_orders,
 COUNT(DISTINCT IF(eligible AND DATE(order_timestamp,@time_zone)>=@cohort_entry_start,governed_customer_ref,NULL)) scope_eligible_customers,
 COUNTIF(order_evidence_missing) lines_missing_order_evidence,COUNTIF(COALESCE(order_timestamp,order_created_at) IS NULL) lines_missing_dates,
 MIN(DATE(COALESCE(order_timestamp,order_created_at),@time_zone)) earliest_recorded_order,MAX(DATE(COALESCE(order_timestamp,order_created_at),@time_zone)) latest_recorded_order,
 ARRAY_AGG(STRUCT(order_ref,line_item_id,variation_id,ring_size,eligible,order_evidence_missing) ORDER BY order_ref,line_item_id LIMIT 21) order_line_references
 FROM discovery_line_facts GROUP BY product_id
 ), discovery_evidence AS (
 SELECT DISTINCT t.collection_id,w.source_ref,CAST(NULL AS STRING) target_ref,'persisted_named_classification' evidence_kind,CAST(NULL AS STRING) matched_sku
 FROM discovery_woo_products w JOIN cr_evidence c ON c.subject_ref=w.source_ref JOIN discovery_catalogue t ON t.collaboration_name=c.classification_value WHERE c.classification_type='collaboration_name'
 UNION DISTINCT SELECT t.collection_id,r.source_ref,r.classification_ref,r.mapping_type,CAST(NULL AS STRING)
 FROM discovery_target_refs t JOIN cr_routes r ON r.classification_ref=t.target_ref JOIN discovery_woo_products w ON w.source_ref=r.source_ref
 UNION DISTINCT SELECT t.collection_id,s.source_ref,t.target_ref,'persisted_exact_sku',s.sku
 FROM discovery_source_skus s JOIN discovery_target_skus p USING(sku) JOIN discovery_target_refs t ON t.target_ref=p.target_ref WHERE s.sku IS NOT NULL
 UNION DISTINCT SELECT t.collection_id,w.source_ref,CAST(NULL AS STRING),'title_lead_only_manual_review',CAST(NULL AS STRING)
 FROM discovery_woo_products w JOIN discovery_catalogue t ON
 (t.collection_id='658016338247' AND w.iron_title_lead)
 OR (t.collection_id='657969971527' AND w.motorhead_title_lead)
 ), discovery_evidence_arrays AS (
 SELECT collection_id,source_ref,ARRAY_AGG(STRUCT(target_ref,evidence_kind,matched_sku) ORDER BY evidence_kind,target_ref LIMIT 101) evidence,
 ARRAY_AGG(DISTINCT IF(evidence_kind='persisted_exact_sku',target_ref,NULL) IGNORE NULLS) sku_targets,
 COUNTIF(evidence_kind IN ('approved_identity','approved_reporting_family'))>0 approved_route_present,
 COUNT(*) evidence_records
 FROM discovery_evidence GROUP BY collection_id,source_ref
 ), discovery_decision_rows AS (
 SELECT left_ref source_ref,right_ref other_ref,status,reviewed_at,resolved_decision_id decision_id,'identity' decision_type,supersedes_decision_id FROM cr_map_history
 UNION ALL SELECT right_ref,left_ref,status,reviewed_at,resolved_decision_id,'identity',supersedes_decision_id FROM cr_map_history
 UNION ALL SELECT source_ref,shopify_parent_ref,status,reviewed_at,resolved_decision_id,'reporting_family',supersedes_decision_id FROM cr_family_history
 ), discovery_decisions AS (
 SELECT source_ref,ARRAY_AGG(STRUCT(other_ref,status,reviewed_at,decision_id,decision_type,supersedes_decision_id) ORDER BY reviewed_at DESC,decision_id LIMIT 51) existing_decisions,COUNT(*) decision_records FROM discovery_decision_rows GROUP BY source_ref
 ), discovery_conflicts AS (
 SELECT subject_ref,ARRAY_AGG(DISTINCT classification_type) classification_conflicts FROM cr_conflicts GROUP BY subject_ref
 ), discovery_review AS (
 SELECT e.collection_id,t.display_name,t.collaboration_name,'${store}' source_store,w.*,IFNULL(e.sku_targets,[]) sku_targets,e.evidence,e.evidence_records,e.approved_route_present,
 IFNULL(c.classification_conflicts,[]) classification_conflicts,IFNULL(d.existing_decisions,[]) existing_decisions,IFNULL(d.decision_records,0) decision_records,
 IFNULL(s.recorded_orders,0) recorded_orders,IFNULL(s.recorded_order_lines,0) recorded_order_lines,IFNULL(s.eligible_orders,0) eligible_orders,IFNULL(s.eligible_customers,0) eligible_customers,
 IFNULL(s.scope_eligible_orders,0) scope_eligible_orders,IFNULL(s.scope_eligible_customers,0) scope_eligible_customers,
 IFNULL(s.lines_missing_order_evidence,0) lines_missing_order_evidence,IFNULL(s.lines_missing_dates,0) lines_missing_dates,
 s.earliest_recorded_order,s.latest_recorded_order,IFNULL(s.order_line_references,[]) order_line_references
 FROM discovery_evidence_arrays e JOIN discovery_woo_products w USING(source_ref) JOIN discovery_catalogue t USING(collection_id)
 LEFT JOIN discovery_sales s USING(product_id) LEFT JOIN discovery_conflicts c ON c.subject_ref=w.source_ref LEFT JOIN discovery_decisions d ON d.source_ref=w.source_ref
 ), discovery_ranked AS (
 SELECT *,ROW_NUMBER() OVER(PARTITION BY collection_id ORDER BY scope_eligible_customers DESC,eligible_customers DESC,recorded_orders DESC,source_ref) review_rank,
 COUNT(*) OVER(PARTITION BY collection_id) collaboration_candidate_products FROM discovery_review
 ), discovery_summary AS (
 SELECT collection_id,COUNT(*) candidate_products,COUNTIF(current_catalogue_present) current_catalogue_products,COUNTIF(recorded_orders>0) products_with_recorded_orders,COUNTIF(eligible_orders>0) products_with_eligible_sales,COUNTIF(approved_route_present) products_with_approved_routes FROM discovery_review GROUP BY collection_id
 ) SELECT
 ARRAY(SELECT AS STRUCT t.*, '${store}' source_store,IFNULL(p.shopify_review_context,[]) shopify_review_context,
 IFNULL(s.candidate_products,0) candidate_products,IFNULL(s.current_catalogue_products,0) current_catalogue_products,IFNULL(s.products_with_recorded_orders,0) products_with_recorded_orders,IFNULL(s.products_with_eligible_sales,0) products_with_eligible_sales,IFNULL(s.products_with_approved_routes,0) products_with_approved_routes,
 IF(s.collection_id IS NULL,'historical_source_keys_or_crosswalk_not_found_no_absence_conclusion','review_candidates_not_approved_relationships') evidence_status
 FROM discovery_catalogue t LEFT JOIN discovery_summary s USING(collection_id) LEFT JOIN discovery_target_arrays p USING(collection_id)
 ORDER BY IF(t.collection_id IN ('658016338247','657969971527'),0,1),t.display_name) catalogue,
 ARRAY(SELECT AS STRUCT * FROM discovery_ranked WHERE review_rank<=201 ORDER BY IF(collection_id IN ('658016338247','657969971527'),0,1),collection_id,review_rank) review_rows,
 ARRAY(SELECT AS STRUCT order_ref,line_item_id,variation_id,title,sku,ring_size FROM discovery_line_facts WHERE (product_id IS NULL OR product_id IN ('','0')) AND REGEXP_CONTAINS(LOWER(COALESCE(title,'')),r'iron[ -]*maiden|eddie|powerslave|book[ -]*of[ -]*souls|killers') ORDER BY order_ref,line_item_id LIMIT 21) unkeyed_iron_maiden_line_leads`;
}
export function wooCollaborationDiscoverySettings(project,store){return {...auditExecutionOptions(wooCollaborationDiscoverySql(project,store),['orders','qualifying_orders','cr_routes','cr_collection_current','cr_resolved','discovery_line_facts','discovery_woo_records'],50000),maximumBytesBilled:'4500000000',location:'US',useLegacySql:false,
 params:{cohort_entry_start:'2022-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',first_order_semantic:'first_observed_ever',matrixify_app_id:'gid://shopify/App/1758145'},types:{cohort_entry_start:'DATE',observation_end:'DATE'}};}
