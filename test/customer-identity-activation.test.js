import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cohortRelations} from '../oracle/cohort-execution.js';
import {customerJourneySql,createCustomerJourneyService} from '../oracle/customer-journey.js';
import {customerEvidenceSql,createCustomerQueryService} from '../oracle/customer-query.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {linkageSql} from '../customer-identity/linkage.js';
import {identityRow,SCOPE} from '../customer-identity/collect.js';
import {preflight,enrich,publish,verificationSql} from '../customer-identity/operations.js';
import {identityConfiguration} from '../oracle/customer-identity.js';

const config={dataset:'customer_identity',snapshot:'review-20261020',mode:'email_candidate_v1'};
const env={ORACLE_CUSTOMER_IDENTITY_MODE:config.mode,ORACLE_CUSTOMER_IDENTITY_DATASET:config.dataset,ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:config.snapshot};
const ref=`c_${'a'.repeat(64)}`;
const coverage=['ww','usd','shopify'].map(source_store=>({source_store,identified_profiles:3,mapped_profiles:1,unmatched_profiles:2,qualifying_orders:4}));
const ready={state:'ready',start_date:SCOPE.start,end_date:SCOPE.end,mapping_count:2};
const now='2026-10-20T00:00:00Z';
const o={source:'ww',start:SCOPE.start,end:SCOPE.end,dataset:config.dataset,maxOrders:60000};
function sqlite(sql,tables) {
  const script=`import json,sys,sqlite3,re,hashlib
p=json.load(sys.stdin); c=sqlite3.connect(':memory:');c.row_factory=sqlite3.Row
c.create_function('CONCAT',-1,lambda *x: ''.join(str(v) for v in x))
c.create_function('SHA256',1,lambda x: hashlib.sha256(x.encode()).digest())
c.create_function('TO_HEX',1,lambda x: x.hex().upper())
for name,data in p['tables'].items():
 c.execute('CREATE TABLE '+name+'('+','.join(data['columns'])+')')
 c.executemany('INSERT INTO '+name+' VALUES('+','.join('?' for _ in data['columns'])+')',data['rows'])
q=p['sql'].replace('UNION DISTINCT','UNION')
print(json.dumps([dict(r) for r in c.execute(q,{'observation_end':'2026-10-19','time_zone':'UTC','first_order_semantic':'first_observed_ever','cohort_entry_start':'2024-01-01','cohort_entry_end':'2026-10-19','entry_source':None,'entry_channel':None})]))`;
  const r=spawnSync('python3',['-c',script],{input:JSON.stringify({sql,tables}),encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr||r.error?.message);
  return JSON.parse(r.stdout);
}
test('real linkage SQL globally excludes shared addresses, profile conflicts, and preserves namespaces',()=>{
  const make=(source,id,mail)=>identityRow(source,{id,customer_id:id,billing:{email:mail},...(source==='shopify'?{email:mail,customer:{id}}:{})},{email:mail},now);
  const input=[make('ww','1','one@fixture.example'),make('shopify','1','one@fixture.example'),
    make('usd','1','two@fixture.example'),make('shopify','2','two@fixture.example'),
    make('ww','2','shared@fixture.example'),make('ww','3','shared@fixture.example'),make('shopify','3','shared@fixture.example'),
    make('ww','4','before@fixture.example'),make('ww','4','after@fixture.example'),make('shopify','4','before@fixture.example'),
    make('usd','8','before@fixture.example'),make('shopify','8','before@fixture.example')];
  const parsed=cohortRelations(linkageSql('fixture','customer_identity'));
  parsed.relations[0].body=`SELECT source,customer_id,order_email_normalized email FROM fixture_identity WHERE customer_id IS NOT NULL AND order_email_normalized IS NOT NULL UNION ALL SELECT source,customer_id,customer_email_normalized FROM fixture_identity WHERE customer_id IS NOT NULL AND customer_email_normalized IS NOT NULL`;
  const sql=`WITH ${parsed.relations.map(r=>`${r.name} AS (${r.body})`).join(',')} ${parsed.result}`;
  const rows=sqlite(sql,{fixture_identity:{columns:['source','customer_id','order_email_normalized','customer_email_normalized'],rows:input.map(r=>[r.source,r.customer_id,r.order_email_normalized,r.customer_email_normalized])}});
  assert.deepEqual(rows.map(r=>[r.woo_source,r.woo_customer_id,r.shopify_customer_id]).sort(),[['usd','1','2'],['ww','1','1']]);
});
const orderColumns=['source_platform','source_store','channel','order_ref','source_customer_id','order_timestamp','status','currency','order_total','refunds','migrated','cancelled','customer_record_present','persisted_guest'];
const fixtureOrder=(store,id,cid,date,patch={})=>({source_platform:store==='shopify'?'shopify':'woo',source_store:store,channel:'Online',order_ref:id,source_customer_id:cid,order_timestamp:date,status:store==='shopify'?'paid':'completed',currency:store==='usd'?'USD':'GBP',order_total:100,refunds:0,migrated:0,cancelled:0,customer_record_present:1,persisted_guest:0,...patch});
function executeSequence(orders,active,entries=false) {
  const parsed=cohortRelations(customerJourneySql('fixture','summary',null,null,active?config:null));
  const names=['orders','qualifying_orders','ranked_orders',...(entries?['entry_orders']:[])];
  let relations=parsed.relations.filter(r=>names.includes(r.name));
  for(const r of relations) {
    if(r.name==='orders') {
      const rank=r.body.slice(r.body.indexOf('ROW_NUMBER()')).replace(/=1\s*$/,'');
      r.body=`SELECT ${orderColumns.join(',')} FROM (SELECT raw_orders.*,${rank} fixture_rank FROM raw_orders) WHERE fixture_rank=1`;
    }
    r.body=r.body.replace('DATE(order_timestamp,@time_zone)','DATE(order_timestamp)').replaceAll('DATE(order_timestamp,@time_zone)','DATE(order_timestamp)');
    if(active&&r.name==='qualifying_orders')r.body=r.body.replace('q.* REPLACE(COALESCE(m.canonical_customer_ref,q.governed_customer_ref) AS governed_customer_ref)',`${orderColumns.map(c=>`q.${c}`).join(',')},COALESCE(m.canonical_customer_ref,q.governed_customer_ref) governed_customer_ref`);
  }
  const sql=`WITH ${active?'ci_mapping AS (SELECT * FROM fixture_mapping),':''}${relations.map(r=>`${r.name} AS (${r.body})`).join(',')} SELECT source_store,order_ref,governed_customer_ref,order_sequence FROM ${entries?'entry_orders':'ranked_orders'} ORDER BY source_store,order_ref`;
  return sqlite(sql,{raw_orders:{columns:orderColumns,rows:orders.map(r=>orderColumns.map(c=>r[c]))},fixture_mapping:{columns:['source_store','source_customer_id','canonical_customer_ref'],rows:[['ww','1',ref],['usd','1',ref],['shopify','gid://shopify/Customer/1',ref]]}});
}
test('production qualifying/dedup/sequence SQL counts Woo → Shopify repeats once, preserves refunds/guests/import exclusions and unmatched fallback',()=>{
  const first=fixtureOrder('ww','7','1','2024-01-01T00:00:00Z');
  const orders=[first,{...first},fixtureOrder('usd','7','1','2024-02-01T00:00:00Z'),
    fixtureOrder('shopify','gid://shopify/Order/7','gid://shopify/Customer/1','2025-12-01T00:00:00Z'),
    fixtureOrder('shopify','import','gid://shopify/Customer/1','2024-01-01T00:00:00Z',{migrated:1}),
    fixtureOrder('shopify','cancel','gid://shopify/Customer/1','2025-11-25T00:00:00Z',{cancelled:1}),
    fixtureOrder('ww','refunded','1','2024-03-01T00:00:00Z',{refunds:100}),
    fixtureOrder('ww','guest',null,'2024-03-01T00:00:00Z'),fixtureOrder('ww','unmatched','55','2024-05-01T00:00:00Z')];
  const local=executeSequence(orders,false),linked=executeSequence(orders,true);
  assert.equal(linked.length,4);assert.equal(local.length,4);
  assert.deepEqual(linked.filter(r=>r.governed_customer_ref===ref).map(r=>r.order_sequence).sort(),[1,2,3]);
  assert.equal(local.find(r=>r.source_store==='shopify').order_sequence,1);
  assert.equal(linked.find(r=>r.source_store==='shopify').order_sequence,3);
  assert.equal(linked.find(r=>r.order_ref==='unmatched').governed_customer_ref,local.find(r=>r.order_ref==='unmatched').governed_customer_ref);
  const localEntries=executeSequence(orders,false,true),linkedEntries=executeSequence(orders,true,true);
  assert.equal(localEntries.length,4);assert.equal(linkedEntries.length,2);
  assert.equal(linkedEntries.find(r=>r.governed_customer_ref===ref).source_store,'ww');
  assert.equal(linkedEntries.some(r=>r.source_store==='shopify'),false);
});
test('active source-filtered journeys retain all follow-up histories and filter the first observed entry source',()=>{
  const sql=customerJourneySql('fixture','retention_windows','woo','ww',config);
  assert.match(sql,/shopify_data.order_locations/);assert.match(sql,/metorik_us.orders/);
  assert.match(sql,/WHERE source_store='ww' AND order_sequence=1/);
  const ctes=cohortRelations(sql).relations;
  assert.match(ctes.find(r=>r.name==='qualifying_orders').body,/LEFT JOIN ci_mapping/);
  assert.doesNotMatch(ctes.find(r=>r.name==='orders').body,/ci_mapping/);
});
test('same activation control reaches shared history, summary, timing, cohort and durable provider composition',async()=>{
  const calls=[];
  const bigquery={query:async q=>{
    calls.push(q);
    if(q.query.includes('identity_snapshots'))return [[ready]];
    if(q.query.includes('unmatched_profiles'))return [coverage];
    return [[{cohort_customers:1,returning_customers:1,repeat_rate_percentage:100}]];
  }};
  const service=createCustomerQueryService({bigquery,project:'fixture',env});
  for(const [method,args] of [
    ['getCustomerHistory',{customer_ref:ref}],['getCustomerSummary',{customer_ref:ref}],
    ['getCustomerCohort',{cohort_start:'2024-01-01',cohort_end:'2024-12-31',return_start:'2025-01-01',return_end:'2026-10-19'}],
    ['getFirstToSecondPurchaseTiming',{start_date:'2024-01-01',end_date:'2026-10-19'}],
  ]) {
    const result=await service[method](args);
    assert.equal(result.identity_evidence.activation,'active');
    assert.equal(result.identity_evidence.sources[0].unmatched_profiles,2);
    assert.match(calls.at(-1).query,/LEFT JOIN ci_mapping/);
  }
  assert.match(calls.find(q=>q.labels?.operation==='customer_history').query,/ci_aliases WHERE local_ref=@customer_ref/);
  const deps=createOracleProviderDependencies({bigquery,project:'fixture',env});
  const journey=await deps.customerJourney.analyzeCustomerJourney({start_date:'2024-01-01',end_date:'2026-10-19',group_by:['summary']});
  assert.equal(journey.identity_evidence.snapshot,config.snapshot);
  assert.equal(calls.at(-1).params.coverage_status,'unverified');
});
test('off switch has no identity reads; unreadable/unready snapshots fall back visibly without leaking errors',async()=>{
  assert.equal(identityConfiguration({}),null);
  for(const scenario of ['disabled','denied','unready']) {
    const calls=[];
    const bigquery={query:async q=>{calls.push(q);if(q.query.includes('identity_snapshots')){if(scenario==='denied')throw Error('private customer body');return [[{...ready,state:'pending'}]];}return [[]];}};
    const result=await createCustomerQueryService({bigquery,project:'fixture',env:scenario==='disabled'?{}:env}).getCustomerHistory({customer_ref:ref});
    assert.equal(calls.at(-1).query.includes('identity_links'),false);
    if(scenario==='disabled'){assert.equal(calls.length,1);assert.equal(result.identity_evidence,undefined);}
    else assert.equal(result.identity_evidence.activation,'fallback');
    assert.doesNotMatch(JSON.stringify(result),/private customer body/);
  }
});
test('preflight is bounded and read-only, emits counts and permission flags only',async()=>{
  const queries=[];
  const table={exists:async()=>[true],getMetadata:async()=>[{schema:{fields:[]}}],testIamPermissions:async()=>[{permissions:[]}]};
  const bigquery={dataset:()=>({exists:async()=>[true],getMetadata:async()=>[{location:'EU',access:[]}],table:()=>table}),query:async q=>{queries.push(q);return [[{order_id:'1'},{order_id:'2'}]];}};
  const result=await preflight({bigquery,project:'fixture',o,client:async()=>({woo:async path=>path.startsWith('orders')?{id:Number(path.split('/')[1]),customer_id:2,billing:{email:'one@fixture.example'}}:{id:2,email:'one@fixture.example'}})});
  assert.equal(result.selected_orders,2);assert.equal(result.usable_order_emails,2);assert.equal(result.destination.ready,false);
  assert.doesNotMatch(JSON.stringify(result),/one@|"order_id":|"customer_id":/);
  assert.equal(queries.length,1);assert.equal(queries[0].maximumBytesBilled,SCOPE.bytes);assert.doesNotMatch(queries[0].query,/\b(MERGE|INSERT|UPDATE|CREATE|ALTER|DELETE)\b/);
});
test('verification rejects partial coverage, and publication cannot proceed without complete three-source evidence',async()=>{
  let writes=0;
  const bigquery={query:async q=>{if(/BEGIN TRANSACTION|INSERT/.test(q.query))writes++;return [[{selected_orders:10,enriched_orders:9,missing_orders:1,duplicate_identity_rows:0}]];}};
  await assert.rejects(publish({bigquery,project:'fixture',dataset:config.dataset,snapshot:config.snapshot}));
  assert.equal(writes,0);assert.match(verificationSql('fixture',o),/missing_orders/);
});

test('request and response byte caps stop source reads without exposing payloads',async()=>{
  const {boundedFetch,requestBudget}=await import('../customer-identity/runtime.js');
  const budget={...requestBudget('ww'),maxRequests:1,maxBytes:4};
  const transport=boundedFetch(budget,async()=>new Response('{"secret":"private fixture"}'));
  const response=await transport('https://fixture.example');
  await assert.rejects(response.json(),/byte cap/);
  await assert.rejects(transport('https://fixture.example'),/request cap/);
});
test('failed enrichment writes a failure marker, so partial persisted batches cannot activate',async()=>{
  const {TABLES}=await import('../customer-identity/operations.js');
  const writes=[];
  const bigquery={dataset:()=>({exists:async()=>[true],getMetadata:async()=>[{location:'EU',access:[]}],table:name=>({exists:async()=>[true],getMetadata:async()=>[{schema:{fields:TABLES[name]}}],testIamPermissions:async()=>[{permissions:['bigquery.tables.getData','bigquery.tables.updateData']}]})}),query:async q=>{
    if(q.query.includes('SELECT DISTINCT CAST(order_id'))return [[{order_id:'1'}]];
    writes.push(q);return [[]];
  }};
  await assert.rejects(enrich({bigquery,project:'fixture',o,client:async()=>({woo:async()=>{throw Error('private fixture body')}})}));
  assert.equal(writes.length,2);assert.match(writes[0].query,/'running'/);assert.match(writes[1].query,/status='failed'/);
  assert.equal(writes[1].params.returned,0);assert.doesNotMatch(JSON.stringify(writes),/private fixture/);
});
test('historical API batches stay below the cap and malformed activation settings remain source-local',async()=>{
  assert.equal(SCOPE.batchSize,100);
  const result=await createCustomerQueryService({project:'fixture',env:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v1'},bigquery:{query:async q=>{assert.doesNotMatch(q.query,/identity_links/);return [[]];}}}).getCustomerHistory({customer_ref:ref});
  assert.equal(result.identity_evidence.reason,'invalid_activation_configuration');
});
test('destination readiness accepts BigQuery canonical INTEGER metadata for INT64 schemas',async()=>{
  const {TABLES,destinationReadiness}=await import('../customer-identity/operations.js');
  const bigquery={dataset:()=>({exists:async()=>[true],getMetadata:async()=>[{location:'EU',access:[]}],table:name=>({exists:async()=>[true],getMetadata:async()=>[{schema:{fields:TABLES[name].map(f=>({...f,type:f.type==='INT64'?'INTEGER':f.type}))}}],testIamPermissions:async()=>[{permissions:['bigquery.tables.getData','bigquery.tables.updateData']}]})})};
  const result=await destinationReadiness(bigquery,'fixture','customer_identity');assert.equal(result.ready,true);
});
