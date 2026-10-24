import {resolveAnalyticalPlan,assertPlanAgreement} from './analytical-plan.js';
import {requestId} from './request-observability.js';
import {boundedEvidenceRead} from './bounded-evidence-read.js';

import {PRODUCT_JOURNEY_CONTRACT} from './product-journey-contract.js';
export {PRODUCT_JOURNEY_CONTRACT} from './product-journey-contract.js';
export function productJourneyDefinition(c){return {cohort_entry_start:c.cohort_entry_start||c.start_date,cohort_entry_end:c.cohort_entry_end||c.end_date,observation_end:c.observation_end||c.end_date,time_zone:c.time_zone,first_order_semantic:'first_observed_ever',cohort:{entry_product_classification:null,entry_channel:c.channel==='online'?'Online':c.channel==='instore'?'In-store':null},subsequent:{channel:c.channel==='online'?'Online':c.channel==='instore'?'In-store':null},group_by:['retention_product_journeys'],sort:'returning_customers_desc',limit:PRODUCT_JOURNEY_CONTRACT.entry_products};}
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const countKeys=['entry_customers','returning_customers','age_eligible_customers','age_repeat_customers','verified_customers','verified_repeat_customers','missing_line_customers','unknown_product_customers'];
export function validateProductJourneys(rows){
 if(!Array.isArray(rows)||rows.length>(1+PRODUCT_JOURNEY_CONTRACT.entry_products*2)*PRODUCT_JOURNEY_CONTRACT.windows.length)throw Error('Invalid product journey bound');
 const keys=new Set();
 for(const r of rows){
  const key=JSON.stringify([r.entry_product_ref,r.window_days]);if(keys.has(key))throw Error('Duplicate product journey');keys.add(key);
  if(!PRODUCT_JOURNEY_CONTRACT.windows.includes(r.window_days)||!countKeys.every(k=>integer(r[k]))||typeof r.entry_is_sizer!=='boolean'||!integer(r.entry_rank)||r.entry_product_ref!==null&&(typeof r.entry_product_ref!=='string'||!r.entry_product_ref||r.entry_rank<1||r.entry_rank>PRODUCT_JOURNEY_CONTRACT.entry_products)||r.entry_product_ref===null&&r.entry_rank!==0)throw Error('Invalid product journey scope');
  if(r.returning_customers>r.entry_customers||r.age_eligible_customers>r.entry_customers||r.age_repeat_customers>Math.min(r.age_eligible_customers,r.returning_customers)||r.verified_customers>r.age_eligible_customers||r.verified_repeat_customers>Math.min(r.verified_customers,r.age_repeat_customers)||r.missing_line_customers>r.returning_customers||r.unknown_product_customers>r.returning_customers)throw Error('Invalid product journey denominator');
  if(!['unverified','verified_continuous'].includes(r.observation_coverage_status)||r.observation_coverage_status==='unverified'&&(r.verified_customers||r.verified_repeat_customers)||r.observation_coverage_status==='verified_continuous'&&(!r.coverage_evidence||!r.verified_coverage_start||!r.verified_coverage_end)||r.window_days===0&&(r.verified_customers||r.verified_repeat_customers||r.age_eligible_customers!==r.entry_customers||r.age_repeat_customers!==r.returning_customers))throw Error('Invalid verified coverage');
  const limit=r.entry_product_ref===null?PRODUCT_JOURNEY_CONTRACT.overall_products:PRODUCT_JOURNEY_CONTRACT.next_products;
  if(!Array.isArray(r.products)||r.products.length>limit*2)throw Error('Invalid product row bound');
  const seen=new Set(),last=new Map();
  for(const p of r.products){
   const prev=last.get(p.is_sizer);
   if(typeof p.product_ref!=='string'||!p.product_ref||typeof p.product!=='string'||!['governed_family','governed_product','unmapped_item','ambiguous_family'].includes(p.family_status)||typeof p.is_sizer!=='boolean'||seen.has(p.product_ref)||!integer(p.customers)||p.customers===0||p.customers>r.returning_customers||p.denominator_customers!==r.returning_customers||!integer(p.available_products)||!Number.isInteger(p.product_rank)||p.product_rank!==(prev?prev.product_rank+1:1)||p.product_rank>Math.min(limit,p.available_products)||prev&&p.available_products!==prev.available_products||prev&&(p.customers>prev.customers||p.customers===prev.customers&&p.product_ref<prev.product_ref)||p.percentage!==null&&(!Number.isFinite(p.percentage)||Math.abs(p.percentage-100*p.customers/r.returning_customers)>0.000001))throw Error('Invalid product share or ranking');
   if(r.returning_customers&&p.percentage===null)throw Error('Missing product share');seen.add(p.product_ref);last.set(p.is_sizer,p);
  }
  for(const [sizer,p] of last)if(r.products.filter(x=>x.is_sizer===sizer).length!==Math.min(limit,p.available_products))throw Error('Incomplete product selection');
 }
 for(const r of rows){const siblings=rows.filter(x=>x.entry_product_ref===r.entry_product_ref);if(siblings.length!==PRODUCT_JOURNEY_CONTRACT.windows.length||siblings.some(x=>x.entry_customers!==r.entry_customers||x.entry_rank!==r.entry_rank||x.entry_is_sizer!==r.entry_is_sizer))throw Error('Incomplete product windows');}
 for(const sizer of [false,true]){const entries=rows.filter(r=>r.window_days===0&&r.entry_product_ref!==null&&r.entry_is_sizer===sizer).sort((a,b)=>a.entry_rank-b.entry_rank);for(let i=0;i<entries.length;i++)if(entries[i].entry_rank!==i+1||i&&(entries[i].entry_customers>entries[i-1].entry_customers||entries[i].entry_customers===entries[i-1].entry_customers&&entries[i].entry_product_ref<entries[i-1].entry_product_ref))throw Error('Invalid entry ranking');}
 return rows;
}
const safe=x=>String(x??'Unavailable').replace(/[|<>\n\r]/g,' ');
const rate=(n,d)=>d?`${(100*n/d).toFixed(2)}%`:'Unavailable (zero denominator)';
export function productJourneyMarkdown(e){
 const lines=[`Second-purchase product popularity — provisional observed evidence. Entry: ${e.definition.cohort_entry_start} through ${e.definition.cohort_entry_end}; cutoff ${e.definition.observation_end} (${e.definition.time_zone}).`,
 'Linked Woo WW, Woo USD and Shopify histories are combined before first-observed entry and next eligible order selection. Activated email candidates do not verify people or first-ever purchases; unmatched and ambiguous histories retain source-local safeguards. Imported Matrixify transactions remain excluded. Approved identities and reporting families are preserved; titles do not merge products.',
 'Primary view: next eligible order observed by the cutoff. Each customer counts once per product. Entry-order lines are excluded; the same product in a genuinely later order is included. Product percentages use all returning customers in that cohort/window, including unknown attribution, and can sum above 100% for multi-product orders. Cohorts overlap and must not be added. Samples below 30 customers are small.'];
 for(const r of e.rows){
  const label=r.entry_product_ref===null?'Overall top 20 second-order products':`${r.entry_is_sizer?'Ring Sizers (separate) / ':''}First-product #${r.entry_rank}: ${safe(r.entry_product)}`;
  lines.push(`**${label} — ${r.window_days===0?'next eligible order':r.window_days+' calendar days'}**`,
   `Entry customers: ${r.entry_customers}. Observed second-purchase customers: ${r.returning_customers} / ${r.entry_customers} (${rate(r.returning_customers,r.entry_customers)}; provisional).${r.entry_customers<30?' Small sample.':''}`,
   r.window_days===0?'Verified rate unavailable for the open-ended next-order view.':`Age-qualified provisional rate: ${r.age_repeat_customers} / ${r.age_eligible_customers} (${rate(r.age_repeat_customers,r.age_eligible_customers)}). Verified rate: ${r.observation_coverage_status==='verified_continuous'?`${r.verified_repeat_customers} / ${r.verified_customers} (${rate(r.verified_repeat_customers,r.verified_customers)})`:'Unavailable; continuous follow-up unverified'}.`,
   '| Product | Customers | Returning-customer denominator | Product share |','|---|---:|---:|---:|',
   ...r.products.map(p=>`| ${p.is_sizer?'Ring Sizers (separate): ':''}${safe(p.product)} [${safe(p.family_status)}] | ${p.customers} | ${p.denominator_customers} | ${rate(p.customers,p.denominator_customers)} |`),
   `Unknown attribution: ${r.missing_line_customers} returning customers without lines; ${r.unknown_product_customers} with unidentified products (flags may overlap).`,
   ...[false,true].map(s=>{const ps=r.products.filter(p=>p.is_sizer===s);return ps.length?`${s?'Ring Sizers':'Main products'}: ${ps.length} / ${ps[0].available_products} available products shown${ps.length<ps[0].available_products?'; truncated by requested product limit':''}.`:''}).filter(Boolean));
 }
 lines.push(`First-product selection: top 20 by distinct entry customers; ${e.available_entry_products} main products available${e.available_entry_products>20?'; truncated to the requested top 20':''}. Ring Sizers: ${e.available_sizer_entry_products} available, separately ranked. Unknown entry attribution: ${e.unknown_entry_customers} customers; these remain in the overall population.`,...(e.component_outcomes||[]).filter(o=>o.status!=='fulfilled').map(o=>`${o.component}: unavailable (${o.status}); successful sections retained.`),`Request reference: ${e.request_id}.`);
 return lines.join('\n\n');
}
export function assertProductJourneyEvidence(c,e){
 assertPlanAgreement(c,e);
 const d=productJourneyDefinition(c);
 if(c.journey_group_by!=='second_purchase_products'||c.entry_product_classification!==null||e.kind!=='governed_second_purchase_products'||e.population_scope!=='linked_tgf'||JSON.stringify(e.contract)!==JSON.stringify(PRODUCT_JOURNEY_CONTRACT)||JSON.stringify(e.definition)!==JSON.stringify(d)||e.identity_evidence?.activation!=='active'||e.identity_evidence.mode!=='email_candidate_v2'||!e.identity_evidence.snapshot||!['available_entry_products','available_sizer_entry_products','unknown_entry_customers'].every(k=>integer(e[k])))throw Error('Product journey evidence scope mismatch');
 validateProductJourneys(e.rows);
 if(!Array.isArray(e.component_outcomes)||e.component_outcomes.length!==2)throw Error('Missing component outcomes');
 for(const component of ['overall','journeys']){
  const o=e.component_outcomes.find(x=>x.component===component),rows=e.rows.filter(r=>(r.entry_product_ref===null)===(component==='overall'));
  if(!o||!['fulfilled','evidence_rejected'].includes(o.status)||o.status!=='fulfilled'&&rows.length||component==='overall'&&o.status==='fulfilled'&&rows.length!==4)throw Error('Invalid component outputs');
 }
 const entries=e.rows.filter(r=>r.window_days===0&&r.entry_product_ref!==null);
 if(e.component_outcomes.find(o=>o.component==='journeys').status==='fulfilled'&&[false,true].some(s=>entries.filter(r=>r.entry_is_sizer===s).length!==Math.min(PRODUCT_JOURNEY_CONTRACT.entry_products,s?e.available_sizer_entry_products:e.available_entry_products)))throw Error('Incomplete entry selection');
}
export async function answerProductJourneys({context,provider,...options}){
 const request_id=requestId(options.requestId||options.request_id),definition=productJourneyDefinition(context);
 if(provider?.retentionPopulationScope!=='linked_tgf'||!provider.analyzeCustomerJourney)return {request_id,analysis_context:context,analysis_unavailable:true,answer:'Second-purchase product analysis requires the configured active email_candidate_v2 linked-history provider. No collaboration report was substituted.',tools:[]};
 try{
  const part=await boundedEvidenceRead(timeoutMs=>provider.analyzeCustomerJourney(definition,{...options,timeoutMs,combined:true}),{...options,deadlineAt:options.deadlineAt??Date.now()+45000});
  if(part.population_scope!=='linked_tgf'||part.definition?.group_by?.[0]!=='retention_product_journeys'||part.definition.cohort_entry_start!==definition.cohort_entry_start||part.definition.cohort_entry_end!==definition.cohort_entry_end||part.definition.observation_end!==definition.observation_end||part.definition.time_zone!==definition.time_zone||part.definition.cohort?.entry_product_classification!==null)throw Error('Provider product journey scope mismatch');
  const evidence={kind:'governed_second_purchase_products',subject:'customer_journey',operation:'second_purchase_products',population_scope:'linked_tgf',request_id,definition,contract:PRODUCT_JOURNEY_CONTRACT,analytical_plan:resolveAnalyticalPlan(context),identity_evidence:part.identity_evidence,rows:part.product_journeys,available_entry_products:Number(part.available_entry_products),available_sizer_entry_products:Number(part.available_sizer_entry_products),unknown_entry_customers:Number(part.unknown_entry_customers),periods:[{start_date:context.start_date,end_date:context.end_date}]};
  if(!Array.isArray(evidence.rows))throw Error('Missing product journey rows');
  const accepted=[],component_outcomes=[];
  for(const component of ['overall','journeys']){
   const rows=evidence.rows.filter(r=>(r.entry_product_ref===null)===(component==='overall'));
   try{validateProductJourneys(rows);
    if(component==='overall'&&rows.length!==4)throw Error('Missing overall outputs');
    if(component==='journeys'&&[false,true].some(s=>rows.filter(r=>r.window_days===0&&r.entry_is_sizer===s).length!==Math.min(PRODUCT_JOURNEY_CONTRACT.entry_products,s?evidence.available_sizer_entry_products:evidence.available_entry_products)))throw Error('Missing entry outputs');
    accepted.push(...rows);component_outcomes.push({component,status:'fulfilled'});}
   catch{component_outcomes.push({component,status:'evidence_rejected'});}
  }
  evidence.rows=accepted;evidence.component_outcomes=component_outcomes;
  assertProductJourneyEvidence(context,evidence);
  return {request_id,answer:productJourneyMarkdown(evidence),evidence,analysis_context:context,partial:true,tools:['analyze_customer_journey']};
 }catch(error){if(['LEASE_NOT_OWNED','REQUEST_CANCELLED'].includes(error.code)||options.signal?.aborted)throw error;return {request_id,analysis_context:context,analysis_unavailable:true,partial:true,answer:`Second-purchase product analysis unavailable: linked provider retrieval or evidence validation failed. No ranking or percentage was inferred. Request reference: ${request_id}.`,tools:['analyze_customer_journey']};}
}
