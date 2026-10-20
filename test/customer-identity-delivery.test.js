import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceFixture,acceptanceServer} from './helpers/oracle-acceptance.js';
import {customerHistoryContract} from '../oracle/customer-history.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';
const identityEnv={ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v1',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'email-20261020-v1'};
const now=Date.parse('2026-10-20T12:00:00Z');
const question='Rank named collaborations by 90-day repeat purchase rate online over the last three years through yesterday, including linked Woo and Shopify history.';
for(const version of ['email_candidate_v1','email_candidate_v2'])for(const mode of ['direct','interactive','durable'])test(`activated ${version} analytical history preserves safeguards through ${mode} follow-ups and recovery`,async t=>{
  const identityEnv={ORACLE_CUSTOMER_IDENTITY_MODE:version,ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'email-20261020-v1'};
  const f=acceptanceFixture({retention_events:true,observationCertificates:[],identityEnv,now});
  const h=await acceptanceServer(f,{durable:mode==='durable',now});t.after(h.close);
  const send=async(message,context)=>mode==='direct'?(await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message,analysis_context:context})})).json()):h.submit(message);
  const result=await send(question);
  assert.equal(result.evidence.kind,'governed_cohort_retention');
  assert.equal(result.evidence.coverage.identity,'email_candidate_v1');
  assert.deepEqual(result.evidence.coverage.customer_history,customerHistoryContract(true));
  assert.ok(result.evidence.coverage.identity_activation.every(s=>s.activation==='active'));
  assert.match(result.answer,/email candidate snapshot/i);
  if(version==='email_candidate_v2'){assert.match(result.answer,/email-linked records/);assert.match(result.answer,/3 matched, 2 unmatched, 1 ambiguous, 2 unavailable/);assert.ok(f.wireQueries.some(q=>q.query.includes('identity_order_links')));}
  assert.doesNotMatch(result.answer,/customer linkage has not been verified/);
  assert.ok(result.evidence.rows.every(r=>r.mature_customers===0&&r.repeat_customers===0&&r.repeat_rate===null));
  assert.equal(deliverOracleResult(structuredClone(result),result.analysis_context).delivery.status,'partial');
  const follow=await send('Show 180 days instead.',result.analysis_context);
  assert.equal(follow.evidence.ranking_window,180);assert.equal(follow.evidence.coverage.identity,'email_candidate_v1');
  assert.ok(f.wireQueries.filter(q=>q.query.includes('retention_members')).every(q=>q.params.coverage_status==='unverified'));
  if(mode==='durable'){
    const calls=f.wireQueries.length,recovered=await h.get('/jobs/'+follow.job_id);
    assert.equal(recovered.evidence.coverage.identity_activation[0].snapshot,identityEnv.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT);
    assert.equal(f.wireQueries.length,calls);
  }
});
test('unready activation falls back through shared delivery with visible metadata',async t=>{
  const f=acceptanceFixture({retention_events:true,identityEnv,identityReady:false,now}),h=await acceptanceServer(f,{now});t.after(h.close);
  const r=await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question})})).json();
  assert.equal(r.evidence.coverage.identity,'source_qualified_only');
  assert.ok(r.evidence.coverage.identity_activation.every(s=>s.activation==='fallback'));
  assert.deepEqual(r.evidence.coverage.customer_history,customerHistoryContract());
});
