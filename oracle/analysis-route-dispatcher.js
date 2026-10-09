import { assertCatalogueSelection } from './product-catalogue-filter.js';
import { presentAnalyticalAnswer } from './answer-presentation.js';
import { withOracleCharts } from './evidence-charts.js';
import { productReportConfigKey, resolveProductReportConfig } from './product-report-config.js';
import { ANALYSIS_TOOL_ROUTES, validateAnalysisContext, clarificationFor, transitionAnalysisContext } from './analysis-context.js';

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
  ['get_shopify_inventory_by_location','get_meta_performance','get_instagram_performance','get_woocommerce_device_conversion','get_governed_device_conversion','get_general_sales_analysis','export_product_priorities','get_klaviyo_email_performance','get_klaviyo_click_purchase_opportunities','compare_klaviyo_email_with_shopify_referrer'].includes(route)
    ? governedBaseline
    : baselineThenAgent
])));

export function assertEvidenceAgreement(contextValue,evidence,requestMessage=null){
  const context=contextValue==null?null:validateAnalysisContext(contextValue);
  if(context?.product_report&&evidence){
    if(requestMessage){const inferred=resolveProductReportConfig(requestMessage,{previous:context.product_report,defaultPeriod:context.product_report.period}).config.catalogue_filter;if(inferred&&JSON.stringify(inferred)!==JSON.stringify(context.product_report.catalogue_filter))throw Object.assign(new Error('Recovered export lost the original category request'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});}
    assertCatalogueSelection(evidence,context.product_report);
    if(!evidence.report_config||productReportConfigKey(context.product_report)!==productReportConfigKey(evidence.report_config))throw Object.assign(new Error('Retrieved export does not agree with the full report configuration.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  }
  if(!evidence||!context?.requested_subject)return true;
  const actual=evidence.requested_subject||evidence.subject||({sales_baseline:'sales'}[evidence.selected_intent])||({shopify_operational_sales_baseline:'sales',governed_device_conversion:'device_conversion',focused_woo_historical_conversion:'woo_traffic_conversion',independent_calendar_month_comparison:'calendar_period_comparison',woo_shopify_platform_comparison:'platform_sales',woo_shopify_monthly_platform_comparison:'platform_sales'}[evidence.kind]);
  if(actual!==context.requested_subject)throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical subject.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(evidence.metrics&&context.metrics.some(metric=>!evidence.metrics.includes(metric)))throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical metrics.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(evidence.periods?.length&&context.start_date&&!evidence.periods.some(period=>period.start_date===context.start_date&&period.end_date===context.end_date))throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical period.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(['device_conversion','klaviyo_email','meta_ads','instagram'].includes(context.requested_subject)){
    const expected=[{start_date:context.start_date,end_date:context.end_date},...(context.comparison_start_date?[{start_date:context.comparison_start_date,end_date:context.comparison_end_date}]:[])];
    const key=p=>`${p?.start_date}/${p?.end_date}`;
    if(!Array.isArray(evidence.periods)||evidence.periods.length!==expected.length||expected.some(p=>!evidence.periods.some(actual=>key(actual)===key(p))))throw Object.assign(new Error('Evidence must contain exactly the resolved periods.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
    if(context.requested_subject==='device_conversion'&&(!Array.isArray(evidence.sections)||!evidence.sections.length||evidence.sections.some(s=>!expected.some(p=>s.period?.start_date>=p.start_date&&s.period?.end_date<=p.end_date))))throw Object.assign(new Error('Conversion populations fall outside resolved periods.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});

    if(context.requested_subject==='device_conversion'){
      const wanted=[];
      for(const p of expected)for(let cursor=new Date(`${p.start_date.slice(0,7)}-01T00:00:00Z`);cursor.toISOString().slice(0,10)<=p.end_date;cursor.setUTCMonth(cursor.getUTCMonth()+1)){
        const start=cursor.toISOString().slice(0,10),end=new Date(Date.UTC(cursor.getUTCFullYear(),cursor.getUTCMonth()+1,0)).toISOString().slice(0,10);
        const name=new Intl.DateTimeFormat('en',{month:'short',timeZone:'UTC'}).format(cursor).toLowerCase();if(context.exclusions.includes(name))continue;
        wanted.push({start_date:start<p.start_date?p.start_date:start,end_date:end>p.end_date?p.end_date:end});
      }
      const populationKeys=[...new Set(wanted.map(key))];
      if(evidence.sections.length!==populationKeys.length||populationKeys.some(k=>!evidence.sections.some(s=>key(s.period)===k)))throw Object.assign(new Error('Both exact comparison populations must be represented.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
    }
    if(context.comparison_start_date&&!evidence.periods?.some(p=>p.start_date===context.comparison_start_date&&p.end_date===context.comparison_end_date))throw Object.assign(new Error('Comparison evidence does not agree with resolved dates.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
    if((evidence.comparison_type||null)!==(context.comparison_type||null))throw Object.assign(new Error('Comparison evidence does not agree with resolved scope.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
    if(['meta_ads','instagram'].includes(context.requested_subject)&&JSON.stringify(evidence.social_scope)!==JSON.stringify(context.social_scope))throw Object.assign(new Error('Social evidence differs from resolved scope'),{code:'EVIDENCE_SCOPE_MISMATCH'});
    if(context.email_report_kind&&evidence.email_report_kind!==context.email_report_kind)throw Object.assign(new Error('Email evidence does not agree with campaign/flow scope.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  }
  if(context.campaign_request?.selected&&evidence.campaign?.entity_id!==context.campaign_request.selected.entity_id)throw Object.assign(new Error('Campaign evidence identity differs from pending scope'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(context.entity_query&&evidence.entity_query!==context.entity_query)throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical entity.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  return true;
}

function disclosePeriod(result,context){
  if(!result?.answer||!context?.date_cutoff||!context.start_date||context.campaign_request)return result;
  return {...result,answer:`**Resolved dates:** ${context.start_date} to ${context.end_date}${context.comparison_start_date?` versus ${context.comparison_start_date} to ${context.comparison_end_date}`:''}, inclusive (Europe/London). Current day ${context.current_day_included?'included; evidence through the runtime cutoff may be partial':'excluded'}. Runtime cutoff: ${context.date_cutoff}.\n\n${result.answer}`};
}
export async function dispatchAnalysisRequest({message,analysisContext,baselineOverview=null,baselineOptions,chat,chatOptions}){
  const context=analysisContext==null?null:validateAnalysisContext(analysisContext);
  const clarification=context?clarificationFor(context):null;if(clarification)return {answer:clarification,tools:[]};
  const binding=context?.tool_route?ANALYSIS_ROUTE_DISPATCHERS[context.tool_route]:baselineThenAgent;
  const result=await binding({message,baselineOverview,baselineOptions:{...baselineOptions,analysisContext:analysisContext??context},chat,chatOptions});
  try{assertEvidenceAgreement(result?.analysis_context||context,result?.evidence);baselineOptions?.onProviderStage?.({stage:'evidence_validation',status:'success'});}catch(error){baselineOptions?.onProviderStage?.({stage:'evidence_validation',status:'failed',code:'EVIDENCE_SCOPE_MISMATCH'});throw error;}
  return presentAnalyticalAnswer(withOracleCharts(disclosePeriod(result,result?.analysis_context||context)),context);
}

/** Shared deterministic /agent entrypoint; a null result continues existing model tooling. */
export async function executeGovernedAgentAnalysis({message,analysisContext,baselineOverview,baselineOptions={},scopeResolved=false,now=Date.now()}){
  const resolved=scopeResolved?{context:validateAnalysisContext(analysisContext||{})}:transitionAnalysisContext(analysisContext,message,{now});
  baselineOptions.onProviderStage?.({stage:'scope_resolution',resolved_subject:resolved.context.requested_subject,selected_route:resolved.context.tool_route,start_date:resolved.context.start_date,end_date:resolved.context.end_date});
  const clarification=clarificationFor(resolved.context);
  if(clarification)return {answer:clarification,tools:[]};
  const result=await baselineOverview(message,{...baselineOptions,analysisContext:resolved.context});
  if(!result)return null;
  assertEvidenceAgreement(result.analysis_context||resolved.context,result.evidence);
  return presentAnalyticalAnswer(withOracleCharts(disclosePeriod(result,resolved.context)),resolved.context);
}
