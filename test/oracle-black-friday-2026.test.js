import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {createHistoricalEventDependencies} from '../oracle/historical-event-provider.js';
import {createShopifyCountryConversionReader} from '../oracle/shopify-country-conversion.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {MATRIXIFY_APP_ID} from '../finance/canonical.js';

const fixtureText = name => readFileSync(new URL('./fixtures/black-friday-2026/'+name+'.txt',import.meta.url),'utf8').trimEnd();
const save = fixtureText('save-only'), report = fixtureText('report'), failed = fixtureText('before-answer');
const now = Date.parse('2026-11-09T12:00:00Z');
const stamp = '2026-11-09T10:00:00Z';
const orders = [
  ['before', '2026-11-04T23:59:59Z', 'online', 'GBP', 999, 9],
  ['vip', '2026-11-05T00:00:00Z', 'online', 'GBP', 20, 2],
  ['vip-pos', '2026-11-05T23:59:59Z', 'instore', 'GBP', 30, 3],
  ['public-start', '2026-11-06T00:00:00Z', 'online', 'GBP', 60, 1],
  ['public-us', '2026-11-07T02:00:00Z', 'online', 'USD', 70, 2],
  ['public-end', '2026-11-08T23:59:59Z', 'instore', 'GBP', 80, 4],
  ['end', '2026-11-09T00:00:00Z', 'instore', 'GBP', 999, 9],
  ['import-online', '2026-11-05T08:00:00Z', 'online', 'GBP', 999, 9, MATRIXIFY_APP_ID],
  ['import-pos', '2026-11-06T08:00:00Z', 'instore', 'GBP', 999, 9, MATRIXIFY_APP_ID],
  ['unknown', '2026-11-07T08:00:00Z', 'unknown', 'GBP', 999, 9],
  ['prior-online', '2025-11-27T00:00:00Z', 'online', 'GBP', 50, 5],
  ['prior-pos', '2025-11-27T01:00:00Z', 'instore', 'GBP', 999, 9],
  ['may-pos', '2026-04-30T23:00:00Z', 'instore', 'GBP', 40, 4],
  ['may-online', '2026-05-02T02:00:00Z', 'online', 'GBP', 999, 9]
];
const refunds = [
  ['vip-refund', 'vip', '2026-11-05T23:59:59Z', 2],
  ['phase-edge', 'vip', '2026-11-06T00:00:00Z', 3],
  ['pos-refund', 'vip-pos', '2026-11-08T10:00:00Z', 4],
  ['outside', 'public-end', '2026-11-09T00:00:00Z', 999],
  ['imported', 'import-pos', '2026-11-07T04:00:00Z', 999],
  ['prior-refund', 'prior-online', '2025-11-30T20:00:00Z', 5],
  ['may-refund', 'may-pos', '2026-05-04T22:59:59Z', 4]
];
const python = process.env.ORACLE_SQL_PYTHON || 'python3';
const sqlAvailable = spawnSync(python,['-c','import duckdb,sqlglot']).status===0;
function queryRows(query, useSql) {
  const {params:p} = query;
  const daily = /DATE\((?:f.created_at|r.refund_created_at), 'Europe\/London'\) date/.test(query.query);
  const products = query.query.includes(' namespace'), refund = query.query.includes("'refund' transaction_type");
  if(useSql) {
    const result = spawnSync(python,[new URL('./shopify-sale-window-sql.py',import.meta.url).pathname],{
      input:JSON.stringify({...query,
        order_financials:orders.map(([id,date,,currency,amount])=>[id,date,stamp,null,currency,amount,'[{"status":"SUCCESS","kind":"SALE"}]']),
        order_locations:orders.map(([id,,channel,,,,app])=>[id,stamp,channel==='instore'?'fixture-pos':null,channel==='online'?'Online Store':channel,app||null]),
        order_line_items:orders.map(([id,,,currency,amount,units])=>[id,'line',stamp,id,'Ring '+id,units,amount,currency]),
        order_refunds:refunds.map(([id,order,date,amount])=>[id,order,stamp,orders.find(o=>o[0]===order)[3],amount,true,date])
      }),encoding:'utf8'});
    if(result.status!==0)console.error(result.stderr);
    assert.equal(result.status,0,result.stderr);
    return JSON.parse(result.stdout);
  }
  const within = date => date>=p.start_at && date<p.end_exclusive;
  const selected = orders.filter(o=>o[2]===p.sale_channel && !o[6]);
  const grouped = new Map();
  const dateOf = date => new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date(date));
  if(products) return selected.filter(o=>within(o[1])).map(([id,date,channel,currency,sales,units])=>
    ({namespace:'shopify:shopify',product_id:id,title:'Ring '+id,channel,currency,sales,units,...(daily?{date:dateOf(date)}:{})}));
  const transactions = refund ? refunds.filter(r=>selected.some(o=>o[0]===r[1])).map(([,id,date,amount])=>[date,selected.find(o=>o[0]===id)[3],-amount])
    : selected.map(([,date,,currency,amount])=>[date,currency,amount]);
  for (const [time,currency,amount] of transactions.filter(([date])=>within(date))) {
    const date=dateOf(time),key=JSON.stringify([currency,daily?date:null]);
    const row=grouped.get(key)||{channel:p.sale_channel,source:p.sale_channel==='online'?'Shopify Online Store':'Shopify POS',
      currency,transaction_type:refund?'refund':'sale',amount:0,...(daily?{date}:{}),[refund?'refund_events':'transaction_count']:0};
    row.amount+=amount;
    row[refund?'refund_events':'transaction_count']++;
    grouped.set(key,row);
  }
  return [...grouped.values()];
}

