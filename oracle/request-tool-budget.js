export const ORACLE_MAX_CONCURRENCY = 2;
export const ORACLE_SYNTHESIS_RESERVE_MS = 12_000;

export class RequestToolBudget {
  constructor({ deadlineAt, signal, maxConcurrency = ORACLE_MAX_CONCURRENCY, synthesisReserveMs = ORACLE_SYNTHESIS_RESERVE_MS, now = Date.now }) {
    this.deadlineAt = deadlineAt;
    this.signal = signal;
    this.maxConcurrency = maxConcurrency;
    this.synthesisReserveMs = synthesisReserveMs;
    this.now = now;
    this.proposed = 0;
    this.dispatched = 0;
    this.active = 0;
  }

  admit() {
    this.proposed += 1;
    if (this.signal?.aborted) return { admitted: false, code: 'REQUEST_CANCELLED' };
    if (this.now() >= this.deadlineAt - this.synthesisReserveMs) return { admitted: false, code: 'SYNTHESIS_TIME_RESERVED' };
    if (this.active >= this.maxConcurrency) return { admitted: false, code: 'REQUEST_CONCURRENCY_LIMIT' };
    this.dispatched += 1;
    this.active += 1;
    return { admitted: true };
  }

  complete() {
    this.active = Math.max(0, this.active - 1);
  }

  canContinueModel() {
    return !this.signal?.aborted && this.now() < this.deadlineAt;
  }
}

export function boundedToolFailure(tool, code) {
  const messages = {
    REQUEST_CANCELLED: 'The request ended before this evidence call could start',
    REQUEST_CONCURRENCY_LIMIT: 'The request-wide evidence concurrency limit was reached',
    SYNTHESIS_TIME_RESERVED: 'This evidence call was skipped to reserve time for the answer'
  };
  return { success: false, tool, code, retryable: false, error: messages[code] || 'The evidence call was not dispatched' };
}

export function toolCallSignature(tool, args) {
  const normalized = Object.fromEntries(Object.entries(args).sort(([a],[b])=>a.localeCompare(b)).map(([key,value]) => [
    key,
    typeof value === 'string' ? value.trim().replace(/\s+/g,' ') : value
  ]));
  return `${tool}:${JSON.stringify(normalized)}`;
}
