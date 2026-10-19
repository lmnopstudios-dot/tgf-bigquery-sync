import { assertBasketEvidence } from './basket-composition.js';
import { assertPopulationConversionEvidence } from './population-conversion.js';
// Operation proof is independent of presentation and saved plan stamps. A plan
// describes intent; only a compatible evidence producer establishes execution.
const EVIDENCE_OPERATIONS=Object.freeze({
  governed_cohort_retention:['cohort_retention'],
  governed_basket_composition:['basket_composition'],
  governed_order_values:['order_distribution'],
  governed_population_conversion:['population_comparison'],
  governed_weekday_sales:['grouped_sales']
});
const REQUIRED_KINDS=Object.freeze(Object.fromEntries(Object.entries(EVIDENCE_OPERATIONS).flatMap(([kind,operations])=>operations.map(op=>[op,kind]))));
export function requestedOperation(context){
  if(context?.analysis_type==='customer_journey')return (context.journey_intent==='retention'||context.journey_group_by==='collaboration_name')?'cohort_retention':'customer_journey';
  if(context?.population_scope)return 'population_comparison';
  if(context?.requested_operations?.includes('basket_composition'))return 'basket_composition';
  if(context?.tool_route==='get_order_value_analysis')return 'order_distribution';
  if(context?.tool_route==='get_daily_sales_analysis')return 'grouped_sales';
  return null;
}
export function answerCompleteness(context,result){
  const operation=requestedOperation(context),evidence=result?.evidence;
  if(!operation)return {status:'not_applicable',operation:null,missing:[]};
  if(result?.clarification?.fields?.length)return {status:'pending',operation,missing:result.clarification.fields};
  if(result?.analysis_unavailable)return {status:'limited',operation,missing:[]};
  const missing=[];
  if(!evidence)missing.push('executed_evidence');
  else if(REQUIRED_KINDS[operation]&&!(EVIDENCE_OPERATIONS[evidence.kind]||[]).includes(operation))missing.push('operation');
  else if(operation==='customer_journey'){
    const entries=evidence.kind==='governed_tool_results'?evidence.results:[];
    const journey=entries?.find(entry=>entry.name==='analyze_customer_journey'&&entry.result?.definition&&!entry.result?.error&&entry.result?.success!==false)?.result;
    if(evidence.kind!=='governed_customer_journey'&&!journey)missing.push('operation');
    if(journey){
      const d=journey.definition;
      if(d.cohort_entry_start!==(context.cohort_entry_start||context.start_date)||d.cohort_entry_end!==(context.cohort_entry_end||context.end_date)||d.observation_end!==(context.observation_end||context.end_date))missing.push('cohort_period');
      if((d.cohort?.entry_product_classification||null)!==(context.entry_product_classification||null))missing.push('entry_classification');
      if(context.journey_group_by&&!d.group_by?.includes(context.journey_group_by))missing.push('grouping');
    }
  }
  if(operation==='basket_composition'&&evidence?.kind==='governed_basket_composition'){try{assertBasketEvidence({...context,source_store:result.analysis_context?.source_store||context.source_store},evidence);}catch{missing.push('calculations_or_subset');}}
  if(operation==='population_comparison'&&evidence?.kind==='governed_population_conversion'){try{assertPopulationConversionEvidence(context,evidence);}catch{missing.push('population_or_grouping_or_coverage');}}
  if(operation==='cohort_retention'&&evidence?.kind==='governed_cohort_retention'){
    if(evidence.subject!=='customer_journey'||evidence.operation!==operation)missing.push('subject');
    if(!Array.isArray(evidence.rows))missing.push('cohort_outputs');
    if(!evidence.periods?.some(p=>p.start_date===context.start_date&&p.end_date===context.end_date))missing.push('period');
    if(evidence.observation_end!==(context.observation_end||context.end_date))missing.push('observation_window');
    if(evidence.definition?.cohort?.entry_product_classification!==context.entry_product_classification)missing.push('entry_classification');
    const nested=context.journey_group_by==='collaboration_piece',product=context.journey_group_by==='entry_product';
    if(evidence.definition?.group_by?.[0]!== (product?'retention_product_windows':nested?'retention_piece_windows':'retention_windows'))missing.push('grouping');
    if(evidence.definition?.sort!==(context.sort||'repeat_rate_desc'))missing.push('ranking');
    if((evidence.definition?.time_zone||'UTC')!==(context.time_zone||'UTC'))missing.push('timezone');
    if((evidence.definition?.ranking_window||90)!==(context.ranking_metric==='repeat_rate_180'?180:context.within_days||90)||(evidence.ranking_window||90)!==(context.ranking_metric==='repeat_rate_180'?180:context.within_days||90))missing.push('ranking_window');
    if(nested&&evidence.rows?.length&&!evidence.coverage?.failed_sources?.length&&(!(evidence.rows||[]).some(r=>r.entry_product_ref)||!(evidence.rows||[]).some(r=>!r.entry_product_ref)))missing.push('grouping');
    for(const c of evidence.coverage?.classification||[]){
      const counts=['eligible_first_customers','named_customers','generic_only_customers','unknown_customers'];
      if(!counts.every(k=>Number.isSafeInteger(c[k])&&c[k]>=0)||c.named_customers+c.generic_only_customers+c.unknown_customers!==c.eligible_first_customers)missing.push('classification_coverage');
    }
    const expectedChannel=context.channel==='online'?'Online':context.channel==='instore'?'In-store':null;
    if((evidence.definition?.cohort?.entry_channel||null)!==expectedChannel||(evidence.definition?.subsequent?.channel||null)!==expectedChannel)missing.push('population');
    const windows=context.within_days?[context.within_days]:[90,180];
    const memberships=new Set();
    if((evidence.rows||[]).length>200)missing.push('row_bound');
    for(const r of evidence.rows||[]){
      const key=JSON.stringify([r.source_platform,r.source_store,r.collaboration_name,r.entry_product_ref||null,r.window_days]);
      if(memberships.has(key))missing.push('duplicate_cohort');memberships.add(key);
      if(['collaboration','collaborations'].includes(r.collaboration_name))missing.push('classification_granularity');
      const buckets=['same_collaboration','different_collaboration','core_range','unknown'];
      if(buckets.some(k=>r[k]!=null)&&(!buckets.every(k=>Number.isInteger(r[k])&&r[k]>=0)||buckets.reduce((n,k)=>n+r[k],0)!==r.repeat_customers))missing.push('second_purchase_classification');
      if((product||r.entry_product_ref)&&(!r.entry_product_ref||typeof r.entry_product!=='string'))missing.push('product_identity');
      if(!['woo','shopify'].includes(r.source_platform)||typeof r.source_store!=='string'||!product&&typeof r.collaboration_name!=='string')missing.push('identity');
      if(r.repeat_customers>0&&(typeof r.median_days_to_second!=='number'||!Number.isFinite(r.median_days_to_second)||r.median_days_to_second<0||r.median_days_to_second>=r.window_days+2)||r.repeat_customers===0&&r.median_days_to_second!==null)missing.push('conditional_median');
      if(!windows.includes(r.window_days)||![r.cohort_customers,r.mature_customers,r.repeat_customers].every(n=>Number.isInteger(n)&&n>=0)||r.repeat_customers>r.mature_customers||r.mature_customers>r.cohort_customers||r.repeat_rate!==(r.mature_customers?r.repeat_customers/r.mature_customers:null))missing.push('denominator');
    }
    for(const r of evidence.rows||[]){
      const other=(evidence.rows||[]).find(o=>o.source_platform===r.source_platform&&o.source_store===r.source_store&&o.collaboration_name===r.collaboration_name&&o.entry_product_ref===r.entry_product_ref&&o.window_days!==r.window_days);
      if(other&&(other.cohort_customers!==r.cohort_customers||(r.window_days===180&&(r.mature_customers>other.mature_customers||r.mature_customers===other.mature_customers&&r.repeat_customers<other.repeat_customers))))missing.push('window_reconciliation');
    }
    // Each observed source/cohort needs all requested windows; empty evidence is
    // an explicit partial coverage outcome, never manufactured zero cohorts.
    for(const row of evidence.rows||[])for(const window of windows)if(!evidence.rows.some(r=>r.source_platform===row.source_platform&&r.source_store===row.source_store&&r.collaboration_name===row.collaboration_name&&r.entry_product_ref===row.entry_product_ref&&r.window_days===window))missing.push('retention_windows');
  }
  return {status:missing.length?'incomplete':result?.partial?'partial':'complete',operation,missing:[...new Set(missing)]};
}
export function assertAnswerCompleteness(context,result){
  const contract=answerCompleteness(context,result);
  if(contract.status==='incomplete')throw Object.assign(new Error('Delivered evidence does not satisfy the requested analytical operation: '+contract.missing.join(', ')),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'answer_completeness'});
  return contract;
}
