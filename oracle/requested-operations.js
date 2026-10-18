import { retrievePromotionContext, resolvePromotionDates } from './promotion-context.js';

// Semantic operations may be requested for any monetary distribution. These
// declarations do not make period totals an order-level evidence capability.
export const OPERATION_REQUIREMENTS=Object.freeze({
  product_attribution:['linked_campaign_order_product_identity','compatible_attribution_window'],
  basket_composition:['complete_unique_orders','reconciled_discounted_lines','unit_allocation','stable_product_identity'],
  merchandise_mean:['unique_order_amounts','valid_value_denominator'],
  merchandise_median:['unique_order_amounts','valid_value_denominator'],
  basket_gaps:['governed_numeric_measure','exact_boundaries'],
  break_even:['observed_charge','compatible_product_costs','compatible_fulfilment_costs'],
  numeric_bands:['complete_unique_population','governed_numeric_measure','exact_boundaries'],
  threshold_scenarios:['numeric_bands','observed_charge','eligibility_semantics','exceptions_and_unknowns'],
  profit_optimization:['compatible_product_costs','compatible_fulfilment_costs'],
  behaviour_forecast:['validated_behaviour_model','compatible_population'],
  optional_product_enrichment:['published_destination_prices','no_inferred_basket_relationships']
});
// Grouped attribution needs linked product evidence; campaign totals cannot
// satisfy it even when the subject, selected campaign and dates stay the same.
export function requestedAttributionOperation(text,context={}) {
  return /\bproducts?\b/i.test(text)&&/\b(?:bought|purchased|sold|sales|revenue|attribut\w*)\b/i.test(text)&&(/\b(?:campaigns?|emails?|ads?)\b/i.test(text)||context.campaign_request&&/\b(?:attribut\w*|from it|through it)\b/i.test(text))&&! /\b(?:all product sales|overall product sales)\b/i.test(text)?'product_attribution':null;
}
export function individualOrderQuestion(message) {
  return /\border\s+#?(?=[A-Z0-9._/-]*\d)[A-Z0-9][A-Z0-9._/-]*\b/i.test(String(message||''))&&/\b(?:details?|look\s*up|shipping|charges?|status|show|get|find)\b/i.test(String(message||''))&&!/\b(?:orders|population|distribution|bands|compare thresholds)\b/i.test(String(message||''));
}
export function metricOperations(message) {
  const text=String(message||'');
  const sourceNativeMean=/\b(?:shopify[ -]reported|source[ -]native|operational\s+(?:aov|average\s+order\s+value))\b/i.test(text)&&!/\bmerchandise\b/i.test(text);
  return [...(!sourceNativeMean&&/\b(?:aov|basket averages?|(?:average|mean)(?:\s*(?:and|\/)\s*median)?(?:\s+merchandise)?\s+(?:order|basket)\s+value|mean(?:\s+merchandise)?\s+(?:order|basket)\s+value)\b/i.test(text)?['merchandise_mean']:[]),...(/\bmedians?\b/i.test(text)?['merchandise_median']:[]),...(/\b(?:basket|spend|threshold)[ -]?gaps?\b|\b(?:within|short by)\s+£/i.test(text)?['basket_gaps']:[]),...(/\bbreak[ -]?even\b/i.test(text)?['break_even']:[])];
}
export function analyticalOperationFamily(operations=[]) {
  return operations.includes('basket_composition')?'basket_composition':operations.length?'order_distribution':null;
}
export function mergeRequestedOperations(previous,requested,text) {
  // An explicit change of operation replaces incompatible settings, independent
  // of retained geography, currency or dates. Additive metrics remain additive.
  if(requested?.length&&analyticalOperationFamily(previous)&&analyticalOperationFamily(previous)!==analyticalOperationFamily(requested))return [...new Set(requested)];
  return [...new Set([...(requested?.length&&/\b(?:only|instead(?: of)?|replace)\b/i.test(text)&&(!/\b(?:sort|rank)\b/i.test(text)||/\bonly\b/i.test(text))?[]:previous||[]),...requested||[]])];
}
export function requestedAnalyticalOperations(message,{orderValueFollowup=false}={}) {
  const text=String(message||'');
  if(individualOrderQuestion(text))return null;
  const composition=/\b(?:basket composition|order composition|single[ -](?:item|unit)|multi[ -](?:item|unit)|highest[ -]value (?:individual )?(?:item|unit|product)|underlying reconciled basket|basket averages|highest (?:discounted )?individual (?:item|unit)|baskets?[^.;]{0,100}only through multiple items|product combinations?|main[ -]product|remaining (?:items|products)|items per order|products? (?:bought|purchased) together)\b/i.test(text);
  if(composition)return {version:1,charge_domain:false,operations:['basket_composition',...metricOperations(text),...(/\b(?:value bands?|£\s*\d+\s+(?:value )?bands?)\b/i.test(text)?['numeric_bands']:[]),...(/threshold comparisons?|recorded shipping charges/i.test(text)?['threshold_scenarios']:[]),...(/\b(?:profit optimization|profit-optimal)\b/i.test(text)?['profit_optimization']:[])],parameters:{},population:{shipping_destination:/\b(?:UK|United Kingdom)\b/i.test(text)?'GB':null,channel:/\bonline\b/i.test(text)?'online':null,currency:text.match(/\b(GBP|USD|EUR|JPY)\b/i)?.[1]?.toUpperCase()||(/£/.test(text)?'GBP':null)},completed_days:/completed day|through yesterday/i.test(text)};
  const bands=/\b(?:order[ -]?value|basket[ -]?(?:value|size)|merchandise (?:amount|value))\b[\s\S]{0,100}\b(?:bands?|distribution|buckets?|ranges?)\b|\b(?:bands?|distribution|buckets?)\b[\s\S]{0,100}\b(?:order|basket|merchandise)[ -]?(?:values?|amounts?|sizes?)\b/i.test(text);
  const moneyCount=[...text.matchAll(/£\s*\d+(?:\.\d+)?/g)].length;
  const shippingComparison=/\b(?:free[ -]?(?:shipping|delivery)|(?:shipping|delivery) (?:threshold|minimum)|(?:order|basket)[ -]?value)\b/i.test(text)&&moneyCount>1&&/\b(?:compare|versus|vs|instead|from|lower|raise|reduce|change|alternatives?|what if)\b/i.test(text);
  const scenarios=shippingComparison||/\bthresholds?\b/i.test(text)&&(/\b(?:compar[ei]|alternativ[es]|scenarios?|rais[ei]|lower|chang[ei])\w*\b/i.test(text)||[...text.matchAll(/£\s*\d+(?:\.\d+)?/g)].length>1);
  const extra=metricOperations(text);
  const monetaryPopulation=orderValueFollowup&&/\b(?:add[ -]?ons?|product[ -]?prices?|published[ -]?prices?|price evidence|profit|forecast|optimal)\b/i.test(text)||bands||extra.length>0&&(orderValueFollowup||/\b(?:order|basket|merchandise)[ -]?values?\b|\baov\b/i.test(text))||scenarios&&/\b(?:shipping|delivery|orders?|basket|merchandise)\b/i.test(text);
  if(!monetaryPopulation)return null;
  return {version:1,charge_domain:/\b(?:shipping|delivery)\b/i.test(text),operations:[...extra,...(bands?['numeric_bands']:[]),...(scenarios?['threshold_scenarios']:[]),...(/\bprofit|optimal|optimi[sz]/i.test(text)?['profit_optimization']:[]),...(/\b(?:forecast|elasticity)\b|\b(?:conversion|demand|purchasing|basket size)\b[^.;]{0,60}\b(?:drops?|falls?|rises?|increases?|decreases?|uplift|[0-9]+\s*%)\b/i.test(text)?['behaviour_forecast']:[]),...(/\b(?:add[ -]?ons?|products?|product[ -]?prices?|published[ -]?prices?)\b/i.test(text)?['optional_product_enrichment']:[])],
    parameters:{monetary_values:[...new Set([...text.matchAll(/£\s*(\d+(?:\.\d+)?)/g)].map(m=>Number(m[1])))].slice(0,20),unchanged_behaviour:/unchanged|same (?:purchas|behavio)/i.test(text)},
    population:{shipping_destination:/\bUK|United Kingdom\b/i.test(text)?'GB':null,channel:/\bonline\b/i.test(text)?'online':null,currency:text.match(/\b(GBP|USD|EUR|JPY)\b/i)?.[1]?.toUpperCase()||(/£/.test(text)?'GBP':null)},
    completed_days:/completed day|through yesterday|up to yesterday/i.test(text),
    promotion_query:text.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:sale|promotion)\b/i)?.[0]||null};
}

