import { ONLINE_COUNTRY_SALES_SEMANTICS } from './online-country-sales.js';
import { scopeAgreementError } from './scope-diagnostics.js';
import { normalizeCatalogueFilter } from './product-catalogue-filter.js';
import { DAILY_SALES_CONTRACT } from './daily-sales-provider.js';
import { PRODUCT_REPORT_CAPABILITIES } from './product-report-config.js';
import { createHash } from 'node:crypto';

export function planOperation(c) {
  if(c?.tool_route==='compare_historical_events')return 'named_event_comparison';
  if(c?.journey_intent==='collaboration_purchase_products')return 'collaboration_purchase_products';
  if(c?.journey_intent==='second_purchase_products')return 'second_purchase_products';
  if(c?.analysis_type==='customer_journey')return (c.journey_intent==='retention'||c.journey_group_by==='collaboration_name')?'cohort_retention':'customer_journey';
  if(c?.tool_route==='get_population_conversion')return 'population_comparison';
  if(c?.requested_operations?.includes('product_attribution'))return 'product_attribution';
  if(c?.requested_operations?.includes('basket_composition'))return 'basket_composition';
  if(c?.requested_operations?.length)return 'order_distribution';
  if(c?.product_report||c?.tool_route==='get_product_sales_analysis')return 'product_breakdown';
  if(c?.comparison_start_date||c?.comparison_type)return 'period_comparison';
  if(c?.campaign_request)return c.campaign_request.compare_previous?'entity_comparison':'campaign_performance';
  return ({get_shopify_operational_sales_baseline:'sales_totals',get_governed_device_conversion:'conversion_trend',get_woocommerce_device_conversion:'conversion_trend',get_daily_sales_analysis:'grouped_sales',get_klaviyo_email_performance:'campaign_performance'})[c?.tool_route]||(c?.tool_route?'summary':null);
}

