import { resolveAnalysisDecision, reportAnalysisDecision, decisionResult } from './analysis-decision.js';
import { assertCampaignSetEvidence } from './campaign-set-analysis.js';
import { messageIntent, nonAnalyticalResult } from './message-intent.js';
import { assertOrderValueEvidence } from './order-value-analysis.js';
import { requestedAnalyticalOperations, unsupportedOperationResult } from './requested-operations.js';
import { deliverOracleResult } from './result-delivery.js';
import { assertWeekdayEvidence } from './weekday-sales.js';
import { resolveAnalyticalPlan, analyticalPlanKey, assertPlanAgreement } from './analytical-plan.js';
import { catalogueFilterKey, scopeMismatch, assertCatalogueSelection } from './product-catalogue-filter.js';
import { presentAnalyticalAnswer } from './answer-presentation.js';
import { withOracleCharts } from './evidence-charts.js';
import { productReportMismatchField, resolveProductReportConfig } from './product-report-config.js';
import { ANALYSIS_TOOL_ROUTES, validateAnalysisContext, transitionAnalysisContext } from './analysis-context.js';

const baselineThenAgent = async ({message,baselineOverview,baselineOptions,chat,chatOptions}) =>
  await baselineOverview?.(message,baselineOptions) || await chat(chatOptions?.suppliedMessage||message,chatOptions);

const governedBaseline = async ({message,baselineOverview,baselineOptions}) => {
  const result=await baselineOverview?.(message,baselineOptions);
  if(result)return result;
  if(baselineOptions?.analysisContext?.tool_route==='get_order_value_analysis')return {answer:'Order-value aggregate capability is unavailable from the current evidence binding; no individual-order fallback was used.',analysis_unavailable:true,tools:[]};
  throw Object.assign(new Error('The governed analysis route has no executable evidence binding.'),{code:'ANALYSIS_ROUTE_UNAVAILABLE'});
};

// This is the single registration point shared by context validation tests and
// request delivery. Values are executable bindings, rather than descriptive
// route names, so a deterministic transition cannot silently become orphaned.
export const ANALYSIS_ROUTE_DISPATCHERS = Object.freeze(Object.fromEntries(ANALYSIS_TOOL_ROUTES.map(route=>[
  route,
  ['get_order_value_analysis','get_shopify_inventory_by_location','get_meta_performance','get_instagram_performance','get_woocommerce_device_conversion','get_governed_device_conversion','get_general_sales_analysis','get_daily_sales_analysis','export_product_priorities','get_klaviyo_email_performance','get_klaviyo_click_purchase_opportunities','compare_klaviyo_email_with_shopify_referrer'].includes(route)
    ? governedBaseline
    : baselineThenAgent
])));

