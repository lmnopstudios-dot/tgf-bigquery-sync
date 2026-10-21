import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCommitJobs,JOB_IDS} from '../diagnostics/customer-history-commit-jobs.js';

test('exact job metadata preserves terminal errors and timing without any write or result API',async()=>{
  const calls=[];
  const result=await inspectCommitJobs({
    dataset:name=>{assert.equal(name,'customer_identity');return {getMetadata:async()=>[{location:'EU'}]};},
    job:(id,options)=>{calls.push(id);assert.equal(options.location,'EU');return {getMetadata:async()=>[{
      status:{state:'DONE',errorResult:{reason:'stopped',message:'Job cancelled'},errors:[{reason:'stopped'}]},
      configuration:{jobTimeoutMs:'20000',query:{query:'private SQL',queryParameters:['private parameter']}},
      statistics:{creationTime:'100',startTime:'110',endTime:'150',numChildJobs:'3',query:{totalSlotMs:'25'}},
    }]};},
  });
  assert.deepEqual(calls,JOB_IDS);
  assert.equal(result.jobs[0].provider_status.errorResult.message,'Job cancelled');
  assert.equal(result.jobs[0].start_to_end_ms,40);
  assert.equal(result.jobs[0].num_child_jobs,'3');
  assert.doesNotMatch(JSON.stringify(result),/private SQL|private parameter/);
});

test('one unavailable job does not discard the other job evidence',async()=>{
  const result=await inspectCommitJobs({dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),
    job:id=>({getMetadata:async()=>{if(id===JOB_IDS[0])throw Object.assign(Error('private'),{code:404});return [{status:{state:'DONE'}}];}}),
  });
  assert.equal(result.jobs[0].inspection,'unverified');
  assert.equal(result.jobs[1].state,'DONE');
});
