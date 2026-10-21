import test from 'node:test';
import assert from 'node:assert/strict';
import {previewHistory} from '../customer-identity/history.js';
import {historyFailure} from '../customer-identity/history-warehouse.js';
import {diagnosePreview} from '../diagnostics/customer-history-preview.js';

for(const failureAt of [1,2])test(`preview attributes failed read ${failureAt} and stops`,async()=>{
  let calls=0;
  const job={id:'fixture_job',getQueryResults:async()=>{
    if(calls===failureAt)throw Object.assign(Error('private@customer.test'),{errors:[{reason:'resourcesExceeded'}]});
    return [[],null,{jobComplete:true,totalRows:'0'}];
  },cancel:async()=>{},getMetadata:async()=>[{status:{state:'DONE'}}]};
  await assert.rejects(previewHistory({project:'fixture',dataset:'customer_identity',bigquery:{createQueryJob:async()=>{calls++;return [job];}}}),error=>{
    const safe=historyFailure(error);
    assert.equal(safe.stage,failureAt===1?'preview_coverage':'preview_evidence');
    assert.equal(safe.job_id,'fixture_job');
    assert.equal(safe.bigquery_reason,'resourcesExceeded');
    assert.equal(safe.commit_outcome,'not_committed');
    assert.doesNotMatch(JSON.stringify(safe),/private@/);
    return true;
  });
  assert.equal(calls,failureAt);
});
test('probe submits exactly one dry run and emits fixed planning category without provider text',async()=>{
  let calls=0;
  const result=await diagnosePreview({project:'fixture',bigquery:{createQueryJob:async settings=>{
    calls++;assert.equal(settings.dryRun,true);assert.match(settings.query,/^WITH h_orders/);assert.doesNotMatch(settings.query,/CREATE TEMP TABLE/);assert.equal(settings.maximumBytesBilled,'1000000000');
    throw Object.assign(Error('Not enough resources for query planning - too many subqueries private@customer.test'),{code:400,errors:[{reason:'resourcesExceeded'}]});
  }}});
  assert.equal(calls,1);assert.equal(result.query_form,'unmaterialized_cte');assert.equal(result.resource_category,'planning_complexity');
  assert.equal(result.stage,'preview_coverage');assert.equal(result.bigquery_reason,'resourcesExceeded');
  assert.doesNotMatch(JSON.stringify(result),/private@|SELECT|subqueries/);
});
