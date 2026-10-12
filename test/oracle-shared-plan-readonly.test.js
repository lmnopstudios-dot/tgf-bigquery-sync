import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyDiagnostic, validateReadOnlyDiagnostic } from '../diagnostics/oracle-shared-plan-readonly.js';
test('bounded live diagnostic dispatches exact provider scopes and one read-only job query',async()=>{
  const calls=[],dailySales=async args=>{calls.push(args);return {rows:[],period:{start_date:args.start_date,end_date:args.end_date},grain:'day',source_store:'shop',currency:'GBP',channel:'online'};};
  await readOnlyDiagnostic({mode:'sales',start:'2026-05-01',end:'2026-05-31'},{dailySales});assert.deepEqual(calls[0],{start_date:'2026-05-01',end_date:'2026-05-31',platform:'shopify',channel:'online',reporting_timezone:'Europe/London',currencies:[],source_store:null});
  const result=await readOnlyDiagnostic({mode:'job','job-id':'12345678-1234-1234-1234-123456789abc'},{project:'fixture',bigquery:{query:async args=>{calls.push(args);return [[]];}}});assert.equal(result.found,false);assert.match(calls[1].query,/^SELECT .*WHERE job_id=@job_id LIMIT 1$/);assert.doesNotMatch(calls[1].query,/INSERT|UPDATE|MERGE|CREATE|DELETE/);assert.equal(calls[1].maximumBytesBilled,'500000000');
});
test('diagnostic rejects unbounded dates, arbitrary modes and write options before dependencies',()=>{
  for(const input of [{mode:'sales',start:'2026-01-01',end:'2026-12-31'},{mode:'sales',start:'2026-02-30',end:'2026-03-01'},{mode:'collect'},{mode:'job','job-id':'anything'},{mode:'campaign',execute:'true'}])assert.throws(()=>validateReadOnlyDiagnostic(input));
});
