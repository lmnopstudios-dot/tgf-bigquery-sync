import test from 'node:test';
import assert from 'node:assert/strict';
import {historicalEvidence} from '../customer-identity/historical-evidence.js';
import {sampleMetorik,summarizeRecords,discoverySql,diagnose} from '../diagnostics/metorik-email-evidence.js';

test('historical Metorik guest identity survives native Woo guest status and placeholders',()=>{
  const r=historicalEvidence({store:'usd',orderId:'1',metorikCustomerId:'900',wooCustomerId:'0',observations:[
    {provider:'metorik_api',field:'email',value:'Kept@fixture.example',retrievedAt:'2026-10-20'},
    {provider:'woo_api',field:'billing.email',value:'guest@example.com',retrievedAt:'2026-10-20'},
    {provider:'retained_woo',field:'billing.email',value:null,retrievedAt:'2026-10-20'}]});
  assert.equal(r.metorikCustomerRef,'metorik:usd:900');assert.equal(r.wooCustomerRef,null);
  assert.equal(r.emailState,'candidate');assert.equal(r.normalized,'kept@fixture.example');assert.equal(r.evidence.length,3);
  const conflict=historicalEvidence({store:'usd',orderId:'1',observations:[...r.evidence,{provider:'migration_export',field:'email',value:'other@fixture.example',retrievedAt:'2026-10-20'}]});
  assert.equal(conflict.emailState,'conflict');assert.equal(conflict.normalized,null);assert.equal(conflict.evidence.length,4);
});
test('bounded API reads inspect registered and guest customer records without exposing values',async()=>{
  const calls=[];
  const r=await sampleMetorik({key:'private-key',fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options});
    return new Response(JSON.stringify({data:[{metorik_customer_id:900,customer_id:0,email:'private@fixture.example'},
      {metorik_customer_id:901,customer_id:5,billing:{email:null}}],pagination:{has_more_pages:false}}));
  }});
  assert.equal(calls.length,2);assert.equal(r.samples[0].counts.woo_guest,1);assert.equal(r.samples[0].counts.woo_id_present,1);
  assert.equal(r.samples[0].counts.ids_different,2);
  assert.doesNotMatch(JSON.stringify(r),/private@|private-key|900/);
  assert.ok(calls.every(c=>!c.url.includes('fields')&&c.options.redirect==='error'));
});
test('request failures and omitted fields stay distinct from explicit nulls',async()=>{
  const r=await sampleMetorik({key:'key',fetchImpl:async()=>{throw Error('secret provider error');}});
  assert.equal(r.requests,2);assert.equal(r.bytes,0);assert.doesNotMatch(JSON.stringify(r),/secret provider/);
  const summary=summarizeRecords([{customer_id:0,email:null},{customer_id:0}],'customers');
  assert.equal(summary.email_fields['woo_guest/email/null'],1);assert.equal(summary.email_fields['woo_guest/email/omitted'],1);
});
test('schema and retained raw sampling are read-only, bounded, and aggregate-only',async()=>{
  const queries=[];
  const result=await diagnose({project:'fixture',env:{},bigquery:{query:async o=>{
    queries.push(o);
    return [o.query.includes('INFORMATION_SCHEMA')?[{table_name:'orders',column_name:'raw_json',data_type:'STRING'}]:[{payload:JSON.stringify({order_id:1,customer_id:0,raw_json:JSON.stringify({billing:{email:'secret@fixture.example'}})})}]];
  }}});
  assert.equal(queries.length,10);assert.ok(queries.every(q=>q.maximumBytesBilled==='1000000000'&&q.jobTimeoutMs<=20000));
  assert.equal(result.warehouse.metorik_us.samples.orders.raw.email_fields['woo_id_omitted_or_null/billing.email/usable'],1);
  assert.doesNotMatch(JSON.stringify(result),/secret@/);
  assert.throws(()=>discoverySql('bad`project','metorik_us'));
});
