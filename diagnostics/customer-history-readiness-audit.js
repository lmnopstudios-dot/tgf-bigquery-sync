import {fq} from '../customer-identity/collect.js';
import {TABLES} from '../customer-identity/operations.js';
import {HISTORY_TABLES} from '../customer-identity/history-sql.js';
import {safeReadFailure} from '../oracle/read-failure.js';

export const READINESS_AUDIT_FIELDS=Object.freeze({
  identity_snapshots:TABLES.identity_snapshots,
  identity_order_links:HISTORY_TABLES.identity_order_links,
});
const canonical=t=>({INT64:'INTEGER',BOOL:'BOOLEAN'}[t]||t);
export function auditSchema(meta,expected) {
  const actual=meta?.schema?.fields||[];
  return {valid:meta?.type==='TABLE'&&actual.length===expected.length&&expected.every(f=>actual.some(a=>a.name===f.name&&canonical(a.type)===canonical(f.type)&&a.mode!=='REPEATED')),
    unexpected_field_count:actual.filter(a=>!expected.some(f=>f.name===a.name)).length,
    missing_or_incompatible_fields:expected.filter(f=>!actual.some(a=>a.name===f.name&&canonical(a.type)===canonical(f.type)&&a.mode!=='REPEATED')).map(f=>f.name)};
}
export function readinessAuditSql(project,dataset) {
  const m=fq(project,dataset,'identity_snapshots'),l=fq(project,dataset,'identity_order_links');
  // Only the deployed marker/link columns; ROWS is a reserved GoogleSQL keyword.
  // Aggregate the two tables separately before comparing their counts.
  return `WITH snapshot_markers AS (
  SELECT state,start_date,end_date,mapping_count,created_at FROM ${m} WHERE snapshot_id=@snapshot
), snapshot_links AS (
  SELECT source_store,source_order_id,source_customer_id,canonical_customer_ref,resolution,
    financial_status,cancelled,conflicting_email,shared_email FROM ${l} WHERE snapshot_id=@snapshot
), link_key_counts AS (
  SELECT source_store,source_order_id,COUNT(*) copies,
    COUNT(DISTINCT TO_JSON_STRING(STRUCT(source_customer_id,canonical_customer_ref,resolution,
      financial_status,cancelled,conflicting_email,shared_email))) variants
  FROM snapshot_links GROUP BY source_store,source_order_id
), link_summary AS (
  SELECT COUNT(*) total_links,COUNTIF(source_store IS NULL OR source_store NOT IN ('ww','usd','shopify')
    OR source_order_id IS NULL OR source_order_id='' OR canonical_customer_ref IS NULL
    OR NOT REGEXP_CONTAINS(canonical_customer_ref,r'^c_[A-Fa-f0-9]{64}$')
    OR resolution IS NULL OR resolution NOT IN ('matched','unmatched','ambiguous','unavailable')) invalid_mapping_rows
  FROM snapshot_links
), marker_summary AS (
  SELECT COUNT(*) marker_count,
    COUNTIF(state='ready' AND CAST(start_date AS STRING)=@reader_start AND CAST(end_date AS STRING)=@reader_end
      AND mapping_count>0) markers_matching_reader_dates_state_count,
    COUNTIF(created_at=@keep_created_at) retained_original_marker
  FROM snapshot_markers
)
SELECT marker_summary.*,link_summary.*,
  (SELECT COUNT(*) FROM snapshot_markers CROSS JOIN link_summary
    WHERE mapping_count=total_links) markers_matching_link_count,
  (SELECT COUNT(*) FROM link_key_counts) distinct_keys,
  (SELECT COUNTIF(copies>1) FROM link_key_counts) duplicate_keys,
  (SELECT COUNTIF(variants>1) FROM link_key_counts) conflicting_keys,
  ARRAY(SELECT AS STRUCT IF(source_store IN ('ww','usd','shopify'),source_store,'unexpected_source') source,
    COUNT(*) row_count FROM snapshot_links GROUP BY source_store ORDER BY source_store) sources
FROM marker_summary CROSS JOIN link_summary`;
}
export function auditMatchesRepair(row) {
  const counts={ww:39176,usd:4322,shopify:14967};
  return ['marker_count','markers_matching_reader_dates_state_count','retained_original_marker','markers_matching_link_count'].every(k=>Number(row?.[k])===1)
    &&Number(row?.total_links)===58465&&Number(row?.distinct_keys)===58465
    &&['duplicate_keys','conflicting_keys','invalid_mapping_rows'].every(k=>Number(row?.[k])===0)
    &&row?.sources?.length===3&&new Set(row.sources.map(r=>r.source)).size===3
    &&row.sources.every(r=>counts[r.source]!==undefined&&Number(r.row_count)===counts[r.source]);
}
const semantic=new Set(['Snapshot not ready','Incomplete identity coverage','Identity count mismatch','Invalid identity coverage','Invalid order coverage','Invalid order coverage partition','Identity read deadline']);
const identifiers=new Set(Object.values(READINESS_AUDIT_FIELDS).flat().map(f=>f.name));
export function readinessFailure(error) {
  const nested=error?.response?.data?.error;
  const entries=[...(Array.isArray(error?.errors)?error.errors:[]),...(Array.isArray(nested?.errors)?nested.errors:[]),error];
  const safe=safeReadFailure(error,'diagnostic');
  const message=entries.find(e=>/\[\d{1,6}:\d{1,6}\]/.test(e?.message||''))?.message||error?.message||'';
  const field=message.match(/(?:Unrecognized name:|No such field:|Column)\s+[`"]?([A-Za-z_][A-Za-z0-9_]*)/i)?.[1];
  const position=message.match(/\[(\d{1,6}):(\d{1,6})\]/);
  return {...safe,...(!safe.statement_location&&position?{statement_location:{line:Number(position[1]),column:Number(position[2])}}:{}),readiness_stage:['snapshot_read','identity_coverage','fallback_query'].includes(error?.history_diagnostic?.stage)?error.history_diagnostic.stage:null,
    semantic_reason:semantic.has(error?.message)?error.message:/Identity snapshot integrity failed/.test(error?.message||'')?'Identity snapshot integrity failed':null,
    diagnostic_reason:['unsupported_reader_catch_shape','configured_project_differs_from_repaired_project','unexpected_reader_query','reader_budget_changed','unexpected_query','audit_schema_mismatch','invalid_audit_result'].includes(error?.diagnostic_reason)?error.diagnostic_reason:null,
    known_field:identifiers.has(field)?field:null,
    unexpected_keyword:/Unexpected keyword ROWS\b/i.test(message)?'ROWS':null};
}
