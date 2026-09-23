import assert from 'node:assert/strict';
import { emptyAnalysisContext, transitionAnalysisContext } from '../oracle/analysis-context.js';

// Safe, isolated, non-writing harness for the exact production transition contract.
let context=emptyAnalysisContext();
const run=message=>{const result=transitionAnalysisContext(context,message);if(result.transition.applies_to_message)context=result.context;console.log(message,'=>',result.transition);return result};
let result=run('can i get a monthly breakdown of refunds');assert.deepEqual(context.metrics,['refunds']);assert.equal(context.grain,'month');assert.deepEqual(result.transition.missing_required_fields,['start_date','end_date']);
result=run('jan 2023 - sept 2026');assert.equal(result.transition.ready_to_execute,true);assert.deepEqual(context.metrics,['refunds']);assert.equal(context.currencies[0],'GBP');
const dates=[context.start_date,context.end_date];run('split that online and instore');assert.equal(context.channel_breakdown,true);assert.deepEqual([context.start_date,context.end_date],dates);
run('just USD');assert.deepEqual(context.currencies,['USD']);assert.deepEqual([context.start_date,context.end_date],dates);
run('weekly instead');assert.equal(context.grain,'week');assert.deepEqual(context.metrics,['refunds']);
result=run('What do you know about Black Friday 2025?');assert.equal(result.transition.applies_to_message,false);assert.deepEqual(context.metrics,['refunds']);
console.log('Oracle conversation production validation passed (isolated; no writes).');
