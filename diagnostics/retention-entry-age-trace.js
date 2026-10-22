import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations,auditExecutionOptions} from '../oracle/cohort-execution.js';
import {retentionMappingReviewSql} from './retention-mapping-review.js';
// Explicit diagnostic subjects, not a report cohort whitelist. Resolve names
// through the current governed collection decisions, never through title tokens.
export const ageTraceCollectionIds=['657969971527','658016338247'];
export const ageTraceStages=['governed_product_history','sku_candidate_history_not_governed','eligible_sku_candidates_not_governed','consumed_named_history','eligible_named_purchases','excluded_import','excluded_cancelled','excluded_after_cutoff','excluded_status','excluded_total_or_refund','excluded_other','identity_matched','identity_unmatched','identity_ambiguous','identity_unavailable_or_absent','first_observed_named_purchase','earlier_entry_other_order','first_observed_before_scope','first_observed_in_scope_any_product','entry_collaboration_members','age_qualified_90','age_qualified_180','age_qualified_360','age_excluded_360','observed_repeat_360','age_qualified_repeat_360'];
export function entryAgeTraceCtes(){return `trace_collaboration_groups AS (
 SELECT DISTINCT collection_id FROM cr_collection_current
 WHERE classification_type='collection_group' AND classification_value='collaboration' AND status='active'
 ), trace_governed_names AS (
 SELECT c.collection_id,c.classification_value collaboration_name,c.collection_title display_name
 FROM cr_collection_current c JOIN trace_collaboration_groups g USING(collection_id)
 WHERE c.classification_type='collaboration_name' AND c.status='active'
 ), trace_targets AS (
 SELECT id collection_id,c.collaboration_name,c.display_name
 FROM UNNEST(@trace_collection_ids) id LEFT JOIN trace_governed_names c ON c.collection_id=id
 ), trace_current_members AS (
 SELECT t.collection_id,CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(pc.product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) source_ref
 FROM trace_targets t JOIN trace_product_collections pc ON CAST(pc.collection_id AS STRING)=t.collection_id
 ), trace_refs AS (
 SELECT collection_id,source_ref FROM trace_current_members
 UNION DISTINCT SELECT m.collection_id,r.source_ref FROM trace_current_members m JOIN cr_routes r ON r.classification_ref=m.source_ref
 UNION DISTINCT SELECT t.collection_id,c.subject_ref FROM trace_targets t JOIN cr_resolved c ON c.classification_type='collaboration_name' AND c.classification_value=t.collaboration_name
 ), trace_candidates AS (
 SELECT DISTINCT m.collection_id,s.source_ref FROM trace_refs m JOIN targets p ON p.product_ref=m.source_ref JOIN skus s ON s.sku=p.sku
 LEFT JOIN trace_refs existing ON existing.collection_id=m.collection_id AND existing.source_ref=s.source_ref
 WHERE s.sku IS NOT NULL AND existing.source_ref IS NULL
 ), trace_named_lines AS (
 SELECT DISTINCT t.collection_id,c.source_platform,c.source_store,c.order_ref,c.source_product_ref
 FROM line_classification_sets c CROSS JOIN UNNEST(c.names) name JOIN trace_targets t ON t.collaboration_name=name
 WHERE c.collaboration_state='named'
 ), trace_named_orders AS (
 SELECT DISTINCT collection_id,source_platform,source_store,order_ref FROM trace_named_lines
 ), trace_history AS (
 SELECT DISTINCT r.collection_id,l.source_product_ref,o.*,
 q.governed_customer_ref,first_order.order_timestamp first_entry_timestamp,
 named.source_product_ref IS NOT NULL named_consumed,
 m.resolution identity_resolution,q.order_sequence,first_order.order_ref first_order_ref,
 first_order.source_platform first_source_platform,first_order.source_store first_source_store,
 r.candidate_only,
 first_named.order_ref IS NOT NULL first_order_named_consumed
 FROM (SELECT *,FALSE candidate_only FROM trace_refs UNION ALL SELECT *,TRUE candidate_only FROM trace_candidates) r
 JOIN source_lines l ON l.source_product_ref=r.source_ref JOIN orders o USING(source_platform,source_store,order_ref)
 LEFT JOIN ranked_orders q USING(source_platform,source_store,order_ref)
 LEFT JOIN ranked_orders first_order ON first_order.governed_customer_ref=q.governed_customer_ref AND first_order.order_sequence=1
 LEFT JOIN ci_mapping m ON m.source_store=o.source_store AND m.source_order_id=o.order_ref
 LEFT JOIN trace_named_lines named ON named.collection_id=r.collection_id AND named.source_platform=l.source_platform AND named.source_store=l.source_store AND named.order_ref=l.order_ref AND named.source_product_ref=l.source_product_ref
 LEFT JOIN trace_named_orders first_named ON first_named.collection_id=r.collection_id AND first_named.source_platform=first_order.source_platform AND first_named.source_store=first_order.source_store AND first_named.order_ref=first_order.order_ref
 ), trace_events AS (
 SELECT h.*,stage FROM trace_history h CROSS JOIN UNNEST([
 IF(candidate_only,'sku_candidate_history_not_governed','governed_product_history'),
 IF(candidate_only AND governed_customer_ref IS NOT NULL,'eligible_sku_candidates_not_governed',NULL),
 IF(NOT candidate_only AND named_consumed,'consumed_named_history',NULL),
 IF(NOT candidate_only AND named_consumed AND governed_customer_ref IS NOT NULL,'eligible_named_purchases',NULL),
 IF(NOT candidate_only AND named_consumed AND governed_customer_ref IS NULL,
 CASE WHEN migrated THEN 'excluded_import' WHEN cancelled THEN 'excluded_cancelled'
 WHEN DATE(order_timestamp,@time_zone)>@observation_end THEN 'excluded_after_cutoff'
 WHEN NOT COALESCE((source_platform='woo' AND status IN ('completed','processing')) OR (source_platform='shopify' AND status IN ('paid','partially_paid','partially_refunded')),FALSE) THEN 'excluded_status'
 WHEN COALESCE(order_total,0)<=COALESCE(refunds,0) THEN 'excluded_total_or_refund' ELSE 'excluded_other' END,NULL),
 IF(NOT candidate_only AND named_consumed AND governed_customer_ref IS NOT NULL,CASE identity_resolution WHEN 'matched' THEN 'identity_matched' WHEN 'unmatched' THEN 'identity_unmatched' WHEN 'ambiguous' THEN 'identity_ambiguous' ELSE 'identity_unavailable_or_absent' END,NULL),
 IF(NOT candidate_only AND named_consumed AND order_sequence=1,'first_observed_named_purchase',NULL),
 IF(NOT candidate_only AND named_consumed AND order_sequence>1 AND NOT first_order_named_consumed,'earlier_entry_other_order',NULL),
 IF(NOT candidate_only AND named_consumed AND DATE(first_entry_timestamp,@time_zone)<@cohort_entry_start,'first_observed_before_scope',NULL),
 IF(NOT candidate_only AND named_consumed AND DATE(first_entry_timestamp,@time_zone) BETWEEN @cohort_entry_start AND @cohort_entry_end,'first_observed_in_scope_any_product',NULL)
 ]) stage WHERE stage IS NOT NULL
 ), trace_members AS (
 SELECT t.collection_id,m.* FROM trace_targets t JOIN retention_members m ON m.collaboration_name=t.collaboration_name
 ), trace_member_events AS (
 SELECT collection_id,source_store,source_platform,entry_timestamp order_timestamp,entry_timestamp first_entry_timestamp,governed_customer_ref,stage
 FROM trace_members CROSS JOIN UNNEST([
 IF(window_days=360,'entry_collaboration_members',NULL),
 IF(provisional_eligible,CONCAT('age_qualified_',CAST(window_days AS STRING)),NULL),
 IF(window_days=360 AND NOT provisional_eligible,'age_excluded_360',NULL),
 IF(window_days=360 AND days_to_second IS NOT NULL,'observed_repeat_360',NULL),
 IF(window_days=360 AND provisional_eligible AND days_to_second IS NOT NULL,'age_qualified_repeat_360',NULL)
 ]) stage WHERE stage IS NOT NULL
 ), trace_route_arrays AS (
 SELECT source_ref,ARRAY_AGG(STRUCT(classification_ref,mapping_type) ORDER BY classification_ref,mapping_type LIMIT 20) approved_routes
 FROM cr_routes GROUP BY source_ref
 ), trace_product_totals AS (
 SELECT collection_id,source_store,source_product_ref,candidate_only,
 COUNT(DISTINCT order_ref) observed_orders,COUNT(DISTINCT governed_customer_ref) eligible_linked_customers,
 MIN(DATE(order_timestamp,@time_zone)) earliest_purchase_date,MAX(DATE(order_timestamp,@time_zone)) latest_purchase_date,
 COUNTIF(named_consumed) named_line_order_rows
 FROM trace_history GROUP BY collection_id,source_store,source_product_ref,candidate_only
 ), trace_product_rows AS (
 SELECT p.*,IFNULL(r.approved_routes,[]) approved_routes,COUNT(*) OVER() total_product_rows
 FROM trace_product_totals p LEFT JOIN trace_route_arrays r ON r.source_ref=p.source_product_ref
 )`;}
