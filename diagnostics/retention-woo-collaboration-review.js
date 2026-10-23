// Presentation of read-only discovery evidence. Title tokens propose review
// leads only; they never create identity, family or classification decisions.
export function collaborationDiscoveryReview(rows,catalogue){
 const stop=new Set(['iron','maiden','ring','eddie','tgf','ready','to','ship','size','the','of','and','silver']);
 const words=v=>String(v||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
 const out=rows.filter(r=>Number(r.review_rank)<=200).map(r=>{
  const context=catalogue.find(c=>c.collection_id===r.collection_id)?.shopify_review_context||[];
  const tokens=new Set((r.titles||[]).flatMap(words).filter(w=>!stop.has(w)));
  const title_leads=context.map(t=>({...t,shared_review_words:[...new Set(words(t.title).filter(w=>!stop.has(w)&&tokens.has(w)))]})).filter(t=>t.shared_review_words.length>0);
  const rejected=(r.existing_decisions||[]).some(d=>['rejected','revoked','inactive'].includes(d.status));
  const conflict=(r.classification_conflicts||[]).length>0||(r.sku_targets||[]).length>1;
  const proposed_target=(r.sku_targets||[]).length===1&&!conflict&&!rejected&&!r.approved_route_present?r.sku_targets[0]:null;
  const action=r.approved_route_present?'inspect_existing_approved_identity_or_family_consumption_no_reapproval':conflict||rejected?'inspect_conflicts_and_decision_history_in_graph_preview':proposed_target?'preview_identity_vs_reporting_family_then_review':title_leads.length?'manual_product_match_required_title_lead_is_not_identity':'request_historical_product_key_sku_or_parent_crosswalk';
  return {...r,titles:(r.titles||[]).slice(0,30),persisted_skus:(r.persisted_skus||[]).slice(0,50),listing_records:(r.listing_records||[]).slice(0,100),existing_decisions:(r.existing_decisions||[]).slice(0,50),order_line_references:(r.order_line_references||[]).slice(0,20),evidence:(r.evidence||[]).slice(0,100),title_examples_truncated:(r.titles||[]).length>30,sku_examples_truncated:(r.persisted_skus||[]).length>50,evidence_truncated:Number(r.evidence_records)>100,proposed_target,title_review_leads:title_leads,relationship_approved:false,required_governance_action:action,
   listing_evidence:r.current_catalogue_present?'present_in_current_catalogue':r.recorded_orders>0?'historical_order_line_product_current_catalogue_missing':'variation_or_other_persisted_listing_evidence',
   sales_evidence:r.eligible_orders>0?'eligible_sales_recorded':r.lines_missing_order_evidence||r.lines_missing_dates?'eligibility_evidence_incomplete':'no_eligible_sales_in_retained_orders_not_proof_of_no_sales',
   listing_records_truncated:Number(r.listing_evidence_records)>100,decision_history_truncated:Number(r.decision_records)>50,
   review_truncated:Number(r.collaboration_candidate_products)>200,order_line_references_truncated:Number(r.recorded_order_lines)>20};
 });
 return out.sort((a,b)=>Number(!['658016338247','657969971527'].includes(a.collection_id))-Number(!['658016338247','657969971527'].includes(b.collection_id))||Number(b.scope_eligible_customers)-Number(a.scope_eligible_customers)||Number(b.eligible_customers)-Number(a.eligible_customers)||a.source_ref.localeCompare(b.source_ref));
}
