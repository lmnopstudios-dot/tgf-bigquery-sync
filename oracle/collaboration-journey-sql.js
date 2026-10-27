import {cohortRelations} from './cohort-execution.js';
import {productJourneySql} from './product-journey-sql.js';
import {collaborationStateSql} from './classification-reader.js';

// Reuse the governed population and product-count/denominator calculation. Only
// entry membership and independent breakdown quotas differ from whole-range
// second-purchase journeys. Neither accepted report generator is rewritten.
export function collaborationJourneySql(base){
 const parsed=cohortRelations(productJourneySql(base));
 const replacements={
  pj_entries:`SELECT DISTINCT n.governed_customer_ref,k.cohort_key product_ref,k.product,k.cohort_type,k.is_sizer,'governed_product' family_status
    FROM cj_named n JOIN cj_keys k ON k.collaboration_name=n.collaboration_name
      AND (k.cohort_type='collaboration' OR k.collaboration_product_ref=n.reporting_product_ref)`,
  pj_entry_counts:`SELECT product_ref,MIN(product) product,MIN(family_status) family_status,MIN(cohort_type) cohort_type,LOGICAL_OR(is_sizer) is_sizer,COUNT(DISTINCT governed_customer_ref) entry_customers FROM pj_entries GROUP BY product_ref`,
  pj_entry_ranks:`SELECT *,ROW_NUMBER() OVER(PARTITION BY cohort_type,is_sizer ORDER BY entry_customers DESC,product_ref) entry_rank FROM pj_entry_counts`,
  pj_members:parsed.relations.find(r=>r.name==='pj_members').body.replace('FROM entry_orders e LEFT JOIN', 'FROM (SELECT e.* FROM entry_orders e WHERE EXISTS(SELECT 1 FROM cj_named n WHERE n.governed_customer_ref=e.governed_customer_ref)) e LEFT JOIN')
 };
 const extra=[{name:'cj_named',body:`SELECT DISTINCT e.governed_customer_ref,l.reporting_product_ref,l.reporting_product_title,l.is_sizer,
    REPLACE(name,'collaboration_name=','') collaboration_name
    FROM entry_orders e JOIN pj_lines l USING(source_platform,source_store,order_ref)
    CROSS JOIN UNNEST(l.classifications) name
    WHERE (${collaborationStateSql()})='named' AND STARTS_WITH(name,'collaboration_name=')
      AND name NOT IN ('collaboration_name=collaboration','collaboration_name=collaborations')`},
  {name:'cj_keys',body:`SELECT TO_JSON_STRING(['collaboration',collaboration_name,CAST(NULL AS STRING)]) cohort_key,
      'collaboration' cohort_type,collaboration_name,CAST(NULL AS STRING) collaboration_product_ref,collaboration_name product,FALSE is_sizer
    FROM cj_named GROUP BY collaboration_name
    UNION ALL SELECT TO_JSON_STRING(['item',collaboration_name,reporting_product_ref]),'item',collaboration_name,reporting_product_ref,MIN(reporting_product_title),LOGICAL_OR(is_sizer)
    FROM cj_named GROUP BY collaboration_name,reporting_product_ref`}];
 const relations=parsed.relations.flatMap(r=>[...(r.name==='pj_entries'?extra:[]),{...r,body:replacements[r.name]||r.body}]);
 return `WITH ${relations.map(r=>`${r.name} AS (${r.body})`).join(',\n')}
 SELECT 1 cohort_rank,CAST(NULL AS INT64) window_days,'linked_tgf' population_scope,
   ARRAY(SELECT AS STRUCT t.*,COALESCE(k.cohort_type,'overall') cohort_type,k.collaboration_name,k.collaboration_product_ref,
     u.missing_line_customers,u.unknown_product_customers,
     @coverage_status observation_coverage_status,@coverage_start verified_coverage_start,@coverage_end verified_coverage_end,@coverage_evidence coverage_evidence,
     IFNULL(a.products,[]) products
     FROM pj_totals t JOIN pj_unknown u ON u.entry_product_ref IS NOT DISTINCT FROM t.entry_product_ref AND u.window_days=t.window_days
     LEFT JOIN pj_product_arrays a ON a.entry_product_ref IS NOT DISTINCT FROM t.entry_product_ref AND a.window_days=t.window_days
     LEFT JOIN cj_keys k ON k.cohort_key=t.entry_product_ref
     ORDER BY k.cohort_type,t.entry_is_sizer,t.entry_rank,t.window_days) collaboration_journeys,
   (SELECT COUNT(*) FROM pj_entry_counts WHERE cohort_type='collaboration') available_collaborations,
   (SELECT COUNT(*) FROM pj_entry_counts WHERE cohort_type='item' AND NOT is_sizer) available_items,
   (SELECT COUNT(*) FROM pj_entry_counts WHERE cohort_type='item' AND is_sizer) available_sizer_items`;
}