export function entryAgeTraceSql(project){
 if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
 const identity={dataset:'customer_identity',snapshot:'history-20261022-billing-v3',orderLinks:true};
 const all=cohortRelations(customerJourneySql(project,'retention_windows',null,null,identity)).relations;
 const end=all.findIndex(r=>r.name==='retention_members');
 const needed=all.slice(0,end+1);
 const sku=cohortRelations(retentionMappingReviewSql(project)).relations.filter(r=>['skus','targets'].includes(r.name));
 return 'WITH '+[...needed,...sku].map(r=>`${r.name} AS (${r.body})`).join(',\n')+`, trace_product_collections AS (SELECT collection_id,product_id FROM \`${project}.shopify_catalogue.product_collections\`),`+entryAgeTraceCtes()+` SELECT
 ARRAY(SELECT AS STRUCT * FROM trace_targets ORDER BY collection_id) targets,
 ARRAY(SELECT AS STRUCT t.collection_id,t.display_name,t.collaboration_name,g.stage,g.source_store,
 IF(t.collaboration_name IS NULL,'target_governance_unavailable','observed_warehouse_only') evidence_status,
 IF(t.collaboration_name IS NULL,NULL,COUNT(DISTINCT e.purchase_ref)) observed_orders,IF(t.collaboration_name IS NULL,NULL,COUNT(DISTINCT e.governed_customer_ref)) eligible_linked_customers,
 COUNT(DISTINCT IF(e.source_customer_id IS NOT NULL AND e.source_customer_id NOT IN ('','0'),CONCAT(e.source_store,':',e.source_customer_id),NULL)) source_local_registered_profiles,
 MIN(DATE(e.order_timestamp,@time_zone)) earliest_purchase_date,MAX(DATE(e.order_timestamp,@time_zone)) latest_purchase_date,
 MIN(DATE(e.first_entry_timestamp,@time_zone)) earliest_first_observed_entry_date,MAX(DATE(e.first_entry_timestamp,@time_zone)) latest_first_observed_entry_date
 FROM trace_targets t CROSS JOIN (SELECT stage,source_store FROM UNNEST(@trace_stages) stage CROSS JOIN UNNEST(['combined','ww','usd','shopify']) source_store) g
 LEFT JOIN (SELECT collection_id,source_store,source_platform,stage,CONCAT(source_platform,':',source_store,':',order_ref) purchase_ref,order_timestamp,first_entry_timestamp,governed_customer_ref,source_customer_id FROM trace_events
 UNION ALL SELECT collection_id,source_store,source_platform,stage,CONCAT('entry:',governed_customer_ref),order_timestamp,first_entry_timestamp,governed_customer_ref,CAST(NULL AS STRING) source_customer_id FROM trace_member_events) e ON e.collection_id=t.collection_id AND e.stage=g.stage AND (g.source_store='combined' OR g.source_store=e.source_store)
 GROUP BY t.collection_id,t.display_name,t.collaboration_name,g.stage,g.source_store ORDER BY t.collection_id,g.stage,g.source_store) stage_counts,
 ARRAY(SELECT AS STRUCT * FROM trace_product_rows ORDER BY observed_orders DESC,collection_id,source_product_ref LIMIT 201) product_routes`;
}
// Reviewed script allowance: 10 input CTAS + result CTAS + final SELECT.
// Keep the shared 500 MB statement cap and all timeouts unchanged.
export function entryAgeTraceSettings(project){
 return {...auditExecutionOptions(entryAgeTraceSql(project),['orders','cr_routes','cr_collection_current','cr_resolved','classified_lines','retention_reporting_lines','line_classification_sets','ranked_orders','entry_matches','retention_members'],50000),maximumBytesBilled:'6000000000',location:'US',useLegacySql:false,
 params:{trace_collection_ids:ageTraceCollectionIds,trace_stages:ageTraceStages,cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',entry_source:null,entry_channel:null,entry_product_ref:null,entry_classification:'collaboration',retention_source_store:null,first_order_semantic:'first_observed_ever',matrixify_app_id:'gid://shopify/App/1758145',coverage_status:'unverified',coverage_start:null,coverage_end:null,coverage_evidence:null,minimum_sequence:2,maximum_sequence:null,within_days:null,subsequent_source:null,subsequent_channel:null},
 types:{trace_collection_ids:['STRING'],trace_stages:['STRING'],cohort_entry_start:'DATE',cohort_entry_end:'DATE',observation_end:'DATE',coverage_start:'DATE',coverage_end:'DATE',coverage_evidence:'STRING',entry_source:'STRING',entry_channel:'STRING',entry_product_ref:'STRING',retention_source_store:'STRING',maximum_sequence:'INT64',within_days:'INT64',subsequent_source:'STRING',subsequent_channel:'STRING'}};
}
