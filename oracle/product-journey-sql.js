import {PRODUCT_JOURNEY_CONTRACT as CONTRACT} from './product-journey-contract.js';
import {cohortRelations} from './cohort-execution.js';

// Consume the existing eligible, linked, sequenced transaction and approved
// reporting-family relations. Titles label products; they never join identities.
export function productJourneySql(base){
 const {relations}=cohortRelations(base);
 return `WITH ${relations.map(r=>`${r.name} AS (${r.body})`).join(',\n')},
 pj_lines AS (
   SELECT *,source_product_id IS NOT NULL AND source_product_id NOT IN ('','0','unknown') known,
     REGEXP_CONTAINS(LOWER(TRIM(reporting_product_title)),r'^ring sizers?$') OR EXISTS(SELECT 1 FROM UNNEST(classifications) c WHERE c IN ('product_type=ring_sizer','product_type=Ring Sizer')) is_sizer
   FROM retention_reporting_lines
 ), pj_entries AS (
   SELECT DISTINCT e.governed_customer_ref,l.reporting_product_ref product_ref,l.reporting_product_title product,l.family_status,l.is_sizer
   FROM entry_orders e JOIN pj_lines l USING(source_platform,source_store,order_ref) WHERE l.known
 ), pj_entry_counts AS (
   SELECT product_ref,MIN(product) product,MIN(family_status) family_status,LOGICAL_OR(is_sizer) is_sizer,COUNT(DISTINCT governed_customer_ref) entry_customers
   FROM pj_entries GROUP BY product_ref
 ), pj_entry_ranks AS (
   SELECT *,ROW_NUMBER() OVER(PARTITION BY is_sizer ORDER BY entry_customers DESC,product_ref) entry_rank FROM pj_entry_counts
 ), pj_members AS (
   SELECT e.governed_customer_ref,e.order_timestamp entry_timestamp,d.source_platform second_source_platform,d.source_store second_source_store,d.order_ref second_order_ref,
     DATE_DIFF(DATE(d.order_timestamp,@time_zone),DATE(e.order_timestamp,@time_zone),DAY) days_to_second
   FROM entry_orders e LEFT JOIN retention_next_orders d USING(governed_customer_ref)
 ), pj_cohorts AS (
   SELECT m.*,CAST(NULL AS STRING) entry_product_ref,'Overall' entry_product,FALSE entry_is_sizer,0 entry_rank FROM pj_members m
   UNION ALL SELECT m.*,e.product_ref,e.product,e.is_sizer,r.entry_rank FROM pj_members m JOIN pj_entries e USING(governed_customer_ref) JOIN pj_entry_ranks r USING(product_ref)
   WHERE r.entry_rank<=${CONTRACT.entry_products}
 ), pj_windows AS (
   SELECT c.*,window_days,window_days=0 OR DATE_ADD(DATE(entry_timestamp,@time_zone),INTERVAL window_days DAY)<=@observation_end age_eligible,
     window_days>0 AND @coverage_status='verified_continuous' AND DATE(entry_timestamp,@time_zone)>=@coverage_start AND DATE_ADD(DATE(entry_timestamp,@time_zone),INTERVAL window_days DAY)<=LEAST(@observation_end,@coverage_end) verified_eligible,
     second_order_ref IS NOT NULL AND (window_days=0 OR days_to_second<=window_days) returned
   FROM pj_cohorts c CROSS JOIN UNNEST([0,90,180,360]) window_days
 ), pj_totals AS (
   SELECT entry_product_ref,MIN(entry_product) entry_product,LOGICAL_OR(entry_is_sizer) entry_is_sizer,MIN(entry_rank) entry_rank,window_days,
     COUNT(DISTINCT governed_customer_ref) entry_customers,
     COUNT(DISTINCT IF(returned,governed_customer_ref,NULL)) returning_customers,
     COUNT(DISTINCT IF(age_eligible,governed_customer_ref,NULL)) age_eligible_customers,
     COUNT(DISTINCT IF(age_eligible AND returned,governed_customer_ref,NULL)) age_repeat_customers,
     COUNT(DISTINCT IF(verified_eligible,governed_customer_ref,NULL)) verified_customers,
     COUNT(DISTINCT IF(verified_eligible AND returned,governed_customer_ref,NULL)) verified_repeat_customers
   FROM pj_windows GROUP BY entry_product_ref,window_days
   UNION ALL SELECT CAST(NULL AS STRING),'Overall',FALSE,0,window_days,0,0,0,0,0,0 FROM UNNEST([0,90,180,360]) window_days WHERE NOT EXISTS(SELECT 1 FROM pj_members)
 ), pj_product_counts AS (
   SELECT c.entry_product_ref,c.window_days,l.reporting_product_ref product_ref,MIN(l.reporting_product_title) product,MIN(l.family_status) family_status,LOGICAL_OR(l.is_sizer) is_sizer,
     COUNT(DISTINCT c.governed_customer_ref) customers
   FROM pj_windows c JOIN pj_lines l ON l.source_platform=c.second_source_platform AND l.source_store=c.second_source_store AND l.order_ref=c.second_order_ref
   WHERE c.returned AND l.known GROUP BY c.entry_product_ref,c.window_days,l.reporting_product_ref
 ), pj_product_ranks AS (
   SELECT *,ROW_NUMBER() OVER(PARTITION BY entry_product_ref,window_days,is_sizer ORDER BY customers DESC,product_ref) product_rank,
     COUNT(*) OVER(PARTITION BY entry_product_ref,window_days,is_sizer) available_products FROM pj_product_counts
 ), pj_unknown AS (
   SELECT c.entry_product_ref,c.window_days,
     COUNT(DISTINCT IF(c.returned AND l.order_ref IS NULL,c.governed_customer_ref,NULL)) missing_line_customers,
     COUNT(DISTINCT IF(c.returned AND l.order_ref IS NOT NULL AND NOT l.known,c.governed_customer_ref,NULL)) unknown_product_customers
   FROM pj_windows c LEFT JOIN pj_lines l ON l.source_platform=c.second_source_platform AND l.source_store=c.second_source_store AND l.order_ref=c.second_order_ref
   GROUP BY c.entry_product_ref,c.window_days
   UNION ALL SELECT CAST(NULL AS STRING),window_days,0,0 FROM UNNEST([0,90,180,360]) window_days WHERE NOT EXISTS(SELECT 1 FROM pj_members)
 )
 SELECT 1 cohort_rank,CAST(NULL AS INT64) window_days,'linked_tgf' population_scope,
   ARRAY(SELECT AS STRUCT t.*,u.missing_line_customers,u.unknown_product_customers,
     @coverage_status observation_coverage_status,@coverage_start verified_coverage_start,@coverage_end verified_coverage_end,@coverage_evidence coverage_evidence,
     ARRAY(SELECT AS STRUCT p.* EXCEPT(entry_product_ref,window_days),t.returning_customers denominator_customers,
       100*SAFE_DIVIDE(p.customers,t.returning_customers) percentage
       FROM pj_product_ranks p WHERE p.entry_product_ref IS NOT DISTINCT FROM t.entry_product_ref AND p.window_days=t.window_days AND p.product_rank<=IF(t.entry_product_ref IS NULL,${CONTRACT.overall_products},${CONTRACT.next_products}) ORDER BY p.is_sizer,p.product_rank) products
     FROM pj_totals t JOIN pj_unknown u ON u.entry_product_ref IS NOT DISTINCT FROM t.entry_product_ref AND u.window_days=t.window_days ORDER BY t.entry_is_sizer,t.entry_rank,t.window_days) product_journeys,
   (SELECT COUNT(*) FROM pj_entry_counts WHERE NOT is_sizer) available_entry_products,
   (SELECT COUNT(*) FROM pj_entry_counts WHERE is_sizer) available_sizer_entry_products,
   (SELECT COUNT(DISTINCT e.governed_customer_ref) FROM entry_orders e LEFT JOIN pj_lines l USING(source_platform,source_store,order_ref) WHERE l.order_ref IS NULL OR NOT l.known) unknown_entry_customers`;
}
