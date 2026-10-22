import {provisionalEligibleSql,provisionalTotalsSql} from './retention-provisional.js';
// Supplemental aggregates share the same entry orders, linked sequencing, next
// eligible order and coverage parameters as the main retention projection.
export function retentionSectionSql(baseline){
  const identity=baseline?"'Sitewide' collaboration_name,EXTRACT(YEAR FROM DATE(e.order_timestamp,@time_zone)) cohort_year":"l.reporting_product_ref entry_product_ref,MIN(l.reporting_product_title) entry_product_title,MIN(l.family_status) entry_family_status";
  const keys='source_platform,source_store,'+(baseline?'collaboration_name,cohort_year':'entry_product_ref');
  const membership=baseline?'':`JOIN retention_reporting_lines l USING(source_platform,source_store,order_ref)`;
  return `, section_entries AS (
    SELECT e.governed_customer_ref,e.source_platform,e.source_store,e.order_timestamp entry_timestamp,${identity}
    FROM entry_orders e ${membership}
    ${baseline?'':'WHERE l.source_product_ref IS NOT NULL AND l.source_product_id NOT IN (\'\',\'0\',\'unknown\') GROUP BY e.governed_customer_ref,e.source_platform,e.source_store,e.order_timestamp,l.reporting_product_ref'}
  ), section_members AS (
    SELECT e.*,window_days,${provisionalEligibleSql('e')} provisional_eligible,COALESCE(DATE(e.entry_timestamp,@time_zone)>=@coverage_start AND DATE_ADD(DATE(e.entry_timestamp,@time_zone),INTERVAL window_days DAY)<=LEAST(@observation_end,@coverage_end),FALSE) mature,
      IF(DATE_DIFF(DATE(d.order_timestamp,@time_zone),DATE(e.entry_timestamp,@time_zone),DAY)<=window_days,TIMESTAMP_DIFF(d.order_timestamp,e.entry_timestamp,SECOND)/86400.0,NULL) days_to_second
    FROM section_entries e CROSS JOIN UNNEST([90,180,360]) window_days LEFT JOIN retention_next_orders d USING(governed_customer_ref)
  ), section_medians AS (
    SELECT *,PERCENTILE_CONT(IF(mature,days_to_second,NULL),0.5) OVER(PARTITION BY ${keys},window_days) median_days_to_second FROM section_members
  ), section_totals AS (
    SELECT ${keys},${baseline?'':"CAST(NULL AS STRING) collaboration_name,MIN(entry_product_title) entry_product_title,MIN(entry_family_status) entry_family_status,"}window_days,COUNT(*) cohort_customers,
      COUNTIF(mature) mature_customers,COUNTIF(mature AND days_to_second IS NOT NULL) repeat_customers,COUNTIF(days_to_second IS NOT NULL) observed_repeat_customers,${provisionalTotalsSql},
      ANY_VALUE(median_days_to_second) median_days_to_second,@coverage_status observation_coverage_status,@coverage_start verified_coverage_start,@coverage_end verified_coverage_end,@coverage_evidence coverage_evidence
    FROM section_medians GROUP BY ${keys},window_days
  )${baseline?'':`, section_scores AS (
    SELECT *,MAX(IF(window_days=@ranking_window,provisional_repeat_customers,NULL)) OVER(PARTITION BY source_platform,source_store,entry_product_ref) rank_count,
      MAX(IF(window_days=@ranking_window,SAFE_DIVIDE(repeat_customers,mature_customers),NULL)) OVER(PARTITION BY source_platform,source_store,entry_product_ref) rank_rate,
      MAX(IF(window_days=@ranking_window,provisional_repeat_rate,NULL)) OVER(PARTITION BY source_platform,source_store,entry_product_ref) rank_provisional_rate FROM section_totals
  ), section_ranked AS (
    SELECT *,DENSE_RANK() OVER(PARTITION BY source_platform,source_store ORDER BY rank_count DESC,entry_product_ref) count_rank,
      IF(rank_rate IS NULL,NULL,DENSE_RANK() OVER(PARTITION BY source_platform,source_store ORDER BY rank_rate DESC,entry_product_ref)) rate_rank,
      IF(rank_provisional_rate IS NULL,NULL,DENSE_RANK() OVER(PARTITION BY source_platform,source_store ORDER BY rank_provisional_rate DESC,entry_product_ref)) provisional_rate_rank FROM section_scores
  )`}`;
}

export const retentionSectionProjection=baseline=>baseline
  ?'ARRAY(SELECT AS STRUCT * FROM section_totals ORDER BY cohort_year,window_days LIMIT 150) baseline_period_rows'
  :'ARRAY(SELECT AS STRUCT * FROM section_ranked WHERE count_rank<=10 OR rate_rank<=10 OR provisional_rate_rank<=10 ORDER BY count_rank,window_days LIMIT 90) product_ranking_rows';
