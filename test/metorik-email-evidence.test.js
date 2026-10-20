import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
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
      {metorik_customer_id:901,customer_id:5,billing:{email:null}}],pagination:{current_page:1,per_page:10,has_more_pages:false}}));
  }});
  assert.equal(calls.length,2);assert.equal(r.samples[0].counts.woo_guest,1);assert.equal(r.samples[0].counts.woo_id_present,1);
  assert.equal(r.samples[0].counts.ids_different,2);
  assert.doesNotMatch(JSON.stringify(r),/private@|private-key|900/);
  assert.ok(calls.every(c=>!c.url.includes('fields')&&c.options.redirect==='error'));
});

test('probe matches the actual production bearer request and response envelope contracts',async()=>{
  const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const production=section('function getMetorikResponseRecords(', 'function getMetorikErrorFields(')+
    section('function getMetorikPagination(', 'function metorikRetryDelay(')+
    section('async function requestMetorikResource(', 'async function discoverMetorikResource(');
  for(const envelope of ['array','data','resource'])for(const meta of ['pagination','meta','links']){
    const calls=[];
    const fetchImpl=async(url,options)=>{
      calls.push({url:new URL(url),headers:options.headers});
      const resource=new URL(url).pathname.split('/').at(-1),records=[{metorik_customer_id:9,customer_id:0,email:'usable@fixture.example'}];
      return new Response(JSON.stringify(envelope==='array'?records:{[envelope==='data'?'data':resource]:records,[meta]:{current_page:1,per_page:10,has_more_pages:false}}));
    };
    const context=vm.createContext({URL,fetch:fetchImpl,console,METORIK_API_BASE_URL:'https://app.metorik.com/api/v1/store/',METORIK_DISCOVERY_PER_PAGE:'10',getMetorikErrorFields:()=>null,sanitizeMetorikValue:v=>v});
    vm.runInContext(production,context);
    const actual=await context.requestMetorikResource('customers',{apiKey:'fixture-token',storeName:'UK'},{page:'1',per_page:'10'},{includeDiscoveryDateRange:false,retryCount:0});
    const probe=await sampleMetorik({key:'fixture-token',fetchImpl});
    assert.equal(actual.recordsShapeValid,true);assert.equal(actual.records.length,probe.samples[0].records);
    assert.ok(calls.every(c=>c.headers.Authorization==='Bearer fixture-token'&&c.headers.Accept==='application/json'));
    assert.ok(calls.every(c=>c.url.origin==='https://app.metorik.com'&&c.url.searchParams.get('per_page')==='10'&&!c.url.searchParams.has('start_date')));
    assert.equal(probe.requests,2);
  }
});
test('request failures and omitted fields stay distinct from explicit nulls',async()=>{
  const r=await sampleMetorik({key:'key',fetchImpl:async()=>{throw Error('secret provider error');}});
  assert.equal(r.requests,2);assert.equal(r.bytes,0);assert.doesNotMatch(JSON.stringify(r),/secret provider/);
  const summary=summarizeRecords([{customer_id:0,email:null},{customer_id:0}],'customers');
  assert.equal(summary.email_fields['woo_guest/email/null'],1);assert.equal(summary.email_fields['woo_guest/email/omitted'],1);
});

test('probe respects terminal meta/links pages and rejects inconsistent pagination',async()=>{
  for(const alias of ['pagination','meta','links']){
    const terminal=await sampleMetorik({key:'key',fetchImpl:async()=>new Response(JSON.stringify({data:Array.from({length:10},()=>({customer_id:0})),[alias]:{current_page:1,per_page:10,has_more_pages:false}}))});
    assert.equal(terminal.requests,2);
    const invalid=await sampleMetorik({key:'key',fetchImpl:async()=>new Response(JSON.stringify({data:[],[alias]:{current_page:2,per_page:10,has_more_pages:false}}))});
    assert.ok(invalid.samples.every(s=>s.status==='unavailable_or_invalid_response'));
  }
});

test('WW and USD use the existing production environment key mapping',async()=>{
  const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(source,/UK: Object.freeze\(\{\s*storeName: 'UK',\s*apiKey: METORIK_UK_API_KEY/);
  assert.match(source,/US: Object.freeze\(\{\s*storeName: 'US',\s*apiKey: METORIK_US_API_KEY/);
  const headers=[];
  await diagnose({project:'fixture',env:{METORIK_UK_API_KEY:'ww-fixture',METORIK_US_API_KEY:'usd-fixture'},bigquery:{query:async()=>[[]]},fetchImpl:async(url,options)=>{
    headers.push(options.headers.Authorization);return new Response(JSON.stringify([]));
  }});
  assert.deepEqual(headers,['Bearer ww-fixture','Bearer ww-fixture','Bearer usd-fixture','Bearer usd-fixture']);
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
