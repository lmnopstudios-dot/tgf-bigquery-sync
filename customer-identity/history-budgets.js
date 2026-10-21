// Render parent history_d862705d4f0a490991d5c83828e2635c took 31,321ms.
// Fourteen materializations took 925–3,611ms each. See the incident runbook
// for the calculation and the unresolved parent/child status discrepancy.
export const HISTORY_SCRIPT_BUDGETS=Object.freeze({
  preview_coverage:Object.freeze({statementMs:10000,maximumMs:90000}),
  publish:Object.freeze({statementMs:10000,maximumMs:210000,reconciliationMs:20000}),
});
export const HISTORY_PREVIEW_MAXIMUM_MS=110000; // coverage + ordinary evidence read
export const HISTORY_PUBLICATION_MAXIMUM_MS=230000; // script + same-job reconciliation
