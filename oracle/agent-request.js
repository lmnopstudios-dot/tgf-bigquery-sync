import { validateAnalysisContext } from './analysis-context.js';

// Keep prior evidence and serialized scope out of the natural-language question.
// The UI has already resolved scope; the agent consumes that snapshot once.
export function governedAgentRequest(message, conversation={}, deadlineAt) {
  return {message,analysis_context:conversation.analysisContext||null,scope_resolved:true,deadline_at:deadlineAt,request_id:conversation.requestId,job_id:conversation.jobId||null,job_attempt:conversation.attempt||null,durable_job:conversation.durable===true};
}

// Only the model synthesis path receives this description, after deterministic
// resolution and provider selection. It must never feed a scope parser.
export function governedModelInput(message, context) {
  const scope=validateAnalysisContext(context||{});
  if(!scope.metrics.length)return message;
  return `Authoritative resolved analytical scope: ${JSON.stringify(scope)}\n\nCurrent user message: ${message}\n\nUse only this scope for provider arguments. Prior evidence must not supply implicit dates or subjects. State the applied scope and preserve supported evidence and limitations.`;
}
