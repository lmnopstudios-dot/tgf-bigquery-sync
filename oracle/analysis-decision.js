import { validateAnalysisContext, clarificationFor } from './analysis-context.js';
import { resolveExecutionPlan } from './analytical-capabilities.js';

// One pre-execution decision for direct, interactive and persisted job inputs.
// Provider-owned identity/evidence questions run only after this decision.
export function resolveAnalysisDecision(value, bindings) {
  const context=validateAnalysisContext(value||{}), execution=resolveExecutionPlan(context,bindings);
  const unsupported=execution.limitation;
  const question=unsupported?null:clarificationFor(context);
  const fields=question?(context.period_issue?['start_date','end_date']:context.failed_subject_switch?['requested_subject']:context.product_report?.unresolved||context.unresolved_required_fields):[];
  const outcome=unsupported?'limitation':question?'clarification':'execution';
  return {context,execution,outcome,answer:unsupported||question,fields,reason:unsupported?'capability_unavailable':context.period_issue?'invalid_period':question?'required_input':'scope_resolved',scope_method:context.campaign_request?'entity_metadata':context.date_cutoff?'runtime_calendar':context.start_date?'retained_or_explicit_calendar':'no_calendar_scope'};
}

// Only bounded structural values, never user text, entity names or exceptions.
export function reportAnalysisDecision(decision, onStage) {
  if(decision.outcome==='limitation')onStage?.({stage:'capability_selection',status:'blocked',selected_route:decision.context.tool_route||'general_agent',provider_calls:0,component_count:decision.execution.components.length});
  onStage?.({stage:'analysis_decision',status:decision.outcome,reason:decision.reason,unresolved_fields:decision.fields,scope_method:decision.scope_method,selected_route:decision.context.tool_route||'general_agent'});
}

export function decisionResult(decision) {
  const c=decision.context,answer=decision.outcome==='limitation'&&c.start_date?`**Resolved dates:** ${c.start_date} to ${c.end_date}, inclusive (${c.time_zone||'Europe/London'}). Current day ${c.current_day_included?'included; evidence may be partial':'excluded'}.\n\n${decision.answer}`:decision.answer;
  return {answer,tools:[],analysis_context:c,
    ...(decision.outcome==='clarification'?{clarification:{message:decision.answer,fields:decision.fields,reason:decision.reason}}:{analysis_unavailable:true,capability_selection:{components:decision.execution.components,retrieval:'not_attempted'}})};
}
