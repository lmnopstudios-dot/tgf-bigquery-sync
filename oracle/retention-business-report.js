const safe=v=>String(v??'Unknown').replaceAll('|','\\|').replaceAll('<','&lt;').replaceAll('>','&gt;');
const source=r=>r.source_platform==='tgf'?'TGF':r.source_platform==='woo'?(r.source_store==='ww'?'Woo WW':'Woo USD'):'Shopify';
const key=r=>[r.source_platform,r.source_store,r.collaboration_name,r.entry_product_ref,r.cohort_year].join('|');
export function retentionBusinessReport(e,{normalize,full}){
 const rows=normalize(e.rows||[]),rankings=normalize(e.product_ranking_rows||[]),baselines=normalize(e.baseline_rows||[]),primary=e.ranking_window||90;
 const label=r=>r.entry_product||[...new Set((e.catalogue_reconciliation||[]).filter(c=>c.collaboration_name===r.collaboration_name).map(c=>c.display_name))].join(' / ')||String(r.collaboration_name||'Unknown').replaceAll('_',' ');
 const family=r=>r.entry_product_ref?(r.entry_family_status==='governed_family'?' [governed family]':r.entry_family_status==='governed_product'?' [approved product identity]':r.entry_family_status==='unmapped_item'?' [unmapped item]':r.entry_family_status==='ambiguous_family'?' [ambiguous family; item retained]':' [family evidence not returned]'):'';
 const cell=r=>!r||r.provisional_eligible_customers==null?'Unavailable (not calculated)':r.provisional_repeat_rate===null?`0 / ${r.provisional_eligible_customers} (unavailable)`:`${r.provisional_repeat_customers} / ${r.provisional_eligible_customers} (${(r.provisional_repeat_rate*100).toFixed(1)}%)`;
 const table=data=>['| Cohort | Provisional observed 90-day repeats / eligible customers (rate) | Provisional observed 180-day | Provisional observed 360-day |','|---|---:|---:|---:|',...data.filter(r=>r.window_days===primary).sort((a,b)=>['ww','usd','shopify'].indexOf(a.source_store)-['ww','usd','shopify'].indexOf(b.source_store)||(b.provisional_repeat_rate??-1)-(a.provisional_repeat_rate??-1)||(b.provisional_eligible_customers??0)-(a.provisional_eligible_customers??0)||String(label(a)).localeCompare(String(label(b)))).map(r=>'| '+[safe((r.population_scope==='linked_tgf'?'':source(r)+' / ')+label(r)+family(r)),...[90,180,360].map(days=>cell(data.find(x=>key(x)===key(r)&&x.window_days===days)))].join(' | ')+' |')].join('\n');
 const lines=[`Cohort entry: ${safe(e.definition?.cohort_entry_start||e.periods?.[0]?.start_date)} to ${safe(e.definition?.cohort_entry_end||e.periods?.[0]?.end_date)}; cutoff ${safe(e.observation_end)} (${safe(e.definition?.time_zone||'Europe/London')}).`,
 '**Collaboration comparison — provisional observed repeat rates**',
 ...(['email_candidate_v1','email_candidate_v2'].includes(e.coverage?.identity)?['Uses an activated email candidate snapshot for analytical linkage; unmatched profiles retain source-local histories. Matching does not verify people or complete migration.']:[]),
 'Each cell shows observed repeats / customers whose first-observed entry was at least that many calendar days before the cutoff. Provisional estimates have uncertain prior history and follow-up, including migration limitations; they do not certify coverage or establish first-ever purchases. Cohorts overlap, small samples are uncertain, and comparisons are not causal.'];
 if(e.population_scope==='linked_tgf')lines.push('One TGF journey across Woo WW, Woo USD and Shopify, sequenced before aggregation using the configured analytical snapshot. Unmatched and ambiguous records retain source-local identities: residual cross-platform double counting is possible; this is not a fully deduplicated population. Platform rates are never averaged or added.');
 const named=rows.filter(r=>!r.entry_product_ref);
 if(named.length)lines.push(table(named));else lines.push('Collaboration comparison unavailable; see component outcomes in full results.');
 if(baselines.length)lines.push('**Comparable sitewide provisional baseline**',table(baselines));
 lines.push('Verified-coverage rates are separate in full results; they remain unavailable wherever continuous transaction coverage is unverified.');
 lines.push('**Whole-range first-purchase product rankings — provisional highlights**');
 for(const store of (e.population_scope==='linked_tgf'?['combined']:['ww','usd','shopify'])){
  const base=rankings.filter(r=>r.source_store===store&&r.window_days===primary);
  const ranked=[...base].filter(r=>r.provisional_repeat_rate!=null).sort((a,b)=>b.provisional_repeat_rate-a.provisional_repeat_rate||b.provisional_eligible_customers-a.provisional_eligible_customers||String(a.entry_product_ref).localeCompare(String(b.entry_product_ref))).slice(0,5);
  if(ranked.length){const selected=new Set(ranked.map(key));lines.push(table(rankings.filter(r=>selected.has(key(r)))));}
  const counts=[...base].filter(r=>r.provisional_repeat_customers!=null).sort((a,b)=>b.provisional_repeat_customers-a.provisional_repeat_customers).slice(0,3);
  if(counts.length)lines.push(`${source(counts[0])} — by provisional age-qualified repeat count (${primary} days): ${counts.map(r=>`${safe(label(r)+family(r))}: ${r.provisional_repeat_customers}`).join('; ')}.`);
 }
 if(!rankings.length)lines.push('Product ranking evidence unavailable; individual first-purchase family/item tables remain in full results.');
 lines.push('**Second-order products — highlights** (per cohort at the ranking window; overlapping counts must not be added).');
 for(const store of (e.population_scope==='linked_tgf'?['combined']:['ww','usd','shopify'])){
  const part=(named.length?named:rows).filter(r=>r.source_store===store&&r.window_days===primary);
  const highlights=part.flatMap(r=>(r.second_order_products||[]).map(p=>({r,p}))).sort((a,b)=>b.p.observed_customers-a.p.observed_customers).slice(0,3);
  for(const {r,p} of highlights)lines.push(`${source(r)} / ${safe(label(r))}: ${safe(p.product)}${p.family_status==='governed_family'?' [governed family]':p.family_status==='governed_product'?' [approved product identity]':p.family_status==='unmapped_item'?' [unmapped item]':p.family_status==='ambiguous_family'?' [ambiguous family; item retained]':' [family evidence not returned]'} — ${p.observed_customers} observed customers.`);
  for(const r of part.filter(r=>r.second_order_product_coverage&&(r.second_order_product_coverage.missing_line_customers||r.second_order_product_coverage.unidentified_product_customers)).slice(0,3))lines.push(`${source(r)} / ${safe(label(r))}: unknown attribution — ${r.second_order_product_coverage.missing_line_customers} repeat customers without order lines; ${r.second_order_product_coverage.unidentified_product_customers} with unidentified products (may overlap).`);
 }
 const failures=(e.source_outcomes||[]).filter(o=>o.state!=='fulfilled');
 if(failures.length)lines.push(`Calculation availability: ${failures.map(o=>`${source(o)} / ${o.group}: ${o.state} (${o.stage||'stage unavailable'})`).join('; ')}. Successful components are retained; software failures are separate from coverage uncertainty.`);
 if((e.section_outcomes||[]).some(o=>o.state==='rejected'))lines.push('Some supplemental sections failed validation; independent successful results are retained. See full results.');
 if(e.truncated)lines.push('A row bound was reached; this comparison is bounded. Reconciliation and full retained results remain available below.');
 if(e.request_id)lines.push(`Request reference: ${safe(e.request_id)}.`);
 // The client supports sibling details, not nested details. Keep the complete
 // existing report/diagnostics accessible inside one expandable section.
 const body=full.replace(/<details>\s*<summary>[^<>]*<\/summary>/g,'').replaceAll('</details>','');
 lines.push('<details>\n<summary>Full results, verified-coverage rates, reconciliation and caveats</summary>\n\n'+body+'\n\n</details>');
 return lines.join('\n\n');
}
