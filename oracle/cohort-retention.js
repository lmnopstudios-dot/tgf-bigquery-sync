import {reconcileRetentionCatalogue} from './retention-catalogue.js';
import { customerHistoryContract, HISTORY_LIMITATION } from './customer-history.js';
import { requestId } from './request-observability.js';
import { safeReadFailure } from './read-failure.js';
import { assertAnswerCompleteness } from './answer-completeness.js';
import { assertPlanAgreement } from './analytical-plan.js';
import { boundedEvidenceRead } from './bounded-evidence-read.js';
import { applyJourneyAnalysisContext } from './customer-journey.js';

// Projection of the existing journey contract. No second customer identity or
// classification model is introduced here.
export function retentionIntent(text){
  return /\bcollaborations?\b/i.test(text) && /\b(?:retention|repeat|bring customers back|come back|return(?:ing)? customers?|return purchases?)\b/i.test(text);
}
export function retentionDefinition(context){
  return {...applyJourneyAnalysisContext({},context),ranking_window:context.ranking_metric==='repeat_rate_360'?360:context.ranking_metric==='repeat_rate_180'?180:context.within_days||90,group_by:[context.journey_group_by==='entry_product'?'retention_product_windows':context.journey_group_by==='collaboration_piece'?'retention_piece_windows':'retention_windows'],
    cohort:{entry_product_classification:context.entry_product_classification||'collaboration',entry_channel:context.channel==='instore'?'In-store':context.channel==='online'?'Online':null},
    subsequent:{channel:context.channel==='instore'?'In-store':context.channel==='online'?'Online':null},
    sort:context.sort||'repeat_rate_desc',limit:context.channel_breakdown||context.journey_group_by==='collaboration_piece'?50:100};
}
export function retentionRows(rows,sort='repeat_rate_desc',rankingWindow=90){
  if(!Array.isArray(rows)||rows.length>600)throw new Error('Retention row bound exceeded');
  return rows.filter(row=>!['collaboration','collaborations'].includes(row.collaboration_name)).map(row=>{
    const count=key=>{const n=Number(row[key]);if(row[key]===null||row[key]===undefined||typeof row[key]==='boolean'||row[key]===''||!Number.isInteger(n)||n<0)throw new Error('Invalid retention count');return n;};
    const cohort_customers=count('cohort_customers'),mature_customers=count('mature_customers'),repeat_customers=count('repeat_customers');
    if(repeat_customers>mature_customers||mature_customers>cohort_customers||![90,180,360].includes(Number(row.window_days)))throw new Error('Invalid retention denominator');
    if(row.observation_coverage_status!=null){
      if(!['unverified','verified_continuous'].includes(row.observation_coverage_status))throw Error('Invalid observation coverage');
      if(row.observation_coverage_status==='unverified'&&(mature_customers!==0||repeat_customers!==0))throw Error('Unsupported mature denominator');
      if(count('observed_repeat_customers')>cohort_customers||count('observed_repeat_customers')<repeat_customers)throw Error('Invalid observed repeat count');
      if(row.observation_coverage_status==='verified_continuous'&&(!row.verified_coverage_start||!row.verified_coverage_end||!row.coverage_evidence))throw Error('Missing verified coverage boundary');
    }
    const median=row.median_days_to_second==null?null:Number(row.median_days_to_second);
    if(median!==null&&(!Number.isFinite(median)||median<0||median>=Number(row.window_days)+2)||repeat_customers===0&&median!==null||repeat_customers>0&&median===null)throw new Error('Invalid conditional retention median');
    if(!((row.source_platform==='woo'&&['ww','usd'].includes(row.source_store))||(row.source_platform==='shopify'&&row.source_store==='shopify'))||!row.collaboration_name&&!row.entry_product_ref)throw new Error('Missing retention population');
    const products=row.second_order_products;
    if(products!=null&&(!Array.isArray(products)||products.length>10||new Set(products.map(p=>p.product_ref)).size!==products.length||products.some(p=>typeof p.product_ref!=='string'||!p.product_ref||typeof p.product!=='string'||!['observed_customers','mature_repeat_customers'].every(k=>Number.isSafeInteger(Number(p[k]))&&Number(p[k])>=0)||Number(p.observed_customers)>Number(row.observed_repeat_customers)||Number(p.mature_repeat_customers)>repeat_customers||Number(p.mature_repeat_customers)>Number(p.observed_customers))))throw Error('Invalid second-order products');
    const productCoverage=row.second_order_product_coverage;
    if(productCoverage!=null&&['missing_line_customers','unidentified_product_customers','untitled_product_customers'].some(k=>productCoverage[k]==null||productCoverage[k]===''||typeof productCoverage[k]==='boolean'||!Number.isSafeInteger(Number(productCoverage[k]))||Number(productCoverage[k])<0||Number(productCoverage[k])>Number(row.observed_repeat_customers)))throw Error('Invalid second-order product coverage');
    const secondKeys=['same_collaboration','different_collaboration','core_range','unknown'];
    const second=Object.fromEntries(secondKeys.map(k=>[k,row[k]==null?null:count(k)]));
    if(secondKeys.some(k=>second[k]!==null)&&(!secondKeys.every(k=>second[k]!==null)||secondKeys.reduce((n,k)=>n+second[k],0)!==repeat_customers))throw new Error('Invalid second-purchase classification');
    return {...(productCoverage?{second_order_product_coverage:Object.fromEntries(['missing_line_customers','unidentified_product_customers','untitled_product_customers'].map(k=>[k,Number(productCoverage[k])]))}:{}),...(row.cohort_year!=null?{cohort_year:Number(row.cohort_year)}:{}),...(row.count_rank!=null?{count_rank:Number(row.count_rank),rate_rank:row.rate_rank==null?null:Number(row.rate_rank)}:{}),...(products!=null?{second_order_products:products.map(p=>({...p,observed_customers:Number(p.observed_customers),mature_repeat_customers:Number(p.mature_repeat_customers)}))}:{}),...(row.observation_coverage_status?{coverage_evidence:row.coverage_evidence||null,observation_coverage_status:row.observation_coverage_status,verified_coverage_start:row.verified_coverage_start?.value||row.verified_coverage_start||null,verified_coverage_end:row.verified_coverage_end?.value||row.verified_coverage_end||null,observed_repeat_customers:count('observed_repeat_customers')}:{}),...second,...(row.entry_product_ref?{entry_product_ref:row.entry_product_ref,entry_product:row.entry_product}:{}),source_platform:row.source_platform,source_store:row.source_store,collaboration_name:row.collaboration_name,window_days:Number(row.window_days),cohort_customers,mature_customers,repeat_customers,repeat_rate:mature_customers?repeat_customers/mature_customers:null,median_days_to_second:median};
  }).sort((a,b)=>a.source_platform.localeCompare(b.source_platform)||a.source_store.localeCompare(b.source_store)||(a.window_days===rankingWindow?0:1)-(b.window_days===rankingWindow?0:1)||(sort==='returning_customers_desc'?b.repeat_customers-a.repeat_customers:0)||(b.repeat_rate??-1)-(a.repeat_rate??-1)||b.mature_customers-a.mature_customers||String(a.entry_product_ref||a.collaboration_name).localeCompare(String(b.entry_product_ref||b.collaboration_name)));
}
const display=value=>String(value||'Unknown').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
const sourceLabel=r=>r.source_platform==='woo'?(r.source_store==='ww'?'Woo WW':'Woo USD'):r.source_platform==='shopify'?'Shopify':display(r.source_platform);
const retentionValidationReason=error=>({
  'Invalid sitewide baseline':'baseline_scope','Retention source mismatch':'source_scope','Retention grouping mismatch':'grouping_scope','Retention provider row bound exceeded':'row_bound','Retention coverage source mismatch':'coverage_scope','Invalid second-order products':'second_order_product_scope','Invalid conditional retention median':'conditional_median','Invalid retention denominator':'denominator','Invalid retention section':'supplemental_scope'
}[error.message]||'evidence_contract');
const safe=value=>String(value).replaceAll('|','\\|').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function retentionMarkdown(e){
  const primary=e.ranking_window||90;
  const conservativeRows=data=>retentionRows(data||[],e.definition?.sort,primary).map(r=>r.observation_coverage_status?r:{...r,observation_coverage_status:'unverified',observed_repeat_customers:r.repeat_customers,mature_customers:0,repeat_customers:0,repeat_rate:null,median_days_to_second:null});
  const rows=conservativeRows(e.rows),baselines=conservativeRows(e.baseline_rows);
  const reviewedName=name=>{const names=[...new Set((e.catalogue_reconciliation||[]).filter(c=>c.collaboration_name===name).map(c=>c.display_name))];return names.length?names.join(' / '):display(name);};
  const rowLabel=r=>r.entry_product||reviewedName(r.collaboration_name);
  const uncertain=[...rows,...baselines].some(r=>r.observation_coverage_status==='unverified');
  const failedLabels=[...new Set((e.source_outcomes||[]).filter(s=>s.state==='rejected'&&s.stage!=='evidence_validation').map(sourceLabel))];
  const identityActive=['email_candidate_v1','email_candidate_v2'].includes(e.coverage?.identity);
  const orderIdentity=e.coverage?.identity_activation?.find(s=>s.version==='order_email_v2');
  const lines=[...(identityActive?['Activated email candidate snapshots join Woo and Shopify histories before first-observed cohort assignment. Unmatched profiles retain source-local identities; candidate matches do not verify people, complete migration or complete follow-up.']:[]),...(uncertain?['Complete follow-up coverage is unverified; a mature retention ranking cannot be established. Identifiable observed repeats are shown separately from the verified denominator.']:[]),...(!rows.length&&!baselines.length&&failedLabels.length?[`Cohort retrieval failed: ${failedLabels.join(', ')}. No result was calculated.`]:[]),identityActive?'These are first-observed entry-source cohorts using analytical linkage. Complete history and classification prevent a certified company-wide ranking; first-ever purchases are not established. The comparisons describe association, not causation.':'History, classification and source-specific customer linkage prevent a reliable company-wide collaboration ranking. These are first-observed source cohorts; first-ever TGF purchases are not established. The comparisons describe association, not causation.'];
  if(orderIdentity){lines.push('Guest orders with usable billing emails are included as email-linked records, separate from registered-customer identity. Unmatched anonymous orders remain isolated records; no customer IDs are invented.');for(const s of orderIdentity.sources||[])lines.push(`${s.source_store}: ${s.matched_orders} matched, ${s.unmatched_orders} unmatched, ${s.ambiguous_orders} ambiguous, ${s.unavailable_orders} unavailable of ${s.qualifying_orders} snapshot orders (all statuses); ${s.conflicting_orders} conflicting-email orders and ${s.shared_address_orders} shared-address orders (flags may overlap).`);}
  for(const source of [...new Set(rows.map(r=>r.source_platform+'/'+r.source_store))].sort((a,b)=>['woo/ww','woo/usd','shopify/shopify'].indexOf(a)-['woo/ww','woo/usd','shopify/shopify'].indexOf(b))){
    const candidates=rows.filter(r=>r.source_platform+'/'+r.source_store===source&&r.window_days===primary&&!r.entry_product_ref&&r.repeat_rate!==null);
    if(!candidates.length)continue;
    const count=e.definition?.sort==='returning_customers_desc';
    candidates.sort((a,b)=>(count?b.repeat_customers-a.repeat_customers:b.repeat_rate-a.repeat_rate)||b.mature_customers-a.mature_customers);
    const best=count?candidates[0].repeat_customers:candidates[0].repeat_rate,leaders=candidates.filter(r=>(count?r.repeat_customers:r.repeat_rate)===best);
    lines.push(`Among retrieved ${sourceLabel(candidates[0])} cohorts, **${leaders.map(r=>safe(rowLabel(r))).join(' and ')}** ${leaders.length>1?'tie for':'has'} ${count?'the most returning customers':'the highest observed repeat purchase rate'} at ${primary} days: **${count?best+' returning customers':(best*100).toFixed(2)+'%'}** (${candidates[0].repeat_customers} of ${candidates[0].mature_customers} mature customers). Small denominators make comparisons uncertain; no statistical significance is claimed.`);
  }
  if(!rows.length&&baselines.length)lines.push('Collaboration/item cohort results are unavailable; independently validated sitewide baselines are retained.');
  if(!rows.length&&!baselines.length)lines.push(e.source_outcomes?.some(s=>s.state==='rejected')?'No result was calculated for the failed components. No classified cohorts are available from the completed reads.':'No classified first-observed collaboration cohorts were retrieved. This does not establish zero customers or zero retention.');
  if(rows.length||baselines.length)lines.push('Samples below 30 mature customers are small; all eligible cohorts remain visible. Rates use verified mature customers only.');
  if(e.request_id)lines.push(`Request reference: ${safe(e.request_id)}.`);
  const table=part=>{
    const primaryRows=part.filter(r=>r.window_days===primary);
    const value=(r,key)=>!r?'Unavailable':key==='repeat_rate'?(r[key]===null?'Unavailable':(r[key]*100).toFixed(2)+'%'):r.observation_coverage_status==='unverified'&&key==='mature_customers'?'Unverified':r[key];
    return ['| Collaboration | First-observed customers | Mature 90-day customers | Repeat within 90 days | 90-day rate | Mature 180-day customers | Repeat within 180 days | 180-day rate | Mature 360-day customers | Repeat within 360 days | 360-day rate |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',...primaryRows.map(r=>{
      const paired=days=>part.find(x=>x.window_days===days&&x.collaboration_name===r.collaboration_name&&x.entry_product_ref===r.entry_product_ref);
      const cells=days=>{const x=paired(days);return [value(x,'mature_customers'),x?.observation_coverage_status==='unverified'?`${x.observed_repeat_customers} observed (coverage unverified)`:value(x,'repeat_customers'),value(x,'repeat_rate')];};
      return '| '+[safe(rowLabel(r)),r.cohort_customers,...cells(90),...cells(180),...cells(360)].join(' | ')+' |';})].join('\n');
  };
  for(const source of [...new Set([...rows,...baselines].map(r=>r.source_platform+'/'+r.source_store))].sort((a,b)=>['woo/ww','woo/usd','shopify/shopify'].indexOf(a)-['woo/ww','woo/usd','shopify/shopify'].indexOf(b))){
    const part=rows.filter(r=>r.source_platform+'/'+r.source_store===source);
    const population=part[0]||baselines.find(r=>r.source_platform+'/'+r.source_store===source);
    lines.push(`**${sourceLabel(population)}**`);
    const collaborations=part.filter(r=>!r.entry_product_ref);if(collaborations.length)lines.push(table(collaborations));
    for(const name of [...new Set(part.filter(r=>r.entry_product_ref).map(r=>r.collaboration_name))])lines.push(name?`**Pieces within ${safe(reviewedName(name))}**`:'**Items without a governed collaboration name**',table(part.filter(r=>r.entry_product_ref&&r.collaboration_name===name)));
    const c=e.coverage?.classification?.find(c=>c.source_platform===population.source_platform&&c.source_store===population.source_store);
    const baseline=baselines.filter(r=>r.source_platform===population.source_platform&&r.source_store===population.source_store);
    if(baseline.length)lines.push('**Comparable sitewide first-purchase baseline**',table(baseline));
    if(e.requested_components?.baseline){
      lines.push('**Comparable sitewide cohorts over time** (entry calendar year; first and last years use the requested partial-year boundaries).');
      const periods=conservativeRows(e.baseline_period_rows).filter(r=>r.source_platform===population.source_platform&&r.source_store===population.source_store);
      for(const year of [...new Set(periods.map(r=>r.cohort_year))].sort())lines.push(String(year),table(periods.filter(r=>r.cohort_year===year)));
      if(!periods.length)lines.push('Calendar-period sitewide evidence is unavailable.');
    }
    if(e.definition?.group_by?.[0]==='retention_piece_windows'){
      lines.push('**Whole-range first-purchase product rankings** (all eligible first-order products; customer cohorts overlap; up to ten per ranking).');
      const ranking=conservativeRows(e.product_ranking_rows).filter(r=>r.source_platform===population.source_platform&&r.source_store===population.source_store);
      for(const [key,title] of [['count_rank','By observed repeat-customer count'],['rate_rank','By mature repeat rate']]){const selected=ranking.filter(r=>r[key]!=null&&r[key]<=10).sort((a,b)=>a[key]-b[key]);lines.push(title);if(selected.length)lines.push(table(selected));else lines.push('Unavailable: no supported mature ranking evidence.');}
    }
    if(e.requested_components?.baseline&&!baseline.length)lines.push('Comparable sitewide baseline: unavailable for this source.');
    if(e.requested_components?.second_products){
      const products=part;
      lines.push('**Second-order products** (first strictly later eligible order within each stated window; observed customer counts, overlapping products; up to 10 products per cohort/window).');
      for(const r of products)lines.push(`${safe(rowLabel(r))} (${r.window_days} days): ${r.second_order_products==null?'unavailable':!r.second_order_products.length?(r.observed_repeat_customers?'no identifiable product rows returned (not zero repeat customers)':'none observed in this window'):r.second_order_products.map(p=>`${safe(p.product)}: ${p.observed_customers} observed, ${r.observation_coverage_status==='unverified'?'mature follow-up unverified':p.mature_repeat_customers+' mature repeats'}`).join('; ')}.${r.second_order_product_coverage?` Product evidence: ${r.second_order_product_coverage.missing_line_customers} repeat customers without order lines; ${r.second_order_product_coverage.unidentified_product_customers} with unidentified products; ${r.second_order_product_coverage.untitled_product_customers} with untitled products (flags may overlap).`:''}`);
    }
    if(c)lines.push(`Classification coverage: ${c.named_customers}/${c.eligible_first_customers} named; ${c.generic_only_customers} generic-only; ${c.core_only_customers??'unavailable'} explicitly core-only; ${c.unknown_customers} unknown or other (not assumed to be unclassified collaborations).`);
  }
  for(const outcome of (e.source_outcomes||[]).filter((o,i,all)=>all.findIndex(x=>x.source_platform===o.source_platform&&x.source_store===o.source_store)===i)){
    if([...rows,...baselines].some(r=>r.source_platform===outcome.source_platform&&r.source_store===outcome.source_store))continue;
    lines.push(`**${sourceLabel(outcome)}**`,outcome.state==='rejected'?(outcome.population_read==='completed'||outcome.stage==='evidence_validation'?'Warehouse read completed; its evidence failed validation. No incompatible figures are displayed.':'Read failed; no cohort result was calculated.'):outcome.state==='not_attempted'?'Read not attempted before the deadline; results are unavailable.':'The read completed without named cohorts. This does not establish zero retention.');
  }
  if(e.catalogue_reconciliation?.length){
    lines.push('**Governed collection reconciliation**', '| Source | Reviewed collection | Governed name | Eligible first-purchase matches | Status |', '|---|---|---|---|---|', ...e.catalogue_reconciliation.map(c=>`| ${sourceLabel(c)} | ${safe(c.display_name)} | ${safe(c.collaboration_name||'Unavailable')} | ${c.eligible_customers==null?'Unknown (missing evidence)':c.eligible_customers+' observed'} | ${safe(c.status.replaceAll('_',' '))}${c.governed_alias_collection_ids?.length?'; governed alias collections: '+c.governed_alias_collection_ids.map(safe).join(', '):''} |`));
  }
  for(const o of e.section_outcomes||[])if(o.state==='rejected')lines.push(`${sourceLabel(o)} ${o.component==='baseline_period_rows'?'calendar-period baseline':'whole-range product ranking'} evidence failed validation; independently validated report sections are retained.`);
  if(e.component_limitations?.length)lines.push(e.component_limitations.join(' '));
  lines.push('<details>\n<summary>Show details</summary>\n\n'+[
    `Cohort entry: ${e.periods[0].start_date} to ${e.periods[0].end_date}; observation ends ${e.observation_end} (${e.definition?.time_zone||'UTC'} calendar dates).`,
    ...rows.filter((r,i)=>rows.findIndex(x=>x.source_platform===r.source_platform&&x.source_store===r.source_store)===i).map(r=>`${sourceLabel(r)} follow-up coverage: ${r.observation_coverage_status==='verified_continuous'?'verified continuous interval':'unverified'}; verified interval ${r.verified_coverage_start||'unavailable'} to ${r.verified_coverage_end||'unavailable'}. Requested cutoff ${e.observation_end}; observed endpoints below are separate. ${r.coverage_evidence?`Evidence: ${safe(r.coverage_evidence)}.`:''}`),
    ...rows.filter(r=>r.observed_repeat_customers>r.repeat_customers).map(r=>`${sourceLabel(r)} / ${safe(rowLabel(r))}, ${r.window_days} days: ${r.observed_repeat_customers} observed repeat customers across ${r.cohort_customers} entries, including ${r.observed_repeat_customers-r.repeat_customers} outside the verified mature denominator. These observed returns do not certify full follow-up for non-returners.`),
    'First observed in all available governed history, with lookback before entry dates. Prior collection coverage is unverified; first-ever purchases are not established. Left-censoring can classify an existing customer as new. This is not the first collaboration purchase of an already observed customer.',
    'Only governed named collaborations compete. Broad collaboration membership is excluded from ranking. Active classifications and approved identity/reporting-family routes describe the current governed catalogue view, not certified purchase-time classifications. Current publication status is not an eligibility filter. Conflicting names on one product are excluded from named ranking; individual items with governed collaboration membership remain visible without an inferred name. Separately classified products on the same entry order may form overlapping cohorts.',
    'Each customer counts once per named collaboration and once per piece within it. Multi-collaboration and multi-piece entry cohorts overlap and must not be added. Tied entry timestamps use source and order reference order; subsequent orders must be strictly later. Returns/cancellations follow source eligibility: fully refunded orders, cancelled Shopify orders and migrated imports are excluded; partial refunds remain eligible.',
    'Mature denominators require 90/180/360 full calendar days within evidence-backed continuous source coverage and the requested cutoff. Latest activity alone never certifies coverage. Retired sources require an evidenced coverage boundary; a public migration date does not certify complete follow-up. Unverified windows have no supported rate; observed repeats include identifiable returns even when full follow-up is unverified and are not divided by an unverified denominator. Repeat means the first subsequent eligible purchase in the requested channel within that calendar-day window. Median elapsed days is conditional on that repeat among mature entries. Same, other collaboration and explicitly governed core range are exclusive buckets; mixed, unclassified and ambiguous second orders are unknown. Missing classifications do not establish core range.',
    identityActive?`Shopify eligibility includes Online and In-store orders; Woo evidence is online. Customers are assigned to their first-observed entry source after analytical linkage. Square remains excluded. ${orderIdentity?'Guest orders participate as email-linked records when usable billing evidence is available; unmatched anonymous orders remain isolated records.':'Unknown guests are excluded.'} Unmatched identified profiles retain local histories. Coverage counts describe the available qualifying warehouse history, not verified people or a certified company-wide population.`:'Shopify eligibility includes Online and In-store orders using persisted retail_location_id; it is not online-only. The combined-channel cohort measures the first observed purchase across those Shopify channels, not separate per-channel denominators. Woo evidence is online. Woo UK, Woo US and Shopify retain separate identities; cross-platform customer linkage has not been verified. Square is not in this cohort provider, including anonymous POS purchases. Source-specific results are not a deduplicated company-wide population. Unknown guests are excluded. The number and share of requested customers that cannot be evaluated are unknown.',
    ...(e.coverage?.classification?.length?e.coverage.classification.map(c=>`${sourceLabel(c)}: ${c.eligible_first_customers} eligible identified first-observed customers/orders; ${c.named_customers} named matches; ${c.generic_only_customers} generic-only; ${c.unknown_customers} unknown/ambiguous or other; ${c.conflicting_customers??'unknown'} with conflicting named classifications (may overlap other coverage buckets). Observed order history ${c.history_start?.value||c.history_start} to ${c.history_end?.value||c.history_end}; ${c.identified_orders} identified orders; ${c.anonymous_orders} anonymous orders; ${c.migrated_orders} migration exclusions; ${c.cancelled_orders??'unknown'} cancellation exclusions; ${c.excluded_orders} status/refund exclusions (reasons may overlap). Observed endpoints do not certify continuous history.`):['Numeric classification/history/linkage coverage was not returned by the provider; unavailable counts are unknown.']),
    ...(e.coverage?.classification||[]).filter(c=>c.classification_stages).map(c=>`${sourceLabel(c)} first-order product evidence: ${c.classification_stages.map(s=>s.collaboration_state==='order_lines_absent'?`No first-order line evidence: ${s.customers} customers (zero product lines)`:`${s.collaboration_state==='product_identity_unmatched'?(s.customers>s.product_lines?'Missing product identifiers or first-order line evidence (legacy combined diagnostic)':'Missing product identifiers'):display(s.collaboration_state)}: ${s.product_lines} grouped order-product rows / ${s.customers} customers`).join('; ')}. Customer counts overlap across states on mixed orders.`),
    ...(e.coverage?.source_status||[]).filter(s=>s.status!=='observed_endpoints_only').map(s=>`${sourceLabel(s)}: ${s.status==='unavailable'?'provider unavailable':'source history/classification coverage was not returned'}. The population count is unknown.`),
    identityActive?'Customer links use a frozen analytical email snapshot. Matrixify copies remain excluded from transactions. Prior history, follow-up, original-date/product provenance and classification coverage remain independently unverified.':HISTORY_LIMITATION,
    'Source-history availability, current classification availability and customer-linkage coverage are separate limitations. Absent periods are missing evidence, never zero activity. Cohorts with fewer than 30 mature customers are small samples; no minimum-size eligibility exclusion or statistical significance claim is applied. No causal claim is applied.',
    ...(e.coverage?.failed_sources?.length?[`Source evidence unavailable: ${e.coverage.failed_sources.join(', ')}. ${rows.length?'Supported results are retained; ':''}missing sources are not zero.`]:[]),
    ...(e.source_outcomes||[]).map(o=>`${sourceLabel(o)} calculation: ${o.state==='fulfilled'?'read completed':o.state==='not_attempted'?'not attempted before deadline':o.population_read==='completed'||o.stage==='evidence_validation'?'warehouse read completed; evidence validation rejected this component':'read failed'}${o.http_status?` (HTTP ${o.http_status})`:''}. ${o.identity_evidence?` Identity: ${safe(o.identity_evidence.activation)} (${safe(o.identity_evidence.mode)})${o.identity_evidence.snapshot?'; snapshot '+safe(o.identity_evidence.snapshot):''}${o.identity_evidence.reason?'; '+safe(o.identity_evidence.reason):''}.`:''} Detailed diagnostics are retained with the evidence.`),
    ...(e.truncated?['The requested-rate ranking is bounded. A row bound was reached; additional collaborations or pieces may be absent.']:[])
  ].join('\n\n')+'\n\n</details>');return lines.join('\n\n');
}
export function retentionCoverage(rows=[]){
  if(!Array.isArray(rows)||rows.length>3)throw new Error('Invalid retention coverage');
  return rows.map(c=>{
    const keys=['eligible_first_customers','named_customers','generic_only_customers','unknown_customers','identified_orders','anonymous_orders','migrated_orders','excluded_orders'];
    if(!['woo','shopify'].includes(c.source_platform)||typeof c.source_store!=='string'||!keys.every(k=>c[k]!==null&&c[k]!==undefined&&typeof c[k]!=='boolean'&&c[k]!==''&&Number.isSafeInteger(Number(c[k]))&&Number(c[k])>=0))throw new Error('Invalid retention coverage count');
    const out=Object.fromEntries(keys.map(k=>[k,Number(c[k])]));
    if(out.named_customers+out.generic_only_customers+out.unknown_customers+Number(c.core_only_customers||0)!==out.eligible_first_customers)throw new Error('Invalid retention coverage partition');
    const day=k=>c[k]?.value||c[k];
    if(!['history_start','history_end'].every(k=>/^\d{4}-\d{2}-\d{2}$/.test(day(k)))||day('history_start')>day('history_end'))throw new Error('Invalid retention history coverage');
    if(c.conflicting_customers!=null&&(!Number.isSafeInteger(Number(c.conflicting_customers))||Number(c.conflicting_customers)<0||Number(c.conflicting_customers)>out.eligible_first_customers))throw new Error('Invalid conflicting coverage');
    const stages=c.classification_stages;
    if(stages!=null&&(!Array.isArray(stages)||stages.some(x=>!['order_lines_absent','product_identity_unmatched','classification_absent','generic_only','named','conflicting','core'].includes(x.collaboration_state)||!['product_lines','customers'].every(k=>Number.isSafeInteger(Number(x[k]))&&Number(x[k])>=0))))throw new Error('Invalid classification stages');
    if(c.core_only_customers!=null&&(!Number.isSafeInteger(Number(c.core_only_customers))||Number(c.core_only_customers)<0))throw Error('Invalid core coverage');
    return {...out,...(c.core_only_customers!=null?{core_only_customers:Number(c.core_only_customers)}:{}),...(stages?{classification_stages:stages.map(x=>({...x,product_lines:Number(x.product_lines),customers:Number(x.customers)}))}:{}),conflicting_customers:c.conflicting_customers==null?null:Number(c.conflicting_customers),source_platform:c.source_platform,source_store:c.source_store,history_start:day('history_start'),history_end:day('history_end'),cancelled_orders:c.cancelled_orders==null?null:Number(c.cancelled_orders)};
  });
}
export async function answerCohortRetention({context,provider,...options}){
  const request_id=requestId(options.requestId||options.request_id);
  if(!provider?.analyzeCustomerJourney)return {request_id,answer:`No result was calculated: the governed customer-journey provider binding is missing. Request reference: ${request_id}.`,component_outcomes:['ww','usd','shopify'].map(source_store=>({component:source_store,status:'missing_binding',attempted:false})),analysis_unavailable:true,analysis_context:context,tools:[]};
  const definition=retentionDefinition(context);
  if(context.output_preference&&options.recentEvidence?.evidence?.kind==='governed_cohort_retention'){
    const cached=options.recentEvidence.evidence;
    try{
      assertPlanAgreement(context,cached);assertAnswerCompleteness(context,{evidence:cached,partial:true});
      const evidence={...cached,component_limitations:[cached.rows?.length?'The supported table is retained. A governed cohort export or chart is not implemented.':'No cohort table is available. A governed cohort export or chart is not implemented.']};
      return {answer:retentionMarkdown(evidence),evidence,analysis_context:context,partial:true,tools:[]};
    }catch{/* A changed/invalid scope requires a fresh governed read. */}
  }
  const failed_sources=[],results=[],baseline_rows=[],baseline_period_rows=[],product_ranking_rows=[],catalogue_reconciliation=[],classification=[],source_outcomes=[],section_outcomes=[];let truncated=false;
  const readOptions={...options,deadlineAt:options.deadlineAt??Date.now()+45000};
  const groups=[...(context.journey_group_by==='collaboration_piece'?['retention_windows','retention_piece_windows']:definition.group_by),...(context.retention_baseline?['retention_baseline_windows']:[])];
  // Each component has its own complete-window budget. Items and baselines
  // cannot consume the named-collaboration quota. Three sources: at most 600 rows.
  const componentLimit=group=>['retention_windows','retention_piece_windows'].includes(group)?99:group==='retention_baseline_windows'?3:48;
  // Start independent sources together under the unchanged request deadline.
  // A slow source must not consume another source's opportunity to submit.
  const parts=await Promise.all([['woo','ww'],['woo','usd'],['shopify','shopify']].map(async ([source,source_store])=>{
   const failed_sources=[],results=[],baseline_rows=[],baseline_period_rows=[],product_ranking_rows=[],catalogue_reconciliation=[],classification=[],source_outcomes=[],section_outcomes=[];let truncated=false;
   for(const group of groups){
    let stage='provider_contract',query_id=null,readCompleted=false,providerIdentity=null;const timings=[];
    const outcome={request_id,source_platform:source,source_store,group,attempted:true};
    if(readOptions.deadlineAt<=Date.now()){source_outcomes.push({...outcome,attempted:false,state:'not_attempted',status:'not_attempted',stage:'request_deadline'});if(!failed_sources.includes(source))failed_sources.push(source);continue;}
    try{
      const part=await boundedEvidenceRead(timeoutMs=>provider.analyzeCustomerJourney({...definition,limit:componentLimit(group),group_by:[group],cohort:{...definition.cohort,entry_source:source,...(group==='retention_baseline_windows'?{entry_product_classification:null,entry_product_ref:null}:{})}},{...readOptions,timeoutMs,sourceStore:source_store,onProviderStage:event=>{if(['snapshot_read','identity_coverage'].includes(event.identity_stage)){options.onProviderStage?.(event);return;}stage=event.stage==='query_start'?'population_query':stage;if(timings.length<12&&['query_start','query_submission','query_response','query_results','query_failed'].includes(event.stage)&&Number.isFinite(event.elapsed_ms))timings.push({stage:event.stage,elapsed_ms:Math.min(3600000,Math.max(0,Math.round(event.elapsed_ms)))});if(event.query_id)query_id=event.query_id;options.onProviderStage?.(event);}}),readOptions);
      readCompleted=true;providerIdentity=part?.identity_evidence||null;stage='evidence_validation';
      if(!part||!Array.isArray(part.results))throw new Error('Invalid retention evidence');
      const validated=retentionRows(part.results||[]);
      if(group==='retention_baseline_windows'&&(validated.length>3||validated.some(r=>r.collaboration_name!=='Sitewide'||r.entry_product_ref)))throw Error('Invalid sitewide baseline');
      if(validated.some(r=>r.source_platform!==source||r.source_store!==source_store))throw new Error('Retention source mismatch');
      if(validated.some(r=>(['retention_windows','retention_baseline_windows'].includes(group))===Boolean(r.entry_product_ref)))throw new Error('Retention grouping mismatch');
      if((part.results||[]).length>componentLimit(group))throw new Error('Retention provider row bound exceeded');
      const coverage=retentionCoverage(part.classification_coverage||[]);
      if(coverage.some(c=>c.source_platform!==source||c.source_store!==source_store))throw new Error('Retention coverage source mismatch');
      if(group==='retention_windows'&&part.catalogue_reconciliation)catalogue_reconciliation.push(...reconcileRetentionCatalogue(part.catalogue_reconciliation,validated,{source_platform:source,source_store}));
      for(const [key,target] of [['baseline_period_rows',baseline_period_rows],['product_ranking_rows',product_ranking_rows]]){
        if(part[key])try{
          const section=retentionRows(part[key]);
          if(section.some(r=>r.source_platform!==source||r.source_store!==source_store)||section.length>(key==='baseline_period_rows'?150:60)||section.some(r=>key==='baseline_period_rows'?r.collaboration_name!=='Sitewide'||!Number.isInteger(r.cohort_year)||r.cohort_year<Number(context.start_date.slice(0,4))||r.cohort_year>Number(context.end_date.slice(0,4)):!r.entry_product_ref||!Number.isInteger(r.count_rank)||r.count_rank<1||r.rate_rank!=null&&(!Number.isInteger(r.rate_rank)||r.rate_rank<1)))throw Error('Invalid retention section');
          if(key==='baseline_period_rows'&&section.length&&validated.some(total=>['cohort_customers','mature_customers','repeat_customers','observed_repeat_customers'].some(k=>section.filter(r=>r.window_days===total.window_days).reduce((n,r)=>n+r[k],0)!==total[k])))throw Error('Invalid retention section');
          target.push(...section);section_outcomes.push({source_platform:source,source_store,component:key,state:'fulfilled',query_id});
        }catch{section_outcomes.push({source_platform:source,source_store,component:key,state:'rejected',stage:'evidence_validation',population_read:'completed',code:'EVIDENCE_SCOPE_MISMATCH',query_id});}
      }
      source_outcomes.push({...outcome,...(part.identity_evidence?{identity_evidence:part.identity_evidence}:{}),population_read:'completed',state:'fulfilled',status:validated.length?(validated.some(r=>r.observation_coverage_status==='unverified')?'coverage_unverified':'classified_cohorts'):coverage.some(c=>c.eligible_first_customers>0)?'unclassified_population':'successful_empty',stage:'complete',query_id,timings});
      if(group==='retention_baseline_windows')baseline_rows.push(...validated);else results.push(...validated);if(!classification.length)classification.push(...coverage);
      truncated ||= Boolean(part.truncated);
    }catch(error){if(error.code==='LEASE_NOT_OWNED'||error.code==='REQUEST_CANCELLED'||options.signal?.aborted)throw error;const failure=safeReadFailure(error,stage);
      source_outcomes.push({...outcome,...((error.identity_evidence||providerIdentity)?{identity_evidence:error.identity_evidence||providerIdentity}:{}),population_read:readCompleted?'completed':'unavailable',...(readCompleted?{validation_reason:retentionValidationReason(error)}:{}),state:'rejected',status:stage==='evidence_validation'?'evidence_rejected':failure.code==='COHORT_ARGUMENT_REJECTED'?'arguments_rejected':'retrieval_failed',...failure,stage,code:stage==='evidence_validation'?'EVIDENCE_SCOPE_MISMATCH':failure.code==='ORDER_VALUE_RETRIEVAL_FAILED'?'COHORT_RETRIEVAL_FAILED':failure.code,timeout_category:error.code==='ORACLE_AGENT_DEADLINE'?'request_deadline':failure.bigquery_reason==='jobTimeout'?'warehouse_timeout':['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(failure.provider_reason)?'transport_timeout':null,query_id,timings});
      const failed=groups.length>1?source+'/'+group:source;if(!failed_sources.includes(failed))failed_sources.push(failed);}
  }
   return {failed_sources,results,baseline_rows,baseline_period_rows,product_ranking_rows,catalogue_reconciliation,classification,source_outcomes,section_outcomes,truncated};
  }));
  for(const part of parts){section_outcomes.push(...part.section_outcomes);for(const failed of part.failed_sources)if(!failed_sources.includes(failed))failed_sources.push(failed);baseline_period_rows.push(...part.baseline_period_rows);product_ranking_rows.push(...part.product_ranking_rows);catalogue_reconciliation.push(...part.catalogue_reconciliation);results.push(...part.results);baseline_rows.push(...part.baseline_rows);classification.push(...part.classification);source_outcomes.push(...part.source_outcomes);truncated ||= part.truncated;}
  const result={definition,results};
  const rows=retentionRows(result.results||[],definition.sort,definition.ranking_window);
  const evidence={request_id,source_outcomes,section_outcomes,baseline_period_rows,product_ranking_rows,catalogue_reconciliation,requested_components:{baseline:Boolean(context.retention_baseline),second_products:Boolean(context.retention_second_products)},ranking_window:context.ranking_metric==='repeat_rate_360'?360:context.ranking_metric==='repeat_rate_180'?180:context.within_days||90,component_limitations:context.output_preference?[rows.length?'The supported table is retained. A governed cohort export or chart is not implemented.':'No cohort table is available. A governed cohort export or chart is not implemented.']:[],baseline_rows,kind:'governed_cohort_retention',subject:'customer_journey',operation:'cohort_retention',periods:[{start_date:context.start_date,end_date:context.end_date}],observation_end:definition.observation_end,definition:result.definition,rows,truncated,coverage:{classification,source_status:[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source_platform,source_store])=>({source_platform,source_store,status:classification.some(c=>c.source_platform===source_platform&&c.source_store===source_store)?'observed_endpoints_only':source_outcomes.some(s=>s.source_store===source_store&&s.state==='rejected')?'unavailable':'coverage_not_returned'})),failed_sources,unevaluable_customers:null,unevaluable_share:null,complete:false,identity:source_outcomes.find(s=>s.identity_evidence?.activation==='active')?.identity_evidence.mode||'source_qualified_only',identity_activation:source_outcomes.filter(s=>s.identity_evidence).map(s=>({source_store:s.source_store,...s.identity_evidence})),prior_history:'unverified',customer_history:customerHistoryContract(source_outcomes.some(s=>s.identity_evidence?.activation==='active'))}};
  return {request_id,answer:retentionMarkdown(evidence),evidence,analysis_context:context,partial:true,...(!rows.length&&!baseline_rows.length?{analysis_unavailable:true}:{}),tools:['analyze_customer_journey']};
}