function setup({failure, sessionFailure, useSql=false}={}) {
  const queries=[],proposals=[],attempts=[],knowledge=[],sessionQueries=[];
  const bigquery={
    dataset:()=>({getMetadata:async()=>[{location:'US'}]}),
    query:async q=>{
      queries.push(q);
      if(q.query.includes('governed_active'))return [[]];
      if(failure==='pos-refunds' && q.params.sale_channel==='instore' && q.query.includes('order_refunds'))throw Error('fixture');
      if(failure==='pos-sales' && q.params.sale_channel==='instore' && q.query.includes("'sale' transaction_type"))throw Error('fixture');
      if(failure==='public-products' && q.params.start_at==='2026-11-06T00:00:00Z' && q.query.includes('order_line_items'))throw Error('fixture');
      return [queryRows(q,useSql)];
    }
  };
  const onlineSessions=createShopifyCountryConversionReader({now:()=>new Date(now),graphql:async (query,vars)=>{
    sessionQueries.push({query,vars});
    if(!vars.query)return {shop:{id:'fixture',ianaTimezone:sessionFailure==='timezone'?'America/New_York':'Europe/London'},currentAppInstallation:{accessScopes:[{handle:'read_reports'}]}};
    const rows=[5,6,7,8].map((day,i)=>({day:'2026-11-0'+day,sessions:100*(i+1),sessions_that_completed_checkout:i+1}));
    if(sessionFailure==='invalid')rows[0].sessions_that_completed_checkout=101;
    if(sessionFailure==='partial')rows.splice(2,1);
    return {shopifyqlQuery:{tableData:{columns:Object.keys(rows[0]).map(name=>({name})),rows}}};
  }});
  const deps=createHistoricalEventDependencies({bigquery,project:'fixture',knowledgeService:{searchKnowledge:async params=>{knowledge.push(params);return {items:[]};}},now:()=>now,onlineSessions});
  const baseline=createOracleBaselineDispatcher({historicalEventComparison:async (...args)=>{attempts.push('event');return deps.historicalEventComparison(...args);}});
  return {baseline,queries,attempts,knowledge,proposals,sessionQueries,generateProposals:async ({message})=>{
    proposals.push(message);
    return failure==='proposal' ? [] : [{
      kind:'event',title:'The Great Frog — Black Friday 2026 sale windows',event_type:'sale',
      description:save.split('\n\n').slice(2,-1).join('\n\n'),status:'working',
      date_precision:'day',effective_from:'2026-11-05',effective_to:'2026-11-08',
      source_type:'human_entered',source_reference:'Submitted sale windows',tags:['black-friday']
    }];
  }};
}

