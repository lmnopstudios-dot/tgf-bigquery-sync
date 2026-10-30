import {applyJourneyScopeDefinition,journeyReportContract,assertJourneyScopeEvidence,journeyScopeText,reportingCoverageText,JOURNEY_SCOPE_LIMITATION} from './journey-scope.js';
import {validateJourneyDefinition} from './customer-journey.js';
import {PRODUCT_JOURNEY_CONTRACT,validateProductJourneys} from './product-journeys.js';
import {resolveAnalyticalPlan,assertPlanAgreement,stableAnalyticalJSON} from './analytical-plan.js';
import {boundedEvidenceRead} from './bounded-evidence-read.js';
import {requestId} from './request-observability.js';
import {safeReadFailure} from './read-failure.js';
export const COLLABORATION_JOURNEY_CONTRACT=Object.freeze({...PRODUCT_JOURNEY_CONTRACT,entry_population:'first_observed_order_contains_governed_named_collaboration',overall:'distinct_linked_entry_customers',breakdowns:['collaboration','item'],collaborations:20,entry_products:20,downstream:'all_products_on_next_eligible_order'});
export function collaborationJourneyDefinition(c){
 const channel=c.channel==='online'?'Online':c.channel==='instore'?'In-store':null;
 return applyJourneyScopeDefinition({cohort_entry_start:c.cohort_entry_start||c.start_date,cohort_entry_end:c.cohort_entry_end||c.end_date,observation_end:c.observation_end||c.end_date,time_zone:c.time_zone,first_order_semantic:'first_observed_ever',cohort:{entry_product_classification:'collaboration',entry_channel:channel},subsequent:{channel},group_by:['retention_collaboration_journeys'],sort:'returning_customers_desc',limit:20},c);
}
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const components=['overall','collaboration','item'];
function validateSection(rows,component,e){
 if(!Array.isArray(rows)||rows.some(r=>r.cohort_type!==component))throw Error('Invalid collaboration section');
 validateProductJourneys(rows);
 const expected=component==='overall'?1:component==='collaboration'?Math.min(20,e.available_collaborations):Math.min(20,e.available_items)+Math.min(20,e.available_sizer_items);
 if(rows.length!==expected*4)throw Error('Incomplete collaboration section');
 for(const r of rows){
  if(typeof r.entry_product!=='string'||!r.entry_product)throw Error('Missing cohort label');
  if(component==='overall'){
   if(r.entry_product_ref!==null||r.collaboration_name!==null||r.collaboration_product_ref!==null)throw Error('Invalid overall population');
  }else{
   if(typeof r.collaboration_name!=='string'||!r.collaboration_name||['collaboration','collaborations'].includes(r.collaboration_name)||component==='collaboration'&&(r.collaboration_product_ref!==null||r.entry_is_sizer)||component==='item'&&(typeof r.collaboration_product_ref!=='string'||!r.collaboration_product_ref))throw Error('Invalid named cohort');
   if(r.entry_product_ref!==JSON.stringify([component,r.collaboration_name,r.collaboration_product_ref]))throw Error('Invalid cohort key');
  }
 }
 if(component==='item')for(const sizer of [false,true])if(rows.filter(r=>r.window_days===0&&r.entry_is_sizer===sizer).length!==Math.min(20,sizer?e.available_sizer_items:e.available_items))throw Error('Incomplete item quota');
 for(const r of rows){
  const overall=rows.find(p=>p.entry_product_ref===r.entry_product_ref&&p.window_days===0);
  if(r.returning_customers>overall.returning_customers||rows.some(p=>p.entry_product_ref===r.entry_product_ref&&p.window_days>0&&r.window_days>p.window_days&&(r.age_eligible_customers>p.age_eligible_customers||r.returning_customers<p.returning_customers)))throw Error('Invalid window reconciliation');
 }
 return rows;
}
function validateHeader(e){
 if(!['available_collaborations','available_items','available_sizer_items'].every(k=>integer(e[k])))throw Error('Invalid available cohorts');
}
export function assertCollaborationJourneyEvidence(c,e){
 assertPlanAgreement(c,e);assertJourneyScopeEvidence(c,e);if(c.journey_scope)reportingCoverageText(e.reporting_coverage);
 if(c.journey_intent!=='collaboration_purchase_products'||c.journey_group_by!=='collaboration_purchase_products'||c.entry_product_classification!=='collaboration'||e.kind!=='governed_collaboration_purchase_products'||e.operation!=='collaboration_purchase_products'||e.subject!=='customer_journey'||e.population_scope!=='linked_tgf'||stableAnalyticalJSON(e.contract)!==stableAnalyticalJSON(journeyReportContract(COLLABORATION_JOURNEY_CONTRACT,c.journey_scope))||stableAnalyticalJSON(e.definition)!==stableAnalyticalJSON(collaborationJourneyDefinition(c))||e.identity_evidence?.activation!=='active'||e.identity_evidence.mode!=='email_candidate_v2'||!e.identity_evidence.snapshot)throw Error('Collaboration journey scope mismatch');
 validateHeader(e);
 if(!Array.isArray(e.rows)||e.rows.some(r=>!components.includes(r.cohort_type))||!Array.isArray(e.component_outcomes)||e.component_outcomes.length!==3)throw Error('Missing collaboration outputs');
 for(const component of components){
  const matches=e.component_outcomes.filter(o=>o.component===component),rows=e.rows.filter(r=>r.cohort_type===component);
  if(matches.length!==1||!['fulfilled','evidence_rejected'].includes(matches[0].status))throw Error('Invalid collaboration outcome');
  if(matches[0].status==='fulfilled')validateSection(rows,component,e);else if(rows.length)throw Error('Rejected section contains rows');
 }
 const overall=e.rows.filter(r=>r.cohort_type==='overall');
 for(const r of e.rows.filter(r=>r.cohort_type!=='overall')){
  const parent=(r.cohort_type==='item'?e.rows.find(p=>p.cohort_type==='collaboration'&&p.collaboration_name===r.collaboration_name&&p.window_days===r.window_days):null)||overall.find(p=>p.window_days===r.window_days);
  if(parent&&['entry_customers','returning_customers','age_eligible_customers','age_repeat_customers','verified_customers','verified_repeat_customers'].some(k=>r[k]>parent[k]))throw Error('Breakdown exceeds parent');
 }
}
const safe=v=>String(v??'Unavailable').replace(/[|<>\r\n]/g,' ');
const percent=(n,d)=>d?`${(100*n/d).toFixed(2)}%`:'Unavailable (zero denominator)';
export function collaborationJourneyMarkdown(e){
 const lines=[`Collaboration-entry next-order products — provisional observed evidence. Entry: ${e.definition.cohort_entry_start} through ${e.definition.cohort_entry_end}; cutoff ${e.definition.observation_end} (${e.definition.time_zone}).`,
 'The overall cohort counts each linked customer once when their first observed eligible purchase contains a governed named collaboration item. Named-collaboration and first-purchase collaboration-item cohorts overlap and must not be added. Generic-only, conflicting and unnamed classifications do not establish named entry membership.',
 'Products come from the next strictly later eligible order across the full range, including core, other collaborations and the same product repurchased later. Entry-order lines are excluded. Each returning customer counts once per product; shares use all returning customers, including missing or unknown attribution, and may sum above 100%. Ring Sizers are ranked separately.',
 'Woo WW, Woo USD and Shopify histories are linked before first-observed assignment. Activated email candidates do not certify people, complete migration or first-ever purchases; unmatched and ambiguous identities retain source-local safeguards. Matrixify imports, cancelled and fully refunded orders remain excluded. Active governed classifications and approved product/reporting-family routes are used; titles never merge identities. Association does not establish causation.'];
 for(const component of components){
  const rows=e.rows.filter(r=>r.cohort_type===component);
  const outcome=e.component_outcomes.find(o=>o.component===component);
  if(outcome.status!=='fulfilled'){lines.push(`${component}: unavailable (${outcome.status}); successful independent sections retained.`);continue;}
  for(const r of rows){
   const label=component==='overall'?'Overall collaboration-entry cohort':component==='collaboration'?`Collaboration: ${safe(r.collaboration_name)}`:`First-purchase collaboration item: ${safe(r.entry_product)} / ${safe(r.collaboration_name)}`;
   lines.push(`**${label} — ${r.window_days===0?'next eligible order by cutoff':r.window_days+' calendar days'}**`,
    `Entry customers: ${r.entry_customers}. Observed returning customers: ${r.returning_customers} / ${r.entry_customers} (${percent(r.returning_customers,r.entry_customers)}; provisional).${r.entry_customers<30?' Small sample (below 30).':''}`,
    r.window_days===0?'Verified rate unavailable for the open-ended next-order view.':`Age-qualified provisional rate: ${r.age_repeat_customers} / ${r.age_eligible_customers} (${percent(r.age_repeat_customers,r.age_eligible_customers)}). Verified rate: ${r.observation_coverage_status==='verified_continuous'?`${r.verified_repeat_customers} / ${r.verified_customers} (${percent(r.verified_repeat_customers,r.verified_customers)})`:'Unavailable; continuous follow-up unverified'}.`,
    ['| Next-order product | Customers | Returning-customer denominator | Product share |','|---|---:|---:|---:|',
     ...r.products.map(p=>`| ${p.is_sizer?'Ring Sizers (separate): ':''}${safe(p.product)} [${safe(p.family_status)}] | ${p.customers} | ${p.denominator_customers} | ${percent(p.customers,p.denominator_customers)} |`)].join('\n'),
    `Unknown attribution: ${r.missing_line_customers} returners without lines; ${r.unknown_product_customers} with unidentified products (flags may overlap).`,
    ...[false,true].map(s=>{const p=r.products.filter(p=>p.is_sizer===s);return p.length?`${s?'Ring Sizers':'Main products'}: ${p.length} / ${p[0].available_products} available next-order products shown${p.length<p[0].available_products?'; truncated by product limit':''}.`:'';}).filter(Boolean));
  }
 }
 lines.push(`Independent cohort quotas, ranked by distinct entry customers: ${Math.min(20,e.available_collaborations)} / ${e.available_collaborations} named collaborations; ${Math.min(20,e.available_items)} / ${e.available_items} collaboration-item cohorts; ${Math.min(20,e.available_sizer_items)} / ${e.available_sizer_items} Ring Sizer item cohorts. Up to 20 per quota; additional cohorts are truncated. Overall top 20 next-order products and top five per breakdown, with separate Ring Sizers; quotas never restrict the overall entry population.`,
 'First observed uses all available eligible history before the entry dates. Prior history and continuous follow-up may be incomplete; latest activity alone never verifies coverage. Verified windows require evidence-backed continuous coverage and a full calendar window before the cutoff. Unverified follow-up has no supported mature rate; observed results remain provisional.',`Request reference: ${e.request_id}.`);
 if(e.definition.report_scope)lines.unshift(journeyScopeText(e.definition.report_scope),JOURNEY_SCOPE_LIMITATION,...reportingCoverageText(e.reporting_coverage));
 return (e.definition.report_scope?lines.map(l=>(e.definition.report_scope.next==='next_matching_channel'?l.replaceAll('next-order','selected-follow-up'):l).replace('Woo WW, Woo USD and Shopify','Woo WW, Woo USD, Shopify'+(e.definition.report_scope.include_square?' and eligible Square':'')).replace('Products come from the next strictly later eligible order across the full range','Products come from the selected strictly later eligible order under the stated follow-up rule')):lines).join('\n\n');
}
export async function answerCollaborationJourneys({context,provider,...options}){
 const request_id=requestId(options.requestId||options.request_id),definition=collaborationJourneyDefinition(context);
 const unavailable=failure=>({request_id,analysis_context:context,analysis_unavailable:true,partial:true,...(failure?{retrieval_failure:failure}:{}),answer:`Collaboration-entry next-order product analysis unavailable. No ranking or percentage was inferred. Request reference: ${request_id}.`,tools:[]});
 if(provider?.retentionPopulationScope!=='linked_tgf'||!provider.analyzeCustomerJourney)return unavailable();
 try{
  const part=await boundedEvidenceRead(timeoutMs=>provider.analyzeCustomerJourney(definition,{...options,timeoutMs,combined:true}),{...options,deadlineAt:options.deadlineAt??Date.now()+45000});
  if(part.population_scope!=='linked_tgf'||stableAnalyticalJSON(part.definition)!==stableAnalyticalJSON(validateJourneyDefinition(definition)))throw Error('Provider collaboration scope mismatch');
  const evidence={...(context.journey_scope?{reporting_coverage:part.reporting_coverage}:{}),kind:'governed_collaboration_purchase_products',subject:'customer_journey',operation:'collaboration_purchase_products',request_id,population_scope:'linked_tgf',contract:journeyReportContract(COLLABORATION_JOURNEY_CONTRACT,context.journey_scope),definition,analytical_plan:resolveAnalyticalPlan(context),identity_evidence:part.identity_evidence,available_collaborations:part.available_collaborations,available_items:part.available_items,available_sizer_items:part.available_sizer_items,rows:[],component_outcomes:[]};
  validateHeader(evidence);
  if(!Array.isArray(part.collaboration_journeys)||part.collaboration_journeys.length>244||part.collaboration_journeys.some(r=>!components.includes(r.cohort_type)))throw Error('Invalid collaboration row bound');
  for(const component of components){
   const rows=part.collaboration_journeys.filter(r=>r.cohort_type===component);
   try{validateSection(rows,component,evidence);evidence.rows.push(...rows);evidence.component_outcomes.push({component,status:'fulfilled'});}
   catch{evidence.component_outcomes.push({component,status:'evidence_rejected'});}
  }
  // Reject only the offending breakdown if independently validated parent counts
  // prove that its population cannot be a subset.
  for(const component of ['collaboration','item']){
   const before=evidence.rows;try{assertCollaborationJourneyEvidence(context,evidence);}catch(error){
    if(error.message!=='Breakdown exceeds parent')throw error;
    const invalid=before.filter(r=>r.cohort_type===component).some(r=>{const p=(component==='item'?before.find(p=>p.cohort_type==='collaboration'&&p.collaboration_name===r.collaboration_name&&p.window_days===r.window_days):null)||before.find(p=>p.cohort_type==='overall'&&p.window_days===r.window_days);return p&&['entry_customers','returning_customers','age_eligible_customers','age_repeat_customers','verified_customers','verified_repeat_customers'].some(k=>r[k]>p[k]);});
    if(invalid){evidence.rows=before.filter(r=>r.cohort_type!==component);evidence.component_outcomes.find(o=>o.component===component).status='evidence_rejected';}
   }
  }
  assertCollaborationJourneyEvidence(context,evidence);
  return {request_id,analysis_context:context,partial:true,evidence,answer:collaborationJourneyMarkdown(evidence),tools:['analyze_customer_journey']};
 }catch(error){if(error.code==='SQUARE_EXTENSION_REVIEW_REQUIRED')return {...unavailable(),answer:'Square reporting requires review and separate activation of its versioned extension. No Square-inclusive figures or substitute legacy population were returned.'};if(['LEASE_NOT_OWNED','REQUEST_CANCELLED'].includes(error.code)||options.signal?.aborted)throw error;return unavailable(safeReadFailure(error,'population_query'));}
}