/** Provider hydration may resolve identity, never replace the submitted subject/population. */
export function assertResolvedAnalysisContext(submittedValue,resolvedValue){
  if(!submittedValue?.requested_subject||!resolvedValue)return true;
  const submitted=validateAnalysisContext(submittedValue),resolved=validateAnalysisContext(resolvedValue),expected=resolveAnalyticalPlan(submitted),actual=resolveAnalyticalPlan(resolved);
  if(['get_daily_sales_analysis','get_order_value_analysis'].includes(submitted.tool_route)){
    if(!submitted.source_store)expected.scope.source_store=actual.scope.source_store;
    if(!submitted.currencies.length)expected.scope.currencies=actual.scope.currencies;
  }
  if(submitted.campaign_request){
    if(!submitted.campaign_request.selected){expected.entities.selected=actual.entities.selected;expected.dates.timezone=actual.dates.timezone;}
    expected.entities.candidates=actual.entities.candidates;
    if(!submitted.campaign_request.selected_entities.length){expected.entities.selected_entities=actual.entities.selected_entities;if(!submitted.campaign_request.account)expected.entities.scope.account=actual.entities.scope.account;if(!submitted.campaign_request.channel)expected.entities.scope.channel=actual.entities.scope.channel;}
    if(!submitted.campaign_request.comparison_entities.length)expected.entities.comparison_entities=actual.entities.comparison_entities;
    if(!submitted.campaign_request.reporting_windows.length)expected.entities.reporting_windows=actual.entities.reporting_windows;
    if(submitted.campaign_request.date_mode==='since_send'||!submitted.start_date&&actual.dates.basis==='since_send'){
      expected.dates.basis=actual.dates.basis;
      expected.dates.start_date=actual.dates.start_date;expected.dates.end_date=actual.dates.end_date;
      expected.dates.cutoff=actual.dates.cutoff;expected.dates.current_day_included=actual.dates.current_day_included;expected.dates.partial_period=actual.dates.partial_period;
    }
  }
  if(analyticalPlanKey(expected)!==analyticalPlanKey(actual))throw Object.assign(new Error('Resolved evidence changed the submitted analytical scope.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  return true;
}

export function assertEvidenceAgreement(contextValue,evidence,requestMessage=null){
  const context=contextValue==null?null:validateAnalysisContext(contextValue);
  assertPlanAgreement(context,evidence);
  if(context?.tool_route==='get_order_value_analysis'&&evidence)assertOrderValueEvidence(context,evidence);
  if(context?.tool_route==='get_daily_sales_analysis'&&evidence&&!evidence.analytical_plan)throw Object.assign(new Error('Recovered daily evidence has no validated plan'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(context?.tool_route==='get_daily_sales_analysis'&&evidence)assertWeekdayEvidence(context,evidence);
  if(context?.product_report&&evidence){
    if(requestMessage){const inferred=resolveProductReportConfig(requestMessage,{previous:context.product_report,defaultPeriod:context.product_report.period}).config.catalogue_filter;if(inferred&&catalogueFilterKey(inferred)!==catalogueFilterKey(context.product_report.catalogue_filter)&&!(inferred.source===null&&catalogueFilterKey({...context.product_report.catalogue_filter,source:null,collection_id:undefined})===catalogueFilterKey(inferred)))throw Object.assign(new Error('Recovered export lost the original category request'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});}
    assertCatalogueSelection(evidence,context.product_report);
    const mismatch=productReportMismatchField(context.product_report,evidence.report_config);if(mismatch)throw scopeMismatch(mismatch);
  }
  if(!evidence||!context?.requested_subject)return true;
  const actual=evidence.requested_subject||evidence.subject||({sales_baseline:'sales'}[evidence.selected_intent])||({shopify_operational_sales_baseline:'sales',governed_device_conversion:'device_conversion',focused_woo_historical_conversion:'woo_traffic_conversion',independent_calendar_month_comparison:'calendar_period_comparison',woo_shopify_platform_comparison:'platform_sales',woo_shopify_monthly_platform_comparison:'platform_sales'}[evidence.kind]);
  if(actual!==context.requested_subject)throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical subject.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(evidence.metrics&&context.metrics.some(metric=>!evidence.metrics.includes(metric)))throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical metrics.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(evidence.periods?.length&&context.start_date&&!evidence.periods.some(period=>period.start_date===context.start_date&&period.end_date===context.end_date))throw Object.assign(new Error('Retrieved evidence does not agree with the resolved analytical period.'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});
  if(evidence.kind==='governed_klaviyo_campaign_set'){assertCampaignSetEvidence(context,evidence);return true;}
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
  const nonAnalysis=nonAnalyticalResult(message);
  if(nonAnalysis){if(nonAnalysis.answer)return deliverOracleResult(nonAnalysis,null);return chat?await chat(message,{...chatOptions,analysisContext:null,toolsAllowed:false}):{answer:'Please specify the text edit you would like.',tools:[]};}
  const intent=messageIntent(message);
  if(intent.document&&!transitionAnalysisContext(null,intent.instruction).context.tool_route)return deliverOracleResult(await chat(message,{...chatOptions,analysisContext:null,toolsAllowed:false}),null);
  if(intent.document){analysisContext=transitionAnalysisContext(null,intent.instruction).context;chatOptions={...chatOptions,suppliedMessage:message,analysisContext};message=intent.instruction;}
  const context=analysisContext==null?null:validateAnalysisContext(analysisContext);
  const requested=requestedAnalyticalOperations(message);
  if(requested&&context?.tool_route!=='get_order_value_analysis'){baselineOptions?.onProviderStage?.({stage:'capability_selection',status:'unsupported',operation_count:requested.operations.length});return deliverOracleResult(await unsupportedOperationResult(requested,context||transitionAnalysisContext(null,message).context,baselineOptions),context);}
  const decision=resolveAnalysisDecision(context,ANALYSIS_ROUTE_DISPATCHERS),execution=decision.execution;
  reportAnalysisDecision(decision,baselineOptions?.onProviderStage);
  if(decision.outcome!=='execution')return deliverOracleResult(decisionResult(decision),context);
  baselineOptions?.onProviderStage?.({stage:'capability_selection',selected_route:context?.tool_route||'general_agent',registered:Boolean(execution.capability),delivery:execution.delivery||'chat',status:'selected'});
  const binding=execution.execute||baselineThenAgent;
  let result=await binding({message,baselineOverview,baselineOptions:{...baselineOptions,analysisContext:analysisContext??context},chat,chatOptions});
  try{assertResolvedAnalysisContext(context,result?.analysis_context);assertEvidenceAgreement(result?.analysis_context||context,result?.evidence);baselineOptions?.onProviderStage?.({stage:'evidence_validation',status:'success'});}catch(error){baselineOptions?.onProviderStage?.({stage:'evidence_validation',status:'failed',code:'EVIDENCE_SCOPE_MISMATCH',scope_field:error.scope_field||'analytical_scope'});throw error;}
  if(result?.evidence&&context?.requested_subject&&!result.evidence.report_config)result={...result,evidence:{...result.evidence,analytical_plan:resolveAnalyticalPlan(result.analysis_context||context)}};
  if(result&&!context?.product_report)result={...result,analysis_context:result.analysis_context||context};
  await baselineOptions?.onEvidence?.(result);
  try{return deliverOracleResult(presentAnalyticalAnswer(withOracleCharts(disclosePeriod(result,result?.analysis_context||context)),result?.analysis_context||context),result?.analysis_context||context);}catch{return deliverOracleResult({...result,answer:null,presentation:null,partial:true},result?.analysis_context||context);}
}

/** Shared deterministic /agent entrypoint; a null result continues existing model tooling. */
export async function executeGovernedAgentAnalysis({message,analysisContext,baselineOverview,baselineOptions={},scopeResolved=false,now=Date.now()}){
  const nonAnalysis=nonAnalyticalResult(message);
  if(nonAnalysis){if(nonAnalysis.answer)return deliverOracleResult(nonAnalysis,null);return null;}
  const intent=messageIntent(message);
  if(intent.document&&!transitionAnalysisContext(null,intent.instruction,{now}).context.tool_route)return null;
  if(intent.document){analysisContext=transitionAnalysisContext(null,intent.instruction,{now}).context;scopeResolved=true;message=intent.instruction;}
  const resolved=scopeResolved?{context:validateAnalysisContext(analysisContext||{})}:transitionAnalysisContext(analysisContext,message,{now});
  baselineOptions.onProviderStage?.({stage:'scope_resolution',resolved_subject:resolved.context.requested_subject,selected_route:resolved.context.tool_route,start_date:resolved.context.start_date,end_date:resolved.context.end_date});
  const requested=requestedAnalyticalOperations(message);
  if(requested&&resolved.context.tool_route!=='get_order_value_analysis')return deliverOracleResult(await unsupportedOperationResult(requested,resolved.context,baselineOptions),resolved.context);
  const decision=resolveAnalysisDecision(resolved.context,ANALYSIS_ROUTE_DISPATCHERS),execution=decision.execution;
  reportAnalysisDecision(decision,baselineOptions.onProviderStage);
  if(decision.outcome!=='execution')return deliverOracleResult(decisionResult(decision),resolved.context);
  baselineOptions.onProviderStage?.({stage:'capability_selection',selected_route:resolved.context.tool_route||'general_agent',registered:Boolean(execution.capability),delivery:execution.delivery||'chat',status:'selected'});
  let result=await baselineOverview(message,{...baselineOptions,analysisContext:resolved.context});
  if(!result){
    if(resolved.context.tool_route==='get_order_value_analysis')return {answer:'Order-value aggregate capability is unavailable from the current evidence binding; no individual-order fallback was used.',analysis_unavailable:true,tools:[]};
    return null;
  }
  assertResolvedAnalysisContext(resolved.context,result.analysis_context);
  assertEvidenceAgreement(result.analysis_context||resolved.context,result.evidence);
  if(result.evidence&&!result.evidence.report_config)result={...result,evidence:{...result.evidence,analytical_plan:resolveAnalyticalPlan(result.analysis_context||resolved.context)}};
  if(!resolved.context.product_report)result={...result,analysis_context:result.analysis_context||resolved.context};
  await baselineOptions.onEvidence?.(result);
  try{return deliverOracleResult(presentAnalyticalAnswer(withOracleCharts(disclosePeriod(result,result.analysis_context||resolved.context)),result.analysis_context||resolved.context),result.analysis_context||resolved.context,{artifactBase:baselineOptions.downloadBase||'/api/oracle/exports'});}catch{return deliverOracleResult({...result,answer:null,presentation:null,partial:true},result.analysis_context||resolved.context,{artifactBase:baselineOptions.downloadBase||'/api/oracle/exports'});}
}
