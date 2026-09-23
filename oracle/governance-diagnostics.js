import { redactError } from './ui-security.js';

const BUSINESS_ERROR = /^(invalid |missing |prohibited |[a-z_]+ must |.* is required|.* is not active|.* was not found|products must |product mapping would create |relationship is already)/i;

export class GovernanceWriteError extends Error {
  constructor(stage, queryOperation, cause) {
    super(cause?.message || String(cause));
    this.name = 'GovernanceWriteError';
    this.stage = stage;
    this.queryOperation = queryOperation;
    this.cause = cause;
  }
}

export async function atGovernanceStage(stage, queryOperation, action) {
  try { return await action(); }
  catch (error) {
    if (error instanceof GovernanceWriteError) throw error;
    throw new GovernanceWriteError(stage, queryOperation, error);
  }
}

export function isGovernanceBusinessError(error) {
  const source = error instanceof GovernanceWriteError ? error.cause : error;
  return BUSINESS_ERROR.test(String(source?.message || ''));
}

export function governancePublicError(error) {
  const source = error instanceof GovernanceWriteError ? error.cause : error;
  return isGovernanceBusinessError(error)
    ? redactError(source?.message || '').slice(0, 300)
    : 'The request could not be completed';
}

export function governanceDiagnostic(error, context = {}) {
  const source = error instanceof GovernanceWriteError ? error.cause : error;
  const apiError = Array.isArray(source?.errors) ? source.errors[0] : null;
  return {
    ...context,
    stage: error?.stage || 'route',
    error_class: source?.constructor?.name || error?.constructor?.name || 'Error',
    bigquery_reason: apiError?.reason || null,
    bigquery_code: source?.code == null ? null : String(source.code).slice(0, 32),
    internal_message: redactError(source?.message || String(source || 'Unknown error')).slice(0, 500),
    query_operation: error?.queryOperation || null
  };
}
