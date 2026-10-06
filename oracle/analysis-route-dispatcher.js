import { withOracleCharts } from './evidence-charts.js';
import { productReportConfigKey } from './product-report-config.js';
import { ANALYSIS_TOOL_ROUTES, validateAnalysisContext, clarificationFor } from './analysis-context.js';

const baselineThenAgent = async ({message,baselineOverview,baselineOptions,chat,chatOptions}) =>
  await baselineOverview?.(message,baselineOptions) || await chat(message,chatOptions);

const governedBaseline = async ({message,baselineOverview,baselineOptions}) => {
  const result=await baselineOverview?.(message,baselineOptions);
  if(result)return result;
  throw Object.assign(new Error('The governed analysis route has no executable evidence binding.'),{code:'ANALYSIS_ROUTE_UNAVAILABLE'});
};

// This is the single registration point shared by context validation tests and
// request delivery. Values are executable bindings, rather than descriptive
// route names, so a deterministic transition cannot silently become orphaned.
export const ANALYSIS_ROUTE_DISPATCHERS = Object.freeze(Object.fromEntries(ANALYSIS_TOOL_ROUTES.map(route=>[
  route,
  ['get_woocommerce_device_conversion','get_governed_device_conversion','get_general_sales_analysis','export_product_priorities'].includes(route)
    ? governedBaseline
    : baselineThenAgent
])));

export function assertEvidenceAgreement(contextValue,evidence){
  const context=contextValue==null?null:validateAnalysisContext(contextValue);
  if(context?.product_report&&evidence){
    if(!evidence.report_config||productReportConfigKey(context.product_report)!==productReportConfigKey(evidence.report_config))throw Object.assign(new Error('Retrieved export does not agree with the full report configuration.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  }
  if(!evidence||!context?.requested_subject)return true;
  const actual=evidence.requested_subject||evidence.subject||({sales_baseline:'sales'}[evidence.selected_intent])||({shopify_operational_sales_baseline:'sales',governed_device_conversion:'device_conversion',focused_woo_historical_conversion:'woo_traffic_conversion',independent_calendar_month_comparison:'calendar_period_comparison',woo_shopify_platform_comparison:'platform_sales',woo_shopify_monthly_platform_comparison:'platform_sales'}[evidence.kind]);
  if(actual!==context.requested_subject)throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical subject.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(evidence.metrics&&context.metrics.some(metric=>!evidence.metrics.includes(metric)))throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical metrics.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(evidence.periods?.length&&context.start_date&&!evidence.periods.some(period=>period.start_date===context.start_date&&period.end_date===context.end_date))throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical period.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(context.entity_query&&evidence.entity_query!==context.entity_query)throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical entity.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  return true;
}

export async function dispatchAnalysisRequest({message,analysisContext,baselineOverview=null,baselineOptions,chat,chatOptions}){
  const context=analysisContext==null?null:validateAnalysisContext(analysisContext);
  const clarification=context?clarificationFor(context):null;if(clarification)return {answer:clarification,tools:[]};
  const binding=context?.tool_route?ANALYSIS_ROUTE_DISPATCHERS[context.tool_route]:baselineThenAgent;
  const result=await binding({message,baselineOverview,baselineOptions:{...baselineOptions,analysisContext:analysisContext??context},chat,chatOptions});
  try{assertEvidenceAgreement(context,result?.evidence);baselineOptions?.onProviderStage?.({stage:'evidence_validation',status:'success'});}catch(error){baselineOptions?.onProviderStage?.({stage:'evidence_validation',status:'failed',code:'EVIDENCE_SCOPE_MISMATCH'});throw error;}
  return withOracleCharts(result);
}
