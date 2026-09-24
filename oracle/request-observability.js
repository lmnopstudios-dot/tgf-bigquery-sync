import crypto from 'node:crypto';

const REQUEST_ID = /^[A-Za-z0-9._-]{1,80}$/;

export function requestId(value) {
  const supplied = String(value || '');
  return REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
}

export function errorClass(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'TimeoutError';
  return String(error?.constructor?.name || 'Error').slice(0, 80);
}

export function stageOutcome({ id, stage, startedAt, outcome, error, extra = {} }) {
  return {
    request_id: id,
    stage,
    outcome,
    elapsed_ms: Math.max(0, Date.now() - startedAt),
    ...(error ? { error_class: errorClass(error) } : {}),
    ...extra
  };
}

export function affinityJustified(message) {
  return /\b(?:product affinity|customer overlap|also (?:buy|bought)|bought together|cross[ -]?sell)\b/i.test(String(message || ''));
}

export function terminalMessage(stage, hasEvidence = false) {
  if (hasEvidence) return 'I retrieved some governed evidence, but the final analysis step did not complete in time. Use the verified observations below as a partial answer; recommendations that need the unavailable evidence are clearly unverified.';
  if (stage === 'agent_request') return 'The analysis service did not return before the request deadline. No figures were returned; please retry.';
  if (stage === 'response_generation') return 'The evidence review completed, but the final answer could not be generated before the request deadline. No figures were returned; please retry.';
  return 'The analysis could not be completed at the final response stage. No figures were returned; please retry.';
}

export function partialAnswer(message, successfulTools = [], failedTools = []) {
  const stockAdvice = /\b(?:stock|clearance|clear|inventory)\b/i.test(String(message || ''))
    ? ' Start with a time-boxed, product-specific landing page; feature the items together in onsite merchandising and email; test an offer against a no-discount control; and track units sold, margin, conversion and stock remaining. Confirm current variant and location stock before publishing, and review collaboration or discount restrictions.'
    : '';
  const evidence = successfulTools.length
    ? `Governed evidence completed from: ${[...new Set(successfulTools)].join(', ')}.`
    : 'No governed evidence completed.';
  const unavailable = failedTools.length
    ? ` Optional evidence unavailable: ${[...new Set(failedTools)].join(', ')}.`
    : '';
  return `${evidence}${unavailable}${stockAdvice} The final synthesis did not complete, so do not treat these proposed tactics as evidence-backed findings.`;
}
