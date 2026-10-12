import { DAILY_SALES_CONTRACT } from './daily-sales-provider.js';
import { PRODUCT_REPORT_CAPABILITIES } from './product-report-config.js';
import { resolveAnalyticalPlan } from './analytical-plan.js';

// Contracts audited from the governed implementations, not inferred from names.
// Unlisted bindings remain reachable through the existing governed dispatcher.
export const ANALYTICAL_CAPABILITIES=Object.freeze({
  get_shopify_operational_sales_baseline:{metrics:['orders','gross_sales','discounts','returns','net_sales','total_sales','average_order_value','net_items_sold'],dimensions:['calendar_month','channel'],filters:['channel'],grain:'period',comparisons:['explicit_periods'],identity:'one Shopify shop; Online Store and POS predicates remain separate',delivery:['table','chart'],provenance:'ShopifyQL FROM sales; authoritative shop currency; collection coverage unverified'},
  get_daily_sales_analysis:{...DAILY_SALES_CONTRACT,dimensions:['weekday'],comparisons:['promotion_exclusion'],delivery:['table','chart','xlsx'],identity:'one authoritative Shopify shop',provenance:'ShopifyQL sales + shop metadata'},
  export_product_priorities:{metrics:PRODUCT_REPORT_CAPABILITIES,dimensions:['product'],filters:['catalogue_filter','product_ids','published_online'],grain:'period',comparisons:[],identity:'Shopify root product ID; unique canonical URL for traffic/search',delivery:['table','chart','xlsx'],provenance:'Complete paginated native catalogue before enrichment'},
  get_klaviyo_email_performance:{metrics:['purchases','revenue','email_attribution'],dimensions:['campaign','flow','conversion_metric','currency'],filters:['campaign_id','campaign_account','campaign_channel','report_kind'],grain:'calendar_month',comparisons:['calendar_periods'],identity:'governed account/channel/entity',delivery:['table'],provenance:'Persisted message reports, entity metadata and window coverage'}
});
export function resolveExecutionPlan(context,bindings) {
  const plan=resolveAnalyticalPlan(context),capability=ANALYTICAL_CAPABILITIES[context?.tool_route]||null;
  let limitation=null;
  if(context?.tool_route==='get_daily_sales_analysis'){
    if(plan.metrics.some(m=>!capability.metrics.includes(m)))limitation=`The daily binding supports net sales and source-native orders; ${plan.metrics.filter(m=>!capability.metrics.includes(m)).join(', ')} is unavailable for this analysis.`;
    else if(plan.dates.start_date>plan.dates.end_date)limitation='There are no completed days in this requested period at the runtime cutoff.';
    else if(plan.scope.platform!=='shopify'||plan.scope.channel!=='online')limitation='This daily sales binding supports Shopify Online Store only; in-store or another platform is unavailable for this analysis.';
    else if(plan.dimensions.length!==1||plan.dimensions[0]!=='weekday')limitation='This daily analytical binding supports weekday grouping; the requested grouping is unavailable.';
    else if(plan.comparison.start_date||plan.comparison.included_periods.length)limitation='A second reporting-period comparison is unavailable in this weekday binding; promotion exclusions use the same reporting window.';
    else if(plan.population.filters.length||plan.exclusions.length)limitation='Additional population or calendar exclusions are unavailable in this daily binding; confirmed promotion dates can be compared separately.';
  } else if(plan.dimensions.includes('weekday'))limitation='The selected governed capability cannot supply compatible daily evidence for weekday grouping.';
  return {plan,capability,limitation,execute:bindings?.[context?.tool_route]||null};
}
