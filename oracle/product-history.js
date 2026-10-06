import { productFamilyCtes } from './product-mapping.js';

// Read current governed family decisions, including revocations/supersessions.
// Deliberately do not call mappingService.familyHistory(): it runs setup DDL.
export function createReadOnlyProductHistory({bigquery,project}){
  if(!/^[A-Za-z0-9_-]+$/.test(project))throw new Error('Invalid project');
  return async candidate=>{
    const refs=(candidate.sources||[]).map(s=>s.source_product_ref).filter(Boolean),parent=candidate.product_ref?.startsWith('family:')?candidate.product_ref.slice(7):refs.find(ref=>ref.startsWith('shopify:'))||'';
    const [rows]=await bigquery.query({query:`WITH ${productFamilyCtes(project)}
      SELECT source_ref,shopify_parent_ref,shopify_parent_title,status,resolved_decision_id decision_id,reviewed_at,provenance FROM family_current
      WHERE shopify_parent_ref=@parent OR source_ref IN UNNEST(@refs)
      ORDER BY source_ref LIMIT 1001`,params:{parent,refs},types:{refs:['STRING']},useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'15000',labels:{component:'oracle_product_history'}});
    if(rows.length>1000)return {status:'unavailable',reason:'HISTORY_BOUND_EXCEEDED',members:[]};
    return {status:'available',members:rows,active_source_refs:rows.filter(r=>r.status==='active').map(r=>r.source_ref),definition:'Current governed reporting-family decisions only; no title-inferred Woo links. Source identities are unchanged.'};
  };
}
