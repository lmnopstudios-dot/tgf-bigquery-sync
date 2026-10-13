/** Only allowlisted machine fields leave the retrieval boundary. Never retain messages. */
const codes=new Set(['ORACLE_AGENT_DEADLINE','REQUEST_CANCELLED','ORDER_VALUE_READ_BOUND','EVIDENCE_SCOPE_MISMATCH']);
const reasons=new Set(['invalidQuery','invalid','notFound','accessDenied','billingNotEnabled','billingTierLimitExceeded','jobBillingTierLimitExceeded','resourcesExceeded','quotaExceeded','rateLimitExceeded','backendError','internalError','jobTimeout','stopped']);
const stages=new Set(['dataset_location','population_query','coverage_query','schema_inspection','population_dry_run','coverage_dry_run','join_uniqueness','population_trace_dry_run','population_trace','promotion','published_prices']);
export function safeReadFailure(error,stage) {
  if(error?.safe_failure)return safeReadFailure(error.safe_failure,stage);
  const nested=error?.response?.data?.error;
  const source=[...(Array.isArray(error?.errors)?error.errors:[]),...(Array.isArray(nested?.errors)?nested.errors:[])].find(e=>reasons.has(e.reason))||nested||error;
  const status=Number(error?.http_status??error?.response?.status??nested?.code??error?.code);
  const position=String(source?.message||'').match(/\[(\d{1,6}):(\d{1,6})\]/);
  const stored=error?.statement_location;
  const location=position?{line:Number(position[1]),column:Number(position[2])}:stored&&Number.isInteger(stored.line)&&Number.isInteger(stored.column)&&stored.line>0&&stored.line<=999999&&stored.column>0&&stored.column<=999999?{line:stored.line,column:stored.column}:null;
  return {stage:stages.has(error?.stage)?error.stage:stages.has(stage)?stage:'population_query',code:codes.has(error?.code)?error.code:'ORDER_VALUE_RETRIEVAL_FAILED',http_status:status>=400&&status<=599&&Number.isInteger(status)?status:null,bigquery_reason:reasons.has(source?.reason||error?.bigquery_reason)?source?.reason||error.bigquery_reason:null,statement_location:location};
}
export function readFailureError(error,stage) {
  const safe_failure=safeReadFailure(error,stage);
  return Object.assign(Error('Bounded evidence retrieval failed'),{code:safe_failure.code,safe_failure});
}
export function readFailureAction(f) {
  if(f.code==='REQUEST_CANCELLED')return 'The request was cancelled. Retry the analysis.';
  if(f.code==='ORACLE_AGENT_DEADLINE'||f.code==='ORDER_VALUE_READ_BOUND'||['resourcesExceeded','jobTimeout'].includes(f.bigquery_reason))return 'Retry with a shorter period within the read bounds.';
  if(f.bigquery_reason==='accessDenied'||f.http_status===403)return 'Check the reporting identity’s dataset read and query permissions, then retry.';
  if(f.stage==='dataset_location'||f.bigquery_reason==='notFound')return 'Verify the configured project, required tables and actual dataset location, then retry.';
  if(['invalidQuery','invalid'].includes(f.bigquery_reason))return 'Validate the population SQL against the deployed schema and typed parameter contract, then retry.';
  return 'Run the bounded read-only diagnostic to identify the failed retrieval stage before retrying.';
}
