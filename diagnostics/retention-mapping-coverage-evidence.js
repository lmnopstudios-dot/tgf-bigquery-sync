import {entryAgeTraceSettings} from './retention-entry-age-trace.js';
import {retentionMappingReviewSql,mappingReviewList} from './retention-mapping-review.js';
import {retentionCatalogueSql,reconcileRetentionCatalogue} from '../oracle/retention-catalogue.js';
import {cohortRelations,auditExecutionOptions} from '../oracle/cohort-execution.js';
import {boundedQuery} from '../oracle/bounded-query.js';
import {safeReadFailure} from '../oracle/read-failure.js';
const stores=[['woo','ww'],['woo','usd'],['shopify','shopify']];
const scope={entry_start:'2022-10-19',entry_end:'2026-10-19',cutoff:'2026-10-19',time_zone:'Europe/London',identity:'email_candidate_v2',snapshot:'customer_identity/history-20261022-billing-v3'};
export function mappingAuditSql(project){
 if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
 const {relations,result}=cohortRelations(retentionMappingReviewSql(project));
 return 'WITH '+relations.map(r=>`${r.name} AS (${r.body})`).join(',\n')+` SELECT
 ARRAY(${result.replace(/^SELECT /,'SELECT AS STRUCT ')}) review_rows,
 ARRAY(${stores.map(([source,store])=>`SELECT AS STRUCT '${source}' source_platform,'${store}' source_store,c.* FROM (${retentionCatalogueSql(project,source,store)}) c`).join(' UNION ALL ')}) catalogue,
 ARRAY(SELECT AS STRUCT l.source_store,COUNT(DISTINCT l.source_product_ref) historical_products,
 COUNT(DISTINCT IF(EXISTS(SELECT 1 FROM cr_resolved c WHERE c.subject_ref=l.source_product_ref AND c.classification_type='collaboration_name' AND c.classification_value NOT IN ('collaboration','collaborations')),l.source_product_ref,NULL)) resolved_named_products,
 COUNT(DISTINCT IF(EXISTS(SELECT 1 FROM cr_resolved c WHERE c.subject_ref=l.source_product_ref AND c.classification_type='collaboration_name' AND c.classification_value NOT IN ('collaboration','collaborations') AND CONCAT('collaboration_name=',c.classification_value) NOT IN UNNEST(l.classifications)),l.source_product_ref,NULL)) resolved_classification_not_consumed
 FROM classified_lines l WHERE l.source_platform='woo' GROUP BY l.source_store) route_consumption`;
}
const boundaries=['orders','cr_routes','cr_collection_current','cr_resolved','classified_lines','retention_reporting_lines','line_classification_sets','ranked_orders','entry_matches'];
const table=(p,d,t)=>`\`${p}.${d}.${t}\``;
export function ingestionEvidenceQueries(project){
 if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
 return [
  {check:'retained_report_bounds',query:`SELECT job_id,status,attempts,created_at,updated_at,JSON_VALUE(lifecycle_json,'$.execution_revision') execution_revision,TO_JSON_STRING(result_json) retained_result,COUNT(*) OVER() matching_records FROM ${table(project,'commerce','oracle_analysis_jobs_v1')} WHERE request_id='279fea44-4f76-4723-9936-a0f39d916a8e' ORDER BY created_at,job_id,attempts,updated_at LIMIT 5`},
  {check:'finance_transaction_updates',query:`SELECT run_id,mode,window_start,window_end,status,order_count,refund_count,page_count,started_at,finished_at,COUNT(*) OVER() matching_records FROM ${table(project,'shopify_data','finance_refresh_runs')} WHERE window_start<TIMESTAMP('2026-10-19T23:00:00Z') AND window_end>=TIMESTAMP('2026-10-19T14:17:24.265Z') ORDER BY window_start,started_at,run_id LIMIT 501`},
  {check:'customer_eligibility_updates',query:`SELECT run_id,mode,window_start,window_end,status,requested_count,returned_count,ARRAY_LENGTH(unresolved_ids) unresolved_count,retrieved_at,started_at,finished_at,COUNT(*) OVER() matching_records FROM ${table(project,'shopify_data','customer_refresh_runs')} WHERE window_start<TIMESTAMP('2026-10-19T23:00:00Z') AND window_end>=TIMESTAMP('2026-10-19T14:17:24.265Z') ORDER BY window_start,started_at,run_id LIMIT 501`},
  {check:'existing_collector_records',query:`SELECT source,status,window_start,window_end,row_counts_json,started_at,finished_at,COUNT(*) OVER() matching_records FROM ${table(project,'oracle_ops','collector_runs')} WHERE source IN ('shopify_finance','shopify_customers','metorik_uk','metorik_us','shopify') AND started_at<TIMESTAMP('2026-10-23') ORDER BY started_at DESC,run_id LIMIT 101`},
  {check:'retention_input_metadata',query:stores.map(([s,store])=>{const d=s==='woo'?(store==='ww'?'metorik_uk':'metorik_us'):'shopify_data';return `SELECT '${store}' source_store,table_id,row_count,TIMESTAMP_MILLIS(last_modified_time) last_modified FROM ${table(project,d,'__TABLES__')} WHERE table_id IN ('orders','order_line_items','order_locations','order_financials','order_customers')`;}).join(' UNION ALL ')}
 ];
}
export function mappingCoverageArtifact(project){return {project,scope,trace_settings:entryAgeTraceSettings(project),ingestion_queries:ingestionEvidenceQueries(project),mapping_settings:{...auditExecutionOptions(mappingAuditSql(project),boundaries,50000),location:'US',useLegacySql:false,params:{cohort_entry_start:'2022-10-19',cohort_entry_end:'2026-10-19',observation_end:'2026-10-19',time_zone:'Europe/London',entry_source:null,entry_channel:null,entry_product_ref:null,entry_classification:'collaboration',retention_source_store:null,first_order_semantic:'first_observed_ever',matrixify_app_id:'gid://shopify/App/1758145'},types:{cohort_entry_start:'DATE',cohort_entry_end:'DATE',observation_end:'DATE',entry_source:'STRING',entry_channel:'STRING',entry_product_ref:'STRING',retention_source_store:'STRING'}}};}
export async function readMappingCoverageEvidence({bigquery,project,artifact,onCheck=()=>{}}){
 if(!artifact||artifact.project!==project||JSON.stringify(artifact.scope)!==JSON.stringify(scope)||artifact.ingestion_queries.length!==5)throw Error('Invalid reviewed evidence artifact');
 const checks=[];
 const record=c=>{checks.push(c);onCheck(c);};
 const reads=artifact.ingestion_queries.map(async({check,query})=>{
  try{const [rows]=await boundedQuery(bigquery,{query,location:'US',useLegacySql:false,jobTimeoutMs:10000,maximumBytesBilled:'100000000'},{maximumMs:12000});if(check==='retained_report_bounds'){
    const executions=[];
    for(const row of rows.slice(0,4)){
     const {retained_result,...inventory}=row;let e=retained_result;
     try{if(String(e||'').length>4194304)throw Error('Retained evidence size bound');for(let i=0;i<8;i++){if(typeof e==='string'){e=JSON.parse(e);continue;}if(e?.evidence){e=e.evidence;break;}if(e?.result){e=e.result;continue;}break;}
      executions.push({...inventory,truncated:e?.truncated??null,source_outcomes:e?.source_outcomes||[],sections:{collaboration_window_rows:e?.rows?.filter(r=>!r.entry_product_ref).length??null,item_window_rows:e?.rows?.filter(r=>r.entry_product_ref).length??null,sitewide_window_rows:e?.baseline_rows?.length??null,product_ranking_window_rows:e?.product_ranking_rows?.length??null,sitewide_period_window_rows:e?.baseline_period_rows?.length??null,catalogue_entries:e?.catalogue_reconciliation?.length??null,entry_platform_diagnostic_rows:e?.entry_platform_rows?.length??null},section_outcomes:e?.section_outcomes||[]});
     }catch{executions.push({...inventory,status:'retained_evidence_unavailable'});}
    }
    record({check,status:'read_completed',executions,truncated:rows.length>4||Number(rows[0]?.matching_records)>4});return;
   }
   const cap=check==='existing_collector_records'?100:500;record({check,status:'read_completed',rows:rows.slice(0,cap),truncated:rows.length>cap||Number(rows[0]?.matching_records)>cap,coverage_certified:false});}
  catch(e){record({check,status:'unavailable',...safeReadFailure(e,'diagnostic')});}
 });
 reads.push((async()=>{
  try{
   const [rows]=await boundedQuery(bigquery,artifact.mapping_settings,{maximumMs:55000});
   if(rows.length!==1)throw Error('Mapping evidence envelope unavailable');
   const data=rows[0];const catalogue=stores.flatMap(([source_platform,source_store])=>reconcileRetentionCatalogue(data.catalogue.filter(c=>c.source_platform===source_platform&&c.source_store===source_store),[],{source_platform,source_store}));
   // This inventory is not a rendered report: observed cohorts with no display
   // row are labelled as matches, never as report truncation.
   for(const c of catalogue)if(c.status==='truncated')c.status='eligible_matches_present';
   record({check:'consolidated_mapping_review',status:'read_completed',...mappingReviewList(data.review_rows),catalogue,route_consumption:data.route_consumption,scope,classification_written:false,coverage_certified:false});
  }catch(e){record({check:'consolidated_mapping_review',status:'unavailable',...safeReadFailure(e,'diagnostic')});}
 })());
 reads.push((async()=>{
  try{const [rows]=await boundedQuery(bigquery,artifact.trace_settings,{maximumMs:55000});
   if(rows.length!==1||!Array.isArray(rows[0].stage_counts))throw Error('Entry-age trace unavailable');
   const r=rows[0];record({check:'collaboration_entry_age_trace',status:'read_completed',targets:r.targets,stage_counts:r.stage_counts,product_routes:(r.product_routes||[]).slice(0,200),product_routes_truncated:(r.product_routes||[]).length>200||Number(r.product_routes?.[0]?.total_product_rows)>200,coverage_certified:false,sku_candidates_are_not_membership:true});
  }catch(e){record({check:'collaboration_entry_age_trace',status:'unavailable',...safeReadFailure(e,'diagnostic')});}
 })());
 await Promise.allSettled(reads);
 return {read_only_business_data:true,temporary_tables_only:true,report_replayed:false,governance_written:false,coverage_certified:false,scope,checks};
}

export function evidenceReaderSource(){return `export function evidenceReader({boundedQuery,safeReadFailure,reconcileRetentionCatalogue}){const stores=${JSON.stringify(stores)},scope=${JSON.stringify(scope)};${mappingReviewList.toString()};${readMappingCoverageEvidence.toString()};return readMappingCoverageEvidence;}`;}
