import {retentionFamilyCtes} from '../../oracle/retention-families.js';
import {customerJourneySql} from '../../oracle/customer-journey.js';
import {cohortRelations} from '../../oracle/cohort-execution.js';
// Actual factory suffix and final projection, not a SQLite translation or mocked
// query response. Replace only upstream inputs with typed synthetic CTEs. This
// tests BigQuery syntax/calculation, not live source schema or snapshot readiness.
export function retentionBigQueryFixture(group,platform,store){
 const {relations,result}=cohortRelations(customerJourneySql('fixture',group,platform,store));
 const source=`'${platform}' source_platform,'${store}' source_store`;
 const inputs=`fixture_collections AS (SELECT 1 collection_id,'Reviewed fixture' title,1 product_count),
 fixture_product_collections AS (SELECT 1 collection_id,1 product_id),
 cr_collection_current AS (SELECT '1' collection_id,'Reviewed fixture' collection_title,'collection_group' classification_type,'collaboration' classification_value,'active' status UNION ALL SELECT '1','Reviewed fixture','collaboration_name','alpha','active'),
 cr_routes AS (SELECT '${platform}:${store}:1' source_ref,'shopify:shopify:1' classification_ref,'approved_reporting_family' mapping_type),
 cr_family AS (SELECT '${platform}:${store}:1' source_ref,'shopify:shopify:1' classification_ref),
 cr_family_current AS (SELECT 'shopify:shopify:1' shopify_parent_ref,'Reviewed fixture family' shopify_parent_title,'active' status),
 entry_orders AS (SELECT 'c_fixture' governed_customer_ref,${source},'entry' order_ref,TIMESTAMP('2024-01-01T12:00:00Z') order_timestamp,'Online' channel,1 order_sequence),
 ranked_orders AS (SELECT * FROM entry_orders UNION ALL SELECT 'c_fixture',${platform==='woo'?"'woo'":"'shopify'"},'${store}','return',TIMESTAMP('2024-01-15T12:00:00Z'),'Online',2),
 entry_matches AS (SELECT 'c_fixture' governed_customer_ref,${source},'alpha' collaboration_name,TIMESTAMP('2024-01-01T12:00:00Z') entry_timestamp,'family:shopify:shopify:1' entry_product_ref,'Reviewed fixture family' entry_product_title,'governed_family' entry_family_status),
 classified_lines AS (SELECT ${source},'entry' order_ref,'1' source_product_id,'${platform}:${store}:1' source_product_ref,'Entry item' product_title UNION ALL SELECT '${platform}','${store}','return',CAST(NULL AS STRING),CAST(NULL AS STRING),'Unknown item'),
 ${retentionFamilyCtes()},
 line_classification_sets AS (SELECT *,IF(order_ref='entry','named','product_identity_unmatched') collaboration_state,IF(order_ref='entry',['alpha'],ARRAY<STRING>[]) names FROM classified_lines),
 order_classification_sets AS (SELECT ${source},'return' order_ref,1 unknown_lines,0 core_lines,1 product_lines,ARRAY<STRING>[] names),
 retention_coverage AS (SELECT ${source},1 eligible_first_customers,1 named_customers,0 generic_only_customers,0 core_only_customers,0 unknown_customers,0 conflicting_customers,DATE '2021-01-01' history_start,DATE '2026-10-19' history_end,2 identified_orders,0 anonymous_orders,0 migrated_orders,0 cancelled_orders,0 excluded_orders),
 entry_stage_arrays AS (SELECT ${source},[STRUCT('named' AS collaboration_state,1 AS product_lines,1 AS customers)] classification_stages)`;
 const suffix=relations.slice(relations.findIndex(r=>r.name==='retention_next_orders')).map(r=>`${r.name} AS (${r.body})`).join(',\n');
 const query=('WITH '+inputs+',\n'+suffix+'\n'+result).replaceAll('`fixture.shopify_catalogue.collections`','fixture_collections').replaceAll('`fixture.shopify_catalogue.product_collections`','fixture_product_collections');
 if(/`[^`]+`/.test(query))throw Error('Synthetic probe contains a warehouse table reference');
 return {query,useLegacySql:false,location:'US',jobTimeoutMs:10000,maximumBytesBilled:'100000000',params:{time_zone:'Europe/London',coverage_status:'unverified',coverage_evidence:null,coverage_start:null,coverage_end:null,observation_end:'2026-10-19',minimum_sequence:2,maximum_sequence:null,within_days:null,subsequent_source:null,subsequent_channel:null,ranking_window:90,cohort_limit:33,retention_store_count:1,retention_sort:'repeat_rate_desc',limit:99,entry_source:platform,retention_source_store:store},types:{coverage_evidence:'STRING',coverage_start:'DATE',coverage_end:'DATE',observation_end:'DATE',maximum_sequence:'INT64',within_days:'INT64',subsequent_source:'STRING',subsequent_channel:'STRING'}};
}