for (const durable of [false,true]) test('verbatim save-only request opens a review in '+(durable?'durable':'interactive')+' chat',async t=>{
  const f=setup(),h=await acceptanceServer(f,{durable,now});t.after(h.close);
  const r=await h.submit(save,{fresh:true});
  assert.deepEqual(f.proposals,[save]);assert.deepEqual(f.attempts,[]);assert.deepEqual(f.queries,[]);assert.deepEqual(f.sessionQueries,[]);
  assert.equal(r.evidence,null);assert.deepEqual(r.tools||[],[]);
  assert.equal(r.proposals.length,1);assert.equal(r.proposals[0].validity,'valid',JSON.stringify(r.proposals));
  assert.equal(r.proposals[0].persisted,false);assert.equal(r.proposals[0].approval_required,true);
  assert.match(r.proposals[0].proposal.description,/exact VIP opening hour was not supplied/);
  assert.match(failed,/Requested 2026 instore source shopify has no approved historical binding/);
  assert.doesNotMatch(r.answer,/^# Black Friday sale periods|no approved historical binding/);
  assert.match(r.answer,/Review the proposed knowledge entry/);
});
test('save-only proposal failure is explicit and does not execute analytics',async t=>{
  const f=setup({failure:'proposal'}),h=await acceptanceServer(f,{now});t.after(h.close);
  const r=await h.submit(save,{fresh:true});
  assert.match(r.answer,/could not prepare/);assert.deepEqual(r.proposals,[]);assert.deepEqual(f.attempts,[]);
});
for (const durable of [false,true]) test('explicit phased report through '+(durable?'durable':'interactive')+' chat retains exact scope without knowledge',async t=>{
  const f=setup(),h=await acceptanceServer(f,{durable,now});t.after(h.close);
  const r=await h.submit(report,{fresh:true});
  assertEvidenceAgreement(r.analysis_context,r.evidence);
  assert.deepEqual(f.knowledge,[]);assert.deepEqual(f.proposals,[]);assert.deepEqual(f.attempts,['event']);
  assert.deepEqual(r.evidence.sections.map(({window:w})=>[w.period_id,w.channel,w.start_at,w.end_exclusive]),[
    ['vip','online','2026-11-05T00:00:00Z','2026-11-06T00:00:00Z'],
    ['vip','instore','2026-11-05T00:00:00Z','2026-11-06T00:00:00Z'],
    ['public','online','2026-11-06T00:00:00Z','2026-11-09T00:00:00Z'],
    ['public','instore','2026-11-06T00:00:00Z','2026-11-09T00:00:00Z'],
    ['full-sale','online','2026-11-05T00:00:00Z','2026-11-09T00:00:00Z'],
    ['full-sale','instore','2026-11-05T00:00:00Z','2026-11-09T00:00:00Z'],
    ['black-friday-online','online','2025-11-27T00:00:00Z','2025-12-01T00:00:00Z'],
    ['may-bank-holiday-pos','instore','2026-04-30T23:00:00Z','2026-05-04T23:00:00Z']
  ]);
  for(const q of f.queries.filter(q=>q.params.sale_channel)){
    assert.equal(q.params.matrixify_app_id,MATRIXIFY_APP_ID);
    assert.match(q.query,/source_app_id!=@matrixify_app_id/);
    assert.match(q.query,/< TIMESTAMP\(@end_exclusive\)/);
    assert.doesNotMatch(q.query,/metorik_|square_data/);
  }
  assert.match(r.answer,/exact VIP opening hour is unknown/);
  assert.match(r.answer,/\| 2026-11-05 \| GBP \| 20 \| -2 \| 18 \| 1 \| 2 \| 20 \|/);
  assert.match(r.answer,/\| 2026-11-06 \| GBP \| 60 \| -3 \| 57 \| 1 \| 1 \| 60 \|/);
  assert.match(r.answer,/\| 2026-11-07 \| USD \| 70 \| Unavailable \| Unavailable \| 1 \| 2 \| 70 \|/);
  assert.match(r.answer,/\| 2026-11-08 \| GBP \| 80 \| -4 \| 76 \| 1 \| 4 \| 80 \|/);
  assert.match(r.answer,/\| GBP \| 80 \| -5 \| 75 \| 2 \| 3 \| 40 \|/);
  assert.match(r.answer,/\| GBP \| Sales after refunds \| 75 \| 45 \|/);
  assert.match(r.answer,/\| GBP \| Sales after refunds \| 106 \| 36 \|/);
  assert.match(r.answer,/\| Window total \| 1,000 \| 10 \| 1.00% \|/);
  assert.match(r.answer,/Ring public-end/);
  assert.doesNotMatch(r.answer,/999|no approved historical binding/);
  assert.equal(f.sessionQueries.length,2);
});
for(const options of [{failure:'pos-refunds'},{failure:'pos-sales'},{failure:'public-products'},{sessionFailure:'invalid'},{sessionFailure:'timezone'},{sessionFailure:'partial'}])
  test('retains independent sections when '+JSON.stringify(options),async t=>{
    const f=setup(options),h=await acceptanceServer(f,{now});t.after(h.close);
    const r=await h.submit(report,{fresh:true});
    assert.match(r.answer,/\| GBP \| 80 \| -5 \| 75 \| 2 \| 3 \| 40 \|/);
    assert.match(r.answer,/May Bank Holiday 2026/);
    if(options.failure==='pos-refunds')assert.match(r.answer,/\| 2026-11-08 \| GBP \| 80 \| Unavailable \| Unavailable \| 1 \| 4 \| 80 \|/);
    if(options.failure==='pos-sales')assert.match(r.answer,/\| 2026-11-08 \| GBP \| Unavailable \| -4 \| Unavailable \| Unavailable \| 4 \| Unavailable \|/);
    if(options.failure==='public-products')assert.match(r.answer,/\| 2026-11-06 \| GBP \| 60 \| -3 \| 57 \| 1 \| Unavailable \| 60 \|/);
    if(['invalid','timezone'].includes(options.sessionFailure))assert.match(r.answer,/Online sessions and conversion unavailable/);
    if(options.sessionFailure==='partial'){
      assert.match(r.answer,/\| 2026-11-06 \| 200 \| 2 \| 1.00% \|/);
      assert.match(r.answer,/\| Window total \| Unavailable \| Unavailable \| Unavailable \|/);
      assert.doesNotMatch(r.answer,/\| Window total \| 700/);
    }
  });
test('phased report validates retained component, currency-day and session scope',async ()=>{
  const f=setup(),context=transitionAnalysisContext(null,report,{now}).context;
  const result=await f.baseline(report,{analysisContext:context});
  for (const mutate of [
    e=>e.sections[0].products.evidence.components[0].rows[0].date='2026-11-06',
    e=>e.sections[0].products.evidence.components[0].rows[0].channel='instore',
    e=>e.sections[0].daily.evidence.rows[0].source='WooCommerce ww',
    e=>e.online_sessions.source.partitions[0].rows[0].numerator=123,
    e=>e.requested_scope.sale_scope.periods[2].end_exclusive='2026-11-10T00:00:00Z'
  ]) {
    const copy=structuredClone(result.evidence);mutate(copy);
    assert.throws(()=>assertEvidenceAgreement(context,copy),{code:'EVIDENCE_SCOPE_MISMATCH'});
  }
});
test('generated Shopify finance and product SQL executes at phase boundaries',{skip:!sqlAvailable},async ()=>{
  const f=setup({useSql:true}), context=transitionAnalysisContext(null,report,{now}).context;
  const result=await f.baseline(report,{analysisContext:context});
  assertEvidenceAgreement(context,result.evidence);
  assert.match(result.answer,/\| 2026-11-06 \| GBP \| 60 \| -3 \| 57 \| 1 \| 1 \| 60 \|/);
  assert.match(result.answer,/\| GBP \| Sales after refunds \| 106 \| 36 \|/);
});
