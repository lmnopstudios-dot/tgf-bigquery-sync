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
  return {...applyJourneyAnalysisContext({},context),ranking_window:context.ranking_metric==='repeat_rate_180'?180:context.within_days||90,group_by:[context.journey_group_by==='entry_product'?'retention_product_windows':context.journey_group_by==='collaboration_piece'?'retention_piece_windows':'retention_windows'],
    cohort:{entry_product_classification:context.entry_product_classification||'collaboration',entry_channel:context.channel==='instore'?'In-store':context.channel==='online'?'Online':null},
    subsequent:{channel:context.channel==='instore'?'In-store':context.channel==='online'?'Online':null},
    sort:context.sort||'repeat_rate_desc',limit:context.channel_breakdown||context.journey_group_by==='collaboration_piece'?50:100};
}
export function retentionRows(rows,sort='repeat_rate_desc',rankingWindow=90){
  if(!Array.isArray(rows)||rows.length>200)throw new Error('Retention row bound exceeded');
  return rows.filter(row=>!['collaboration','collaborations'].includes(row.collaboration_name)).map(row=>{
    const count=key=>{const n=Number(row[key]);if(row[key]===null||row[key]===undefined||typeof row[key]==='boolean'||row[key]===''||!Number.isInteger(n)||n<0)throw new Error('Invalid retention count');return n;};
    const cohort_customers=count('cohort_customers'),mature_customers=count('mature_customers'),repeat_customers=count('repeat_customers');
    if(repeat_customers>mature_customers||mature_customers>cohort_customers||![90,180].includes(Number(row.window_days)))throw new Error('Invalid retention denominator');
    const median=row.median_days_to_second==null?null:Number(row.median_days_to_second);
    if(median!==null&&(!Number.isFinite(median)||median<0||median>=Number(row.window_days)+2)||repeat_customers===0&&median!==null||repeat_customers>0&&median===null)throw new Error('Invalid conditional retention median');
    if(!['woo','shopify'].includes(row.source_platform)||!row.source_store||!row.collaboration_name&&!row.entry_product_ref)throw new Error('Missing retention population');
    const secondKeys=['same_collaboration','different_collaboration','core_range','unknown'];
    const second=Object.fromEntries(secondKeys.map(k=>[k,row[k]==null?null:count(k)]));
    if(secondKeys.some(k=>second[k]!==null)&&(!secondKeys.every(k=>second[k]!==null)||secondKeys.reduce((n,k)=>n+second[k],0)!==repeat_customers))throw new Error('Invalid second-purchase classification');
    return {...second,...(row.entry_product_ref?{entry_product_ref:row.entry_product_ref,entry_product:row.entry_product}:{}),source_platform:row.source_platform,source_store:row.source_store,collaboration_name:row.collaboration_name,window_days:Number(row.window_days),cohort_customers,mature_customers,repeat_customers,repeat_rate:mature_customers?repeat_customers/mature_customers:null,median_days_to_second:median};
  }).sort((a,b)=>a.source_platform.localeCompare(b.source_platform)||a.source_store.localeCompare(b.source_store)||(a.window_days===rankingWindow?0:1)-(b.window_days===rankingWindow?0:1)||(sort==='returning_customers_desc'?b.repeat_customers-a.repeat_customers:0)||(b.repeat_rate??-1)-(a.repeat_rate??-1)||b.mature_customers-a.mature_customers||String(a.entry_product_ref||a.collaboration_name).localeCompare(String(b.entry_product_ref||b.collaboration_name)));
}
const display=value=>String(value||'Unknown').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
const label=r=>r.entry_product||display(r.collaboration_name);
const sourceLabel=r=>r.source_platform==='woo'?(r.source_store==='ww'?'Woo UK':'Woo US'):r.source_platform==='shopify'?'Shopify':display(r.source_platform);
const safe=value=>String(value).replaceAll('|','\\|').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function retentionMarkdown(e){
  const primary=e.ranking_window||90,rows=retentionRows(e.rows||[],e.definition?.sort,primary);
  const failedLabels=[...new Set((e.source_outcomes||[]).filter(s=>s.state==='rejected').map(sourceLabel))];
  const lines=[...(!rows.length&&failedLabels.length?[`Cohort retrieval failed: ${failedLabels.join(', ')}. No result was calculated.`]:[]),'History, classification and source-specific customer linkage prevent a reliable company-wide collaboration ranking. These are first-observed source cohorts; first-ever TGF purchases are not established. The comparisons describe association, not causation.'];
  for(const source of [...new Set(rows.map(r=>r.source_platform+'/'+r.source_store))]){
    const candidates=rows.filter(r=>r.source_platform+'/'+r.source_store===source&&r.window_days===primary&&!r.entry_product_ref&&r.repeat_rate!==null);
    if(!candidates.length)continue;
    const count=e.definition?.sort==='returning_customers_desc';
    candidates.sort((a,b)=>(count?b.repeat_customers-a.repeat_customers:b.repeat_rate-a.repeat_rate)||b.mature_customers-a.mature_customers);
    const best=count?candidates[0].repeat_customers:candidates[0].repeat_rate,leaders=candidates.filter(r=>(count?r.repeat_customers:r.repeat_rate)===best);
    lines.push(`Among retrieved ${sourceLabel(candidates[0])} cohorts, **${leaders.map(r=>safe(label(r))).join(' and ')}** ${leaders.length>1?'tie for':'has'} ${count?'the most returning customers':'the highest observed repeat purchase rate'} at ${primary} days: **${count?best+' returning customers':(best*100).toFixed(2)+'%'}** (${candidates[0].repeat_customers} of ${candidates[0].mature_customers} mature customers). Small denominators make comparisons uncertain; no statistical significance is claimed.`);
  }
  if(!rows.length)lines.push(e.source_outcomes?.some(s=>s.state==='rejected')?'No result was calculated for the failed components. No classified cohorts are available from the completed reads.':'No classified first-observed collaboration cohorts were retrieved. This does not establish zero customers or zero retention.');
  if(e.request_id)lines.push(`Request reference: ${safe(e.request_id)}.`);
  const table=part=>['| Source | Collaboration / piece | Days | Entry customers | Mature customers | Repeat | Rate | Median days to second | Same / other / core / unknown | Sample |','|---|---|---|---|---|---|---|---|---|---|',...part.map(r=>`| ${sourceLabel(r)} | ${safe(label(r))} | ${r.window_days} | ${r.cohort_customers} | ${r.mature_customers} | ${r.repeat_customers} | ${r.repeat_rate===null?'Unavailable':(r.repeat_rate*100).toFixed(2)+'%'} | ${r.median_days_to_second==null?'Unavailable':r.median_days_to_second.toFixed(1)} | ${r.same_collaboration==null?'Unavailable':[r.same_collaboration,r.different_collaboration,r.core_range,r.unknown].join(' / ')} | ${r.mature_customers===0?'Immature':r.mature_customers<30?'Small (<30 mature)':'—'} |`)].join('\n');
  const collaborations=rows.filter(r=>!r.entry_product_ref),pieces=rows.filter(r=>r.entry_product_ref);
  if(collaborations.length)lines.push(table(collaborations));
  if(pieces.length){for(const name of [...new Set(pieces.map(r=>r.collaboration_name))])lines.push(`**Pieces within ${safe(display(name))}**\n\n${table(pieces.filter(r=>r.collaboration_name===name))}`);}
  if(e.component_limitations?.length)lines.push(e.component_limitations.join(' '));
  lines.push('<details>\n<summary>Show details</summary>\n\n'+[
    `Cohort entry: ${e.periods[0].start_date} to ${e.periods[0].end_date}; observation ends ${e.observation_end} (${e.definition?.time_zone||'UTC'} calendar dates).`,
    'First observed in all available governed history, with lookback before entry dates. Prior collection coverage is unverified; first-ever purchases are not established. Left-censoring can classify an existing customer as new. This is not the first collaboration purchase of an already observed customer.',
    'Only governed named collaborations compete. Broad collaboration membership is excluded from ranking. Active classifications and approved identity/reporting-family routes describe the current governed catalogue view, not certified purchase-time classifications. Current publication status is not an eligibility filter. Conflicting names on one product are excluded; separately classified products on the same entry order may form overlapping cohorts.',
    'Each customer counts once per named collaboration and once per piece within it. Multi-collaboration and multi-piece entry cohorts overlap and must not be added. Tied entry timestamps use source and order reference order; subsequent orders must be strictly later. Returns/cancellations follow source eligibility: fully refunded orders, cancelled Shopify orders and migrated imports are excluded; partial refunds remain eligible.',
    'Mature denominators require 90/180 full calendar days by the observation cutoff. Repeat means the first subsequent eligible purchase in the requested channel within that calendar-day window. Median elapsed days is conditional on that repeat among mature entries. Same, other collaboration and explicitly governed core range are exclusive buckets; mixed, unclassified and ambiguous second orders are unknown. Missing classifications do not establish core range.',
    'Shopify eligibility includes Online and In-store orders using persisted retail_location_id; it is not online-only. The combined-channel cohort measures the first observed purchase across those Shopify channels, not separate per-channel denominators. Woo evidence is online. Woo UK, Woo US and Shopify retain separate identities; no verified cross-platform customer bridge exists. Square is not in this cohort provider, including anonymous POS purchases. Source-specific results are not a deduplicated company-wide population. Unknown guests are excluded. The number and share of requested customers that cannot be evaluated are unknown.',
    ...(e.coverage?.classification?.length?e.coverage.classification.map(c=>`${sourceLabel(c)}: ${c.eligible_first_customers} eligible identified first-observed customers/orders; ${c.named_customers} named matches; ${c.generic_only_customers} generic-only; ${c.unknown_customers} unknown/ambiguous or outside collaboration; ${c.conflicting_customers??'unknown'} with conflicting named classifications (may overlap other coverage buckets). Observed order history ${c.history_start?.value||c.history_start} to ${c.history_end?.value||c.history_end}; ${c.identified_orders} identified orders; ${c.anonymous_orders} anonymous orders; ${c.migrated_orders} migration exclusions; ${c.cancelled_orders??'unknown'} cancellation exclusions; ${c.excluded_orders} status/refund exclusions (reasons may overlap). Observed endpoints do not certify continuous history.`):['Numeric classification/history/linkage coverage was not returned by the provider; unavailable counts are unknown.']),
    ...(e.coverage?.classification||[]).filter(c=>c.classification_stages).map(c=>`${sourceLabel(c)} first-order product evidence: ${c.classification_stages.map(s=>`${s.collaboration_state}: ${s.product_lines} product lines / ${s.customers} customers`).join('; ')}. Customer counts overlap across states on mixed orders.`),
    ...(e.coverage?.source_status||[]).filter(s=>s.status!=='observed_endpoints_only').map(s=>`${sourceLabel(s)}: ${s.status==='unavailable'?'provider unavailable':'source history/classification coverage was not returned'}. The population count is unknown.`),
    'Source-history availability, current classification availability and customer-linkage coverage are separate limitations. Absent periods are missing evidence, never zero activity. Small flags identify fewer than 30 mature customers for review, without changing eligibility or establishing statistical significance. No causal claim is applied.',
    ...(e.coverage?.failed_sources?.length?[`Source evidence unavailable: ${e.coverage.failed_sources.join(', ')}. ${rows.length?'Supported results are retained; ':''}missing sources are not zero.`]:[]),
    ...(e.source_outcomes?.length?[`Component diagnostics: ${safe(JSON.stringify(e.source_outcomes))}`]:[]),
    ...(e.truncated?['The requested-rate ranking is bounded. A row bound was reached; additional collaborations or pieces may be absent.']:[])
  ].join('\n\n')+'\n\n</details>');return lines.join('\n\n');
}
export function retentionCoverage(rows=[]){
  if(!Array.isArray(rows)||rows.length>3)throw new Error('Invalid retention coverage');
  return rows.map(c=>{
    const keys=['eligible_first_customers','named_customers','generic_only_customers','unknown_customers','identified_orders','anonymous_orders','migrated_orders','excluded_orders'];
    if(!['woo','shopify'].includes(c.source_platform)||typeof c.source_store!=='string'||!keys.every(k=>c[k]!==null&&c[k]!==undefined&&typeof c[k]!=='boolean'&&c[k]!==''&&Number.isSafeInteger(Number(c[k]))&&Number(c[k])>=0))throw new Error('Invalid retention coverage count');
    const out=Object.fromEntries(keys.map(k=>[k,Number(c[k])]));
    if(out.named_customers+out.generic_only_customers+out.unknown_customers!==out.eligible_first_customers)throw new Error('Invalid retention coverage partition');
    const day=k=>c[k]?.value||c[k];
    if(!['history_start','history_end'].every(k=>/^\d{4}-\d{2}-\d{2}$/.test(day(k)))||day('history_start')>day('history_end'))throw new Error('Invalid retention history coverage');
    if(c.conflicting_customers!=null&&(!Number.isSafeInteger(Number(c.conflicting_customers))||Number(c.conflicting_customers)<0||Number(c.conflicting_customers)>out.eligible_first_customers))throw new Error('Invalid conflicting coverage');
    const stages=c.classification_stages;
    if(stages!=null&&(!Array.isArray(stages)||stages.some(x=>!['product_identity_unmatched','classification_absent','generic_only','named','conflicting','core'].includes(x.collaboration_state)||!['product_lines','customers'].every(k=>Number.isSafeInteger(Number(x[k]))&&Number(x[k])>=0))))throw new Error('Invalid classification stages');
    return {...out,...(stages?{classification_stages:stages.map(x=>({...x,product_lines:Number(x.product_lines),customers:Number(x.customers)}))}:{}),conflicting_customers:c.conflicting_customers==null?null:Number(c.conflicting_customers),source_platform:c.source_platform,source_store:c.source_store,history_start:day('history_start'),history_end:day('history_end'),cancelled_orders:c.cancelled_orders==null?null:Number(c.cancelled_orders)};
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
  const failed_sources=[],results=[],classification=[],source_outcomes=[];let truncated=false;
  const readOptions={...options,deadlineAt:options.deadlineAt??Date.now()+45000};
  const groups=context.journey_group_by==='collaboration_piece'?['retention_windows','retention_piece_windows']:definition.group_by;
  // Independent platform reads retain a supported population on another failure.
  for(const [source,source_store] of [['woo','ww'],['woo','usd'],['shopify','shopify']])for(const group of groups){
    let stage='provider_contract',query_id=null;
    const outcome={request_id,source_platform:source,source_store,group,attempted:true};
    if(readOptions.deadlineAt<=Date.now()){source_outcomes.push({...outcome,attempted:false,state:'not_attempted',status:'not_attempted',stage:'request_deadline'});if(!failed_sources.includes(source))failed_sources.push(source);continue;}
    try{
      const part=await boundedEvidenceRead(timeoutMs=>provider.analyzeCustomerJourney({...definition,group_by:[group],cohort:{...definition.cohort,entry_source:source}},{...readOptions,timeoutMs,sourceStore:source_store,onProviderStage:event=>{stage=event.stage==='query_start'?'population_query':stage;if(event.query_id)query_id=event.query_id;options.onProviderStage?.(event);}}),readOptions);
      stage='evidence_validation';
      if(!part||!Array.isArray(part.results))throw new Error('Invalid retention evidence');
      const validated=retentionRows(part.results||[]);
      if(validated.some(r=>r.source_platform!==source||r.source_store!==source_store))throw new Error('Retention source mismatch');
      if(validated.some(r=>(group==='retention_windows')===Boolean(r.entry_product_ref)))throw new Error('Retention grouping mismatch');
      if((part.results||[]).length>definition.limit)throw new Error('Retention provider row bound exceeded');
      const coverage=retentionCoverage(part.classification_coverage||[]);
      if(coverage.some(c=>c.source_platform!==source||c.source_store!==source_store))throw new Error('Retention coverage source mismatch');
      source_outcomes.push({...outcome,state:'fulfilled',status:validated.length?'classified_cohorts':coverage.some(c=>c.eligible_first_customers>0)?'unclassified_population':'successful_empty',stage:'complete',query_id});
      results.push(...validated);if(group===groups[0])classification.push(...coverage);
      truncated ||= Boolean(part.truncated)||(part.results||[]).length===definition.limit;
    }catch(error){if(error.code==='LEASE_NOT_OWNED'||error.code==='REQUEST_CANCELLED'||options.signal?.aborted)throw error;const failure=safeReadFailure(error,stage);
      source_outcomes.push({...outcome,state:'rejected',status:stage==='evidence_validation'?'evidence_rejected':failure.code==='COHORT_ARGUMENT_REJECTED'?'arguments_rejected':'retrieval_failed',...failure,stage,code:stage==='evidence_validation'?'EVIDENCE_SCOPE_MISMATCH':failure.code==='ORDER_VALUE_RETRIEVAL_FAILED'?'COHORT_RETRIEVAL_FAILED':failure.code,timeout_category:error.code==='ORACLE_AGENT_DEADLINE'?'request_deadline':failure.bigquery_reason==='jobTimeout'?'warehouse_timeout':['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(failure.provider_reason)?'transport_timeout':null,query_id});
      const failed=groups.length>1?source+'/'+group:source;if(!failed_sources.includes(failed))failed_sources.push(failed);}
  }
  const result={definition,results};
  const rows=retentionRows(result.results||[],definition.sort,definition.ranking_window).filter(row=>!context.within_days||row.window_days===context.within_days);
  const evidence={request_id,source_outcomes,ranking_window:context.ranking_metric==='repeat_rate_180'?180:context.within_days||90,component_limitations:context.output_preference?[rows.length?'The supported table is retained. A governed cohort export or chart is not implemented.':'No cohort table is available. A governed cohort export or chart is not implemented.']:[],kind:'governed_cohort_retention',subject:'customer_journey',operation:'cohort_retention',periods:[{start_date:context.start_date,end_date:context.end_date}],observation_end:definition.observation_end,definition:result.definition,rows,truncated,coverage:{classification,source_status:[['woo','ww'],['woo','usd'],['shopify','shopify']].map(([source_platform,source_store])=>({source_platform,source_store,status:classification.some(c=>c.source_platform===source_platform&&c.source_store===source_store)?'observed_endpoints_only':source_outcomes.some(s=>s.source_store===source_store&&s.state==='rejected')?'unavailable':'coverage_not_returned'})),failed_sources,unevaluable_customers:null,unevaluable_share:null,complete:false,identity:'source_qualified_only',prior_history:'unverified'}};
  return {request_id,answer:retentionMarkdown(evidence),evidence,analysis_context:context,partial:true,...(!rows.length?{analysis_unavailable:true}:{}),tools:['analyze_customer_journey']};
}
