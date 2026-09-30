import test from 'node:test';
import assert from 'node:assert/strict';
import {DISCOVERY_MAXIMUM_BYTES_BILLED,main,runDiscovery} from '../diagnostics/product-view-purchase-discovery.js';

const EXPECTED_DISCOVERY_CAP=104_857_600;

function assertEveryQueryIsBounded(jobs,expectedCount){
  assert.equal(DISCOVERY_MAXIMUM_BYTES_BILLED,EXPECTED_DISCOVERY_CAP);
  assert.equal(jobs.length,expectedCount);
  for(const job of jobs){
    assert.equal(job.maximumBytesBilled,EXPECTED_DISCOVERY_CAP);
    assert.equal(job.useLegacySql,false);
  }
}

function fakeClass(instances){
  return class FakeBigQuery{
    constructor(options){this.options=options;this.jobs=[];instances.push(this);}
    dataset(name,{projectId}){return {getMetadata:async()=>[{location:name==='raw_events'?'us':'eu',projectId}]};}
    async query(options){this.jobs.push(options);return [[]];}
  };
}

test('discovery CLI loads configured service-account credentials and metadata locations',async()=>{
  const instances=[];
  const credentials={project_id:'service-project',client_email:'reader@example.test',private_key:'private-value'};
  let output='';
  const result=await main({env:{GOOGLE_SERVICE_ACCOUNT_JSON:JSON.stringify(credentials),GA4_DATASET:'analytics',GA4_SESSION_EVENTS_TABLE:'events-project.raw_events.events_*'},BigQueryClass:fakeClass(instances),write:value=>{output+=value;}});
  assert.equal(instances.length,1);
  assert.deepEqual(instances[0].options,{projectId:'service-project',credentials});
  assert.deepEqual(instances[0].jobs.map(job=>job.location),['EU','EU','US']);
  assertEveryQueryIsBounded(instances[0].jobs,3);
  assert.equal(result.configuration.ga4_dataset,'analytics');
  assert.doesNotMatch(output,/private-value/);
});

test('discovery CLI retains ADC fallback when service-account JSON is not configured',async()=>{
  const instances=[];
  const result=await main({env:{GOOGLE_PROJECT_ID:'adc-project'},BigQueryClass:fakeClass(instances),write:()=>{}});
  assert.deepEqual(instances[0].options,{projectId:'adc-project',credentials:undefined});
  assertEveryQueryIsBounded(instances[0].jobs,2);
  assert.deepEqual(result.configuration.missing,['GA4_SESSION_EVENTS_TABLE']);
});

test('invalid raw table configuration reports only its configuration name',async()=>{
  await assert.rejects(runDiscovery({bigquery:{},project:'p',rawTable:'credential-secret',ga4Dataset:'ga4'}),error=>error.message==='Invalid configuration: GA4_SESSION_EVENTS_TABLE'&&!error.message.includes('credential-secret'));
});
