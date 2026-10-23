// Limits describe independent, validated components. A full page alone is not
// proof that extra rows exist; only the provider's explicit flag proves omission.
export function retentionLimitEvidence(e){
 const labels={retention_windows:'Collaboration totals',retention_piece_windows:'Individual collaboration items/families',retention_product_windows:'First-purchase products',retention_baseline_windows:'Sitewide baseline'};
 const limits=[];
 for(const o of e.source_outcomes||[])if(o.state==='fulfilled'&&Number.isSafeInteger(o.returned_rows)&&Number.isSafeInteger(o.row_limit))limits.push({section:labels[o.group]||o.group,returned:o.returned_rows,limit:o.row_limit,status:o.truncated===true?'truncated':o.returned_rows>=o.row_limit?'at_bound_omission_unverified':'within_bound',source_store:o.source_store});
 for(const o of e.section_outcomes||[])if(o.state==='fulfilled'&&['product_ranking_rows','baseline_period_rows'].includes(o.component)){
  const rows=e[o.component]||[],limit=o.component==='product_ranking_rows'?90:150;
  limits.push({section:o.component==='product_ranking_rows'?'Whole-range product ranking (top 10 per ranking criterion)':'Sitewide calendar-year cohorts',returned:rows.filter(r=>r.source_store===o.source_store).length,limit,status:rows.filter(r=>r.source_store===o.source_store).length>=limit?'at_bound_omission_unverified':'within_bound',source_store:o.source_store});
 }
 if(e.catalogue_reconciliation?.length)limits.push({section:'Governed catalogue reconciliation (independent of item limits)',returned:e.catalogue_reconciliation.length,limit:1000,status:'within_bound'});
 const atTen=[...(e.rows||[]),...(e.baseline_rows||[])].filter(r=>r.second_order_products?.length===10).length;
 if(atTen)limits.push({section:'Second-order product highlights',returned:10,limit:10,status:'at_bound_omission_unverified',cohort_windows_at_bound:atTen});
 for(const group of new Set((e.entry_platform_rows||[]).map(r=>r.group))){const count=e.entry_platform_rows.filter(r=>r.group===group).length;limits.push({section:'Entry-platform diagnostics / '+(labels[group]||group),returned:count,limit:300,status:count>=300?'at_bound_omission_unverified':'within_bound'});}
 return limits;
}
export function retentionLimitSummary(e){
 const limits=retentionLimitEvidence(e),truncated=limits.filter(x=>x.status==='truncated');
 return truncated.length?'Truncated sections: '+truncated.map(x=>`${x.section} (${x.returned}/${x.limit} rows; ${x.source_store})`).join('; ')+'. Collaboration totals and catalogue reconciliation have independent limits.':e.truncated?'A legacy retained result flags a row bound without identifying its component; additional rows may be absent.':'Component row limits are independent; no provider-reported main-section truncation.';
}