// A projection over existing validated context, not another competing intent store.
// Delivery preferences are deliberately independent of the analytical subject.
export function resolveAnalyticalPlan(c) {
  const report=c?.product_report, campaign=c?.campaign_request;
  return {
    version:1, operation:planOperation(c), subject:c?.requested_subject||null,
    entities:{...(campaign?{scope:{entity_type:campaign.entity_type,source:campaign.source,rule:campaign.selector,count:campaign.count,offset:campaign.offset,ordering_basis:campaign.ordering_basis,account:campaign.account,channel:campaign.channel,selection_cutoff:campaign.cutoff,compare_previous:campaign.compare_previous},selected_entities:campaign.selected_entities,comparison_entities:campaign.comparison_entities,reporting_windows:campaign.reporting_windows}:{}),selected:campaign?.selected||c?.product_ref||null,candidates:campaign?.candidates||c?.pending_product_candidates||[],query:c?.entity_query||campaign?.name||null},
    population:{catalogue_filter:normalizeCatalogueFilter(report?.catalogue_filter),selection:report?.population||null,filters:c?.filters||[],...(c?.population_scope?{geography_role:c.population_scope.geography_role,country:c.population_scope.country,...(c.population_scope.comparison_country?{comparison_country:c.population_scope.comparison_country}:{})}: {})},
    scope:{...(c?.journey_scope?{journey_scope:c.journey_scope}:{}),...(c?.tool_route==='get_order_value_analysis'?{shipping_destination:c?.geography||null}:{}),platform:c?.platform||null,source_store:c?.source_store||null,channel:c?.channel||null,channel_breakdown:Boolean(c?.channel_breakdown),currencies:c?.currencies||[],currency:report?.currency||null},
    metrics:report?.metrics||campaign?.requested_metrics||(c?.native_metrics?.length?c.native_metrics:c?.metrics)||[],
    metric_definitions:c?.tool_route==='compare_historical_events'?{sales:ONLINE_COUNTRY_SALES_SEMANTICS.metric,orders:'Source-qualified eligible order count; source-native status rules; phases counted once.'}:report?Object.fromEntries(report.metrics.map(m=>[m,PRODUCT_REPORT_CAPABILITIES[m]?.definition||'Unavailable'])):c?.tool_route==='get_daily_sales_analysis'?DAILY_SALES_CONTRACT.definitions:null,
    ...(c?.analysis_type==='customer_journey'?{cohort:{entry_start:c.cohort_entry_start,entry_end:c.cohort_entry_end,observation_end:c.observation_end,first_order_semantic:c.first_order_semantic,entry_classification:c.entry_product_classification,group_by:c.journey_group_by,within_days:c.within_days,windows:c.retention_windows||null,baseline:Boolean(c.retention_baseline),second_products:Boolean(c.retention_second_products),sort:c.sort||null}}:{}),
    ...(c?.request_detail?{request_detail:c.request_detail}:{}),numeric_operation:c?.numeric_operation||null,requested_operations:c?.requested_operations||[],
    dimensions:c?.dimensions||[],grain:c?.grain||null,
    dates:{start_date:c?.start_date||null,end_date:c?.end_date||null,timezone:c?.time_zone||campaign?.selected?.reporting_timezone||report?.period?.timezone||'Europe/London',cutoff:c?.date_cutoff||null,partial_period:Boolean(c?.partial_period),current_day_included:Boolean(c?.current_day_included),basis:campaign?.date_mode||null},
    ...(c?.tool_route==='compare_historical_events'?{event_selection:{name:c.event_name,count:c.event_count,completion:'completed',period_structure:'disjoint_campaigns',phases:'nested'}}:{}),
    comparison:{...(c?.population_scope?{groups:c.population_scope.groups,overlap:c.population_scope.groups.includes('country')&&c.population_scope.groups.includes('global')}:{}),type:c?.comparison_type||null,start_date:c?.comparison_start_date||null,end_date:c?.comparison_end_date||null,included_periods:c?.included_periods||[]},
    promotion:c?.promotion_context?{query:c.promotion_context.query,treatment:c.promotion_context.treatment,...(c.promotion_context.endpoint_choice?{endpoint_choice:c.promotion_context.endpoint_choice}:{}),...(c.promotion_context.endpoint_zone?{endpoint_zone:c.promotion_context.endpoint_zone}:{}),supplied_periods:c.promotion_context.supplied_periods||[]}:null,exclusions:c?.exclusions||[],
    ranking:report?.sort||{metric:campaign?.ranking_metric||c?.ranking_metric||null,direction:c?.ranking_direction||'desc'},
    presentation:{formats:c?.requested_formats||[],format:c?.output_preference||null,columns:report?.metrics||[],limit:c?.limit||null},
    pending:{fields:report?.unresolved||c?.unresolved_required_fields||[],campaign:campaign?.selected||campaign?.selected_entities?.length?null:campaign?.selector||null}
  };
}
export function stableAnalyticalJSON(value){
  const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  return JSON.stringify(canonical(value));
}
export function analyticalPlanKey(plan) {
  // Asking for a chart/download does not change the evidence population.
  const {presentation,pending,...scope}=plan;
  // Older saved plans predate operation declarations; an absent list means none.
  scope.requested_operations=scope.requested_operations||[];
  if(scope.request_detail){const {formats,...detail}=scope.request_detail;scope.request_detail=detail;}
  if(scope.population)scope.population={...scope.population,catalogue_filter:normalizeCatalogueFilter(scope.population.catalogue_filter)};
  return createHash('sha256').update(stableAnalyticalJSON(scope)).digest('hex');
}
export function assertPlanAgreement(context,evidence) {
  if(!context?.requested_subject||!evidence?.analytical_plan)return;
  let recorded=evidence.analytical_plan;
  if(!Object.hasOwn(recorded,'operation'))recorded={...recorded,operation:planOperation(context)};
  // Legacy order-value envelopes carry country separately. Accept only that
  // validated destination when upgrading their saved plan; never infer a new one.
  if(context.tool_route==='get_order_value_analysis'&&!Object.hasOwn(recorded.scope||{},'shipping_destination')&&evidence.country===context.geography)recorded={...recorded,scope:{...recorded.scope,shipping_destination:evidence.country}};
  // Upgrade only an original single-campaign envelope. Every legacy identity,
  // date, metric and population field must still agree with validated context.
  const campaign=context.campaign_request;
  if(campaign&&campaign.count===1&&campaign.offset===0&&!campaign.selected_entities.length&&!campaign.compare_previous&&!Object.hasOwn(recorded.entities||{},'scope')){
    const entities=resolveAnalyticalPlan(context).entities;
    recorded={...recorded,entities:{...recorded.entities,scope:entities.scope,selected_entities:entities.selected_entities,comparison_entities:entities.comparison_entities,reporting_windows:entities.reporting_windows}};
  }
  if(analyticalPlanKey(resolveAnalyticalPlan(context))!==analyticalPlanKey(recorded))throw scopeAgreementError(resolveAnalyticalPlan(context),recorded);
}
