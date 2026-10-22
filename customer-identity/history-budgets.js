// Render parent history_d862705d4f0a490991d5c83828e2635c took 31,321ms.
// The later verified script had a successful 13,272ms materialization.
// Allow 30s per statement; retain the existing whole-script ownership ceilings.
// This corrects sizing, not the unresolved cause of the stopped h_usable job.
export const HISTORY_SCRIPT_BUDGETS=Object.freeze({
  preview_coverage:Object.freeze({statementMs:30000,maximumMs:90000}),
  publish:Object.freeze({statementMs:30000,maximumMs:210000,reconciliationMs:20000}),
});
export const HISTORY_PREVIEW_MAXIMUM_MS=110000; // coverage + ordinary evidence read
export const HISTORY_PUBLICATION_MAXIMUM_MS=230000; // script + same-job reconciliation
