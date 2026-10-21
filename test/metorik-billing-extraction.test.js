import test from 'node:test';
import assert from 'node:assert/strict';
import {observations,collectHistory,batchMergeSql} from '../customer-identity/history.js';
import {historySelectionKey} from '../customer-identity/history-selection.js';
import {diagnoseAgreement} from '../diagnostics/metorik-woo-email-agreement.js';

const observation=record=>observations({source:'ww',provider:'metorik_orders',record,recordId:'1',orderId:'1',now:'2026-10-21T00:00:00Z'});
test('Metorik billing field is additive, retains exact provenance and supports guest orders',()=>{
  for(const customer_id of [0,42]){
    const record={customer_id,order_updated_at:'2024-01-01T00:00:00Z'};
    const before=observation(record),after=observation({...record,billing_address_email:' Kept@real.org '});
    assert.equal(after.length,6);assert.deepEqual(after.slice(0,5),before.slice(0,5));
    const field=after.at(-1);
    assert.equal(field.provider,'metorik_orders');assert.equal(field.field_path,'billing_address_email');
    assert.equal(field.order_id,'1');assert.equal(field.record_id,'1');assert.equal(field.observed_at,new Date(record.order_updated_at).toISOString());
    assert.equal(field.retrieved_at,'2026-10-21T00:00:00Z');assert.equal(field.email,' Kept@real.org ');
    assert.equal(field.normalized,'kept@real.org');assert.equal(field.email_state,'usable');assert.equal(field.profile_key,null);
    assert.equal(field.native_customer_id,customer_id===0?null:'42');
    assert.deepEqual(field,observation({...record,billing_address_email:' Kept@real.org '}).at(-1));
    assert.notEqual(field.evidence_id,before.at(-1).evidence_id);
  }
  assert.equal(observations({source:'ww',provider:'native',record:{billing_address_email:'other@real.org'},recordId:'1'}).length,5);
  assert.equal(observations({source:'ww',provider:'metorik_customers',record:{email:'other@real.org'},recordId:'1'}).length,5);
});
test('missing, malformed, placeholder and conflicting billing evidence never becomes a selected winner',()=>{
  for(const [value,state] of [[undefined,'extraction_failure'],[null,'null'],['','empty'],[{},'extraction_failure'],['bad','malformed'],['guest@example.com','placeholder']]){
    const r=observation(value===undefined?{}:{billing_address_email:value}).at(-1);
    assert.equal(r.email_state,state);assert.equal(r.normalized,null);
  }
  const conflict=observation({email:'first@real.org',billing_address_email:'second@real.org'});
  assert.deepEqual(conflict.filter(r=>r.email_state==='usable').map(r=>r.normalized),['first@real.org','second@real.org']);
  assert.notEqual(conflict[0].evidence_id,conflict.at(-1).evidence_id);
});
test('new revision collects corrected evidence without resetting or reusing completed v2 progress',async()=>{
  const o={source:'ww',dataset:'identity',start:'1900-01-01',end:'2026-10-19'};
  const oldRevision='history-20261020-v2',revision='history-20261021-billing-v3';
  const oldKey=historySelectionKey({...o,adapter:'metorik_orders',revision:oldRevision});
  const newKey=historySelectionKey({...o,adapter:'metorik_orders',revision});
  assert.notEqual(oldKey,newKey);
  const commits=[],reads=[];let fetched=0;
  const bigquery={query:async q=>{
    reads.push(q);
    if(q.query.includes('history_progress'))return [q.params.job===oldKey?[{cursor:'784',complete:true}]:[]];
    return [[{...o,order_id:'1',customer_id:null,created_at:'2024-01-01T00:00:00Z',currency:'GBP'}]];
  }};
  const args={bigquery,project:'fixture',o,adapter:'metorik_orders',batches:1,env:{METORIK_UK_API_KEY:'private-token'},
    fetchImpl:async(url)=>{fetched++;assert.equal(new URL(url).searchParams.get('page'),'1');return new Response(JSON.stringify({data:[{order_id:1,customer_id:0,order_created_at:'2024-01-01T00:00:00Z',currency:'GBP',billing_address_email:'kept@real.org'}],pagination:{current_page:1,per_page:50,has_more_pages:false}}));},
    commit:async batch=>commits.push(batch)};
  assert.equal((await collectHistory({...args,revision:oldRevision})).records,0);assert.equal(fetched,0);
  const result=await collectHistory({...args,revision});
  assert.equal(result.status,'complete');assert.equal(fetched,1);assert.equal(commits.length,1);
  assert.equal(commits[0].jobKey,newKey);assert.equal(commits[0].revision,revision);assert.equal(commits[0].expectedCursor,'');
  assert.equal(commits[0].evidence.at(-1).field_path,'billing_address_email');assert.equal(commits[0].evidence.at(-1).email_state,'usable');
  assert.ok(reads.every(q=>!q.query.includes('UPDATE')));
  const sql=batchMergeSql('fixture','identity',{email_observations:'stage'});
  assert.doesNotMatch(sql,/DELETE|TRUNCATE/);assert.doesNotMatch(sql,/WHEN MATCHED THEN UPDATE SET email/);
});

