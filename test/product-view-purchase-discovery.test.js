import test from 'node:test';
import assert from 'node:assert/strict';
import {main,runDiscovery} from '../diagnostics/product-view-purchase-discovery.js';

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
  assert.ok(instances[0].jobs.every(job=>job.maximumBytesBilled===10_000_000&&job.useLegacySql===false));
  assert.equal(result.configuration.ga4_dataset,'analytics');
  assert.doesNotMatch(output,/private-value/);
});

test('discovery CLI retains ADC fallback when service-account JSON is not configured',async()=>{
  const instances=[];
  const result=await main({env:{GOOGLE_PROJECT_ID:'adc-project'},BigQueryClass:fakeClass(instances),write:()=>{}});
  assert.deepEqual(instances[0].options,{projectId:'adc-project',credentials:undefined});
  assert.deepEqual(result.configuration.missing,['GA4_SESSION_EVENTS_TABLE']);
});

test('invalid raw table configuration reports only its configuration name',async()=>{
  await assert.rejects(runDiscovery({bigquery:{},project:'p',rawTable:'credential-secret',ga4Dataset:'ga4'}),error=>error.message==='Invalid configuration: GA4_SESSION_EVENTS_TABLE'&&!error.message.includes('credential-secret'));
});
