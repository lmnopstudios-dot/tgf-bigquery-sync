import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnose} from '../diagnostics/november-migration-comparison.js';

test('migration diagnostic retrieves exact governed event and both periods using existing SELECT evidence only',async()=>{
  const calls=[],bigquery={query:async args=>{calls.push(args);return [[]];}};
  const result=await diagnose({bigquery,project:'test'});
  assert.equal(result.read_only,true);assert.equal(result.source_collection,false);assert.equal(result.source_mutation,false);
  assert.ok(calls.every(x=>/^\s*(SELECT|WITH)\b/.test(x.query)&&!/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP)\b/i.test(x.query)));
  assert.ok(calls.some(x=>x.params.id==='ev_d62be9ed-527e-403a-a661-cb2d11095ca5'));
  assert.ok(calls.some(x=>x.params.start_date==='2025-11-01'));
  assert.ok(calls.some(x=>x.params.start_date==='2024-11-01'));
  assert.ok(calls.some(x=>x.params.knowledge_type==='event'&&x.params.start_date.value==='2024-10-18'));
  assert.equal(result.results.finance_components_and_overlap.status,'fulfilled');
});
