import { normalizeCatalogueFilter } from './product-catalogue-filter.js';
import { DAILY_SALES_CONTRACT } from './daily-sales-provider.js';
import { PRODUCT_REPORT_CAPABILITIES } from './product-report-config.js';
import { createHash } from 'node:crypto';

// A projection over existing validated context, not another competing intent store.
// Delivery preferences are deliberately independent of the analytical subject.
export function resolveAnalyticalPlan(c) {
  const report=c?.product_report, campaign=c?.campaign_request;
  return {
    version:1, subject:c?.requested_subject||null,
    entities:{selected:campaign?.selected||c?.product_ref||null,candidates:campaign?.candidates||c?.pending_product_candidates||[],query:c?.entity_query||campaign?.name||null},
    population:{catalogue_filter:normalizeCatalogueFilter(report?.catalogue_filter),selection:report?.population||null,filters:c?.filters||[]},
    scope:{...(c?.tool_route==='get_order_value_analysis'?{shipping_destination:c?.geography||null}:{}),platform:c?.platform||null,source_store:c?.source_store||null,channel:c?.channel||null,channel_breakdown:Boolean(c?.channel_breakdown),currencies:c?.currencies||[],currency:report?.currency||null},
    metrics:report?.metrics||campaign?.requested_metrics||(c?.native_metrics?.length?c.native_metrics:c?.metrics)||[],
    metric_definitions:report?Object.fromEntries(report.metrics.map(m=>[m,PRODUCT_REPORT_CAPABILITIES[m]?.definition||'Unavailable'])):c?.tool_route==='get_daily_sales_analysis'?DAILY_SALES_CONTRACT.definitions:null,
    numeric_operation:c?.numeric_operation||null,requested_operations:c?.requested_operations||[],
    dimensions:c?.dimensions||[],grain:c?.grain||null,
    dates:{start_date:c?.start_date||null,end_date:c?.end_date||null,timezone:c?.time_zone||campaign?.selected?.reporting_timezone||report?.period?.timezone||'Europe/London',cutoff:c?.date_cutoff||null,partial_period:Boolean(c?.partial_period),current_day_included:Boolean(c?.current_day_included),basis:campaign?.date_mode||null},
    comparison:{type:c?.comparison_type||null,start_date:c?.comparison_start_date||null,end_date:c?.comparison_end_date||null,included_periods:c?.included_periods||[]},
    promotion:c?.promotion_context?{query:c.promotion_context.query,treatment:c.promotion_context.treatment,...(c.promotion_context.endpoint_choice?{endpoint_choice:c.promotion_context.endpoint_choice}:{}),...(c.promotion_context.endpoint_zone?{endpoint_zone:c.promotion_context.endpoint_zone}:{}),supplied_periods:c.promotion_context.supplied_periods||[]}:null,exclusions:c?.exclusions||[],
    ranking:report?.sort||{metric:c?.ranking_metric||null,direction:c?.ranking_direction||'desc'},
    presentation:{format:c?.output_preference||null,columns:report?.metrics||[],limit:c?.limit||null},
    pending:{fields:report?.unresolved||c?.unresolved_required_fields||[],campaign:campaign?.selected?null:campaign?.selector||null}
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
  if(scope.population)scope.population={...scope.population,catalogue_filter:normalizeCatalogueFilter(scope.population.catalogue_filter)};
  return createHash('sha256').update(stableAnalyticalJSON(scope)).digest('hex');
}
export function assertPlanAgreement(context,evidence) {
  if(!context?.requested_subject||!evidence?.analytical_plan)return;
  let recorded=evidence.analytical_plan;
  // Legacy order-value envelopes carry country separately. Accept only that
  // validated destination when upgrading their saved plan; never infer a new one.
  if(context.tool_route==='get_order_value_analysis'&&!Object.hasOwn(recorded.scope||{},'shipping_destination')&&evidence.country===context.geography)recorded={...recorded,scope:{...recorded.scope,shipping_destination:evidence.country}};
  if(analyticalPlanKey(resolveAnalyticalPlan(context))!==analyticalPlanKey(recorded))throw Object.assign(new Error('Saved evidence differs from the validated analytical plan.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
}
