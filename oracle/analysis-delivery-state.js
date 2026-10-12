import { validateAnalysisContext } from './analysis-context.js';

export const failedAnalysisResult=result=>Boolean(result?.analysis_unavailable||result?.evidence?.retrieval_failed||result?.evidence?.availability==='provider_failure');
export function contextAfterFailure(previous,attempted) {
  if(!previous?.requested_subject)return validateAnalysisContext(attempted||{});
  if(previous.requested_subject===attempted?.requested_subject)return validateAnalysisContext(previous);
  return validateAnalysisContext({...previous,failed_subject_switch:{attempted_subject:attempted.requested_subject,previous_subject:previous.requested_subject,attempted_year:Number(attempted.start_date?.slice(0,4))}});
}
export function resolvedRetryTransition(value) {
  const context=validateAnalysisContext({...value,failed_subject_switch:null});
  return {context,transition:{continuation:true,set:[],clear:['failed_subject_switch'],retain:[],missing_required_fields:context.unresolved_required_fields,ready_to_execute:!context.unresolved_required_fields.length,applies_to_message:true}};
}
export const explicitAnalysisRetry=message=>/^\s*(?:retry|try again)(?:\s+(?:that|the|this|last|analysis|request|export|please))*[.!]?\s*$/i.test(message);