/** Fail closed before unrelated aggregates/model calls; optional context is
 * read through the existing governed service, independently of core support. */
export async function unsupportedOperationResult(request,context,{knowledgeService,operationKnowledgeService}={}) {
  if(!request)return null;
  knowledgeService=operationKnowledgeService||knowledgeService;
  const period={start_date:context?.start_date,end_date:context?.end_date};
  if(request.completed_days&&context?.current_day_included&&period.end_date)period.end_date=new Date(Date.parse(period.end_date+'T12:00:00Z')-86400000).toISOString().slice(0,10);
  const lines=['The requested order-value analysis is unavailable from the current governed evidence bindings.',
    'Order-value bands require a complete population of unique orders with a governed merchandise measure, discounts, tax semantics and the requested destination, channel and currency filters verified together. Period sales totals and average order value cannot supply this distribution.',
    request.charge_domain?'Threshold comparisons require shipping-eligibility merchandise amounts, exact non-overlapping boundaries, separate recorded shipping charges, free-shipping exceptions and unknown values. A supplied delivery charge is an illustrative assumption; raising a threshold does not establish that every affected customer would pay it. No historical shipping-revenue effect has been calculated.':'Threshold comparisons require exact non-overlapping boundaries, governed measures, exceptions and unknown values. No scenario effect has been calculated.',
    'Unchanged-behaviour scenarios would describe historical revenue effects only. Conversion, basket uplift, future profit and a profit-optimal threshold are unverified without compatible product and fulfilment costs.'];
  lines.push(['| Requested component | Outcome |','|---|---|',...request.operations.map(operation=>`| ${operation} | unavailable |`)].join('\n'));
  if(period.start_date&&period.end_date)lines.push(`Requested window: ${period.start_date} to ${period.end_date}, inclusive (Europe/London; ${request.completed_days?'completed days':'current-day completeness unverified'}).`);
  if(request.operations.includes('optional_product_enrichment'))lines.push('Add-on suggestions are unavailable in this result: current published UK prices and relevant basket relationships have not been verified. No inventory was queried.');
  let promotion=null;
  if(request.promotion_query&&period.start_date&&period.end_date){
    const promotionRequest={query:request.promotion_query,treatment:'context'};
    try{promotion=resolvePromotionDates(await retrievePromotionContext(knowledgeService,promotionRequest,period),promotionRequest,period);}catch{promotion={status:'retrieval_failed',events:[]};}
    const events=promotion?.events||[];
    if(promotion?.status==='confirmed')lines.push('Confirmed promotion context: '+events.map(e=>`${String(e.title||'Online promotion').replace(/[<>\r\n]/g,' ').slice(0,160)} (${e.effective_from} to ${e.effective_to})`).join('; ')+'. These dates provide context; no causal sale effect or threshold adjustment is inferred.');
    else lines.push('Requested promotion context could not be confirmed for this window. Its effect has not been inferred.');
  }
  return {answer:lines.join('\n\n'),analysis_unavailable:true,partial:Boolean(promotion?.status==='confirmed'),tools:promotion?['search_knowledge']:[],capability_selection:{version:1,operations:request.operations,unsupported_operations:request.operations.filter(x=>x!=='optional_product_enrichment'),population:request.population,parameters:request.parameters},evidence:promotion?{kind:'governed_capability_limitation',requested_subject:context?.requested_subject||null,promotion}:null};
}
