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

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_STAGE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Produces an operationally useful diagnostic without reflecting exception
 * text. Exception messages frequently contain SQL parameter values, prompts,
 * upstream response bodies, or credentials, so only a fixed message and
 * stack-frame locations from this application are eligible for logs.
 */
export function serverFailureDiagnostic({id,path,stage,error}) {
  const code=SAFE_CODE.test(String(error?.code||''))?String(error.code):'ORACLE_INTERNAL_ERROR';
  const safeStage=SAFE_STAGE.test(String(stage||''))?String(stage):'request_dispatch';
  const frames=String(error?.stack||'').split('\n').slice(1,9).map(line=>{
    const match=line.match(/(?:at\s+([^\s(]+)\s+)?\(?((?:file:\/\/)?[^\s():]*oracle\/[^\s():]+|(?:file:\/\/)?[^\s():]*server\.js):(\d+):(\d+)\)?/);
    if(!match)return null;
    const file=match[2].replace(/^file:\/\//,'').replace(/^.*\/(oracle\/)/,'$1').replace(/^.*\/(server\.js)$/,'$1');
    return `${match[1]||'<anonymous>'} (${file}:${match[3]}:${match[4]})`;
  }).filter(Boolean);
  return {
    request_id:requestId(id),
    request_path:String(path||'unknown').split('?')[0].slice(0,160),
    failure_stage:safeStage,
    error_class:errorClass(error),
    error_code:code,
    message:`Oracle request failed during ${safeStage}.`,
    stack:frames.length?frames:['unavailable']
  };
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