const env={METORIK_UK_API_KEY:'private-token',WOO_UK_URL:'https://woo.fixture',WOO_UK_CONSUMER_KEY:'private-key',WOO_UK_CONSUMER_SECRET:'private-secret'};
const date='2024-01-01T00:00:00Z';
function transport({count=30,mutate=()=>{},throwNative=false}={}){
  const calls=[];
  return {calls,fetchImpl:async(url,options)=>{
    const u=new URL(url);calls.push({u,options});
    if(u.hostname==='app.metorik.com'){
      const rows=Array.from({length:count},(_,i)=>({order_id:100+i,customer_id:i%2?0:500+i,order_created_at:date,currency:'GBP',order_number:'provider-number',billing_address_email:' Kept@real.org '}));
      return new Response(JSON.stringify({data:rows,pagination:{current_page:1,per_page:30,has_more_pages:true}}));
    }
    if(throwNative)throw Error('secret provider body private@real.org private-token');
    const r={id:Number(u.pathname.split('/').at(-1)),number:'native-number',currency:'GBP',date_created_gmt:date,billing:{email:'kept@REAL.org'}};
    mutate(r);return new Response(JSON.stringify(r));
  }};
}
test('bounded diagnostic compares normalized original-order email independently of profiles for both strata',async()=>{
  const t=transport(),result=await diagnoseAgreement({env,fetchImpl:t.fetchImpl});
  assert.equal(result.acceptance,'passed_both_strata');assert.equal(result.requests,11);assert.equal(t.calls.length,11);
  for(const counts of Object.values(result.strata)){
    assert.equal(counts.selected,5);assert.equal(counts.identity_verified,5);assert.equal(counts.normalized_agreement,5);assert.equal(counts['number/different'],5);
    assert.equal(counts['metorik_field/usable'],5);assert.equal(counts['native_field/usable'],5);
  }
  assert.equal(t.calls.filter(c=>c.u.hostname==='app.metorik.com').length,1);
  assert.equal(t.calls[0].u.searchParams.get('per_page'),'30');
  assert.ok(t.calls.every(c=>c.options.method==='GET'&&c.options.redirect==='error'&&c.options.signal));
  assert.doesNotMatch(JSON.stringify(result),/kept@|private-|provider-number|native-number|"100"/i);
});
test('identity mismatch, unusable emails and usable disagreement cannot pass agreement',async()=>{
  for(const [mutate,category] of [
    [r=>{r.id++;},'identity_not_verified'],[r=>{r.currency='USD';},'identity_not_verified'],
    [r=>{r.date_created_gmt='2024-01-02T00:00:00Z';},'identity_not_verified'],
    [r=>{r.billing.email='different@real.org';},'normalized_disagreement'],
    [r=>{r.billing.email='guest@example.com';},'agreement_unevaluable'],
    [r=>{delete r.billing.email;},'agreement_unevaluable']]){
    const t=transport({count:2,mutate}),result=await diagnoseAgreement({env,fetchImpl:t.fetchImpl});
    assert.equal(result.acceptance,'not_passed');
    assert.ok(Object.values(result.strata).every(c=>c[category]===1&&!c.normalized_agreement));
  }
});
test('missing strata, request failures, bounds and invalid envelopes fail closed without PII or retries',async()=>{
  const one=transport({count:1});assert.equal((await diagnoseAgreement({env,fetchImpl:one.fetchImpl})).acceptance,'not_passed');
  const failure=transport({throwNative:true}),result=await diagnoseAgreement({env,fetchImpl:failure.fetchImpl});
  assert.equal(result.requests,2);assert.equal(result.acceptance,'not_passed');assert.doesNotMatch(JSON.stringify(result),/secret provider|private@|private-token/);
  for(const payload of ['x'.repeat(2097153),JSON.stringify({data:[],pagination:{current_page:2,per_page:30,has_more_pages:false}})]){
    const r=await diagnoseAgreement({env,fetchImpl:async()=>new Response(payload)});
    assert.equal(r.requests,1);assert.equal(r.acceptance,'not_passed');assert.equal(r.failure_stage,'metorik_sample');
  }
});
