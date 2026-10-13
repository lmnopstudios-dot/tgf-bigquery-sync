import { ORDER_VALUE_DEFINITIONS } from './order-value-provider.js';
import { DAILY_SALES_CONTRACT } from './daily-sales-provider.js';
import { PRODUCT_REPORT_CAPABILITIES } from './product-report-config.js';
import { resolveAnalyticalPlan } from './analytical-plan.js';

// Contracts audited from the governed implementations, not inferred from names.
// Unlisted bindings remain reachable through the existing governed dispatcher.
export const ANALYTICAL_CAPABILITIES=Object.freeze({
  get_order_value_analysis:{metrics:['orders'],dimensions:['numeric_band'],filters:['shipping_country','currency','channel'],operations:['numeric_bands','threshold_scenarios','optional_product_enrichment'],grain:'order',comparisons:['promotion_exclusion'],delivery:['table','chart','xlsx'],preferred_transport:'job',identity:'source-qualified unique Shopify orders',definitions:ORDER_VALUE_DEFINITIONS,provenance:'Persisted order components; shipping eligibility and population completeness unverified'},
  get_shopify_operational_sales_baseline:{metrics:['orders','gross_sales','discounts','returns','net_sales','total_sales','average_order_value','net_items_sold'],dimensions:['calendar_month','channel'],filters:['channel'],grain:'period',comparisons:['explicit_periods'],identity:'one Shopify shop; Online Store and POS predicates remain separate',delivery:['table','chart'],provenance:'ShopifyQL FROM sales; authoritative shop currency; collection coverage unverified'},
  get_daily_sales_analysis:{...DAILY_SALES_CONTRACT,dimensions:['weekday'],comparisons:['promotion_exclusion'],delivery:['table','chart','xlsx'],identity:'one authoritative Shopify shop',provenance:'ShopifyQL sales + shop metadata'},
  export_product_priorities:{preferred_transport:'job',metrics:PRODUCT_REPORT_CAPABILITIES,dimensions:['product'],filters:['catalogue_filter','product_ids','published_online'],grain:'period',comparisons:[],identity:'Shopify root product ID; unique canonical URL for traffic/search',delivery:['table','chart','xlsx'],provenance:'Complete paginated native catalogue before enrichment'},
  get_klaviyo_email_performance:{metrics:['purchases','revenue','email_attribution'],dimensions:['campaign','flow','conversion_metric','currency'],filters:['campaign_id','campaign_account','campaign_channel','report_kind'],grain:'calendar_month',comparisons:['calendar_periods'],identity:'governed account/channel/entity',delivery:['table'],provenance:'Persisted message reports, entity metadata and window coverage'}
});
export function resolveExecutionPlan(context,bindings) {
  const plan=resolveAnalyticalPlan(context),capability=ANALYTICAL_CAPABILITIES[context?.tool_route]||null;
  let limitation=null;
  if(context?.tool_route==='get_order_value_analysis'){
    // Unspecified scope permits the disclosed Shopify online subset. Explicit
    // source/channel constraints still block incompatible population reads.
    if(!['shopify','all',null].includes(plan.scope.platform)||!['online',null].includes(plan.scope.channel)||plan.scope.channel_breakdown||context.source_store&&context.source_store!=='shopify')limitation='Order-value evidence currently supports the governed Shopify online population only. Other store populations have not been combined. No population retrieval was attempted. Specify Shopify online for a scoped analysis, or request a supported source-specific report.';
    else if(plan.population.filters.includes('combined_source_population'))limitation='A combined order-value population across sources has no compatible governed binding. Request separate source-specific reports; no population retrieval was attempted.';
    else if(!plan.numeric_operation)limitation='Numeric operation parameters are required.';
    else if(plan.scope.currencies.length>1)limitation='Choose one currency for this order-value population; currencies cannot be combined.';
    else if(plan.population.filters.length||plan.exclusions.length)limitation='These additional eligibility filters or calendar exclusions have no verified order-value binding. Clarify the required filter or use a supported population; no retrieval was attempted. Confirmed promotion exclusions are supported.';
    else if(plan.dates.start_date>plan.dates.end_date)limitation='There are no completed days in this requested period. Choose a window ending before today.';
    else if((Date.parse(plan.dates.end_date)-Date.parse(plan.dates.start_date))/86400000>=1464)limitation='Order-value analysis supports at most four disjoint 366-day reads. Choose a period of at most 1,464 days; no population retrieval was attempted.';
  } else if(context?.tool_route==='get_daily_sales_analysis'){
    if(plan.metrics.some(m=>!capability.metrics.includes(m)))limitation=`The daily binding supports net sales and source-native orders; ${plan.metrics.filter(m=>!capability.metrics.includes(m)).join(', ')} is unavailable for this analysis.`;
    else if(plan.dates.start_date>plan.dates.end_date)limitation='There are no completed days in this requested period at the runtime cutoff.';
    else if(plan.scope.platform!=='shopify'||plan.scope.channel!=='online')limitation='This daily sales binding supports Shopify Online Store only; in-store or another platform is unavailable for this analysis.';
    else if(plan.dimensions.length!==1||plan.dimensions[0]!=='weekday')limitation='This daily analytical binding supports weekday grouping; the requested grouping is unavailable.';
    else if(plan.comparison.start_date||plan.comparison.included_periods.length)limitation='A second reporting-period comparison is unavailable in this weekday binding; promotion exclusions use the same reporting window.';
    else if(plan.population.filters.length||plan.exclusions.length)limitation='Additional population or calendar exclusions are unavailable in this daily binding; confirmed promotion dates can be compared separately.';
  } else if(plan.dimensions.includes('weekday'))limitation='The selected governed capability cannot supply compatible daily evidence for weekday grouping.';
  const components=(plan.requested_operations||[]).map(operation=>({operation,status:limitation?'blocked':capability?.operations?.includes(operation)?(operation==='numeric_bands'?'supported':'conditional'):'unsupported',blocker:limitation||(operation==='profit_optimization'?'Profit optimization requires compatible product and fulfilment costs; supply those costs before requesting a profit recommendation.':operation==='behaviour_forecast'?'A user-supplied behaviour change is an unverified scenario assumption. A validated behaviour model is required for forecasts; the displayed arithmetic keeps existing orders and behaviour unchanged.':null)}));
  if(context?.tool_route==='get_order_value_analysis'&&(plan.comparison.start_date||plan.comparison.included_periods.length))components.push({operation:'period_comparison',status:'unsupported',blocker:'The additional period comparison has no verified order-value binding. The primary requested window is retained; request each comparison window separately.'});
  return {plan,capability,limitation,components,delivery:context?.unresolved_required_fields?.length||limitation?'chat':capability?.preferred_transport||null,execute:bindings?.[context?.tool_route]||null};
}
