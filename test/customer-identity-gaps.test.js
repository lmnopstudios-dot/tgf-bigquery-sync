import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {classifyOrder,fieldState,retainedEmails,shopifyGaps,wooSamples} from '../diagnostics/customer-identity-gaps.js';
import {evidenceMergeSql,identityRow} from '../customer-identity/collect.js';
const o={source:'ww',start:'2022-09-24',end:'2026-10-19'};
test('Shopify distinguishes explicit null customer from omitted fields and unavailable nodes',async()=>{
  assert.equal(classifyOrder({id:'a',customer:null},'a'),'customerless_order');
  assert.equal(classifyOrder({id:'a'},'a'),'extraction_failure');
  assert.equal(classifyOrder(null,'a'),'unavailable_order');
  const ids=[1,2,3,4].map(n=>`gid://shopify/Order/${n}`);
  const result=await shopifyGaps({project:'p',o,bigquery:{query:async()=>[ids.map(order_id=>({order_id}))]},client:async()=>({graphql:async()=>({nodes:[{id:ids[0],customer:null},{id:ids[1],customer:{id:'gid://shopify/Customer/1'}},null,{id:ids[3]}]})})});
  assert.deepEqual(result.counts,{customerless_order:1,attached_customer_missing_row:1,unavailable_order:1,extraction_failure:1,request_failure:0});
  assert.equal(result.complete,false);assert.equal(result.repair_candidate_rows,2);
  assert.doesNotMatch(JSON.stringify(result),/gid:\/\//);
});
test('Woo field availability never treats missing keys or failures as null/redaction',async()=>{
  assert.equal(fieldState({},'email'),'extraction_failure');assert.equal(fieldState({email:null},'email'),'null');
  assert.equal(fieldState({email:'test@example.com'},'email'),'placeholder');
  assert.deepEqual(retainedEmails({raw_json:JSON.stringify({billing:{email:'kept@fixture.example'}})}),['kept@fixture.example']);
  const result=await wooSamples({project:'p',o:{...o,source:'usd'},bigquery:{query:async()=>[[{order_id:'1',quarter:'2023-Q1',warehouse_kind:'registered',retained:JSON.stringify({billing_email:'kept@fixture.example'})}]]},client:async()=>({woo:async path=>{if(path.startsWith('customers'))throw Error('private customer data');return {id:1,customer_id:5,billing:{email:null}};}})});
  assert.equal(result.counts.api_order_null,1);assert.equal(result.counts.customer_unavailable,1);
  assert.equal(result.counts.retain_usable_despite_missing_or_unusable_api,1);
  assert.doesNotMatch(JSON.stringify(result),/kept@|private customer/);
});
test('Woo and Shopify reject overflowing populations before any source requests',async()=>{
  await assert.rejects(shopifyGaps({project:'p',o,bigquery:{query:async()=>[Array(1001).fill({})]},client:()=>assert.fail()}),/cap/);
  await assert.rejects(wooSamples({project:'p',o,bigquery:{query:async()=>[Array(81).fill({})]},client:()=>assert.fail()}),/cap/);
});
test('actual MERGE update expressions preserve Woo pairs, recompute conflict and isolate changed customers',()=>{
  const now='2026-10-20T00:00:00Z';
  const retained=identityRow('ww',{id:1,customer_id:2,billing:{email:'old@fixture.example'}},{email:'old@fixture.example'},now);
  const missing=identityRow('ww',{id:1,customer_id:2,billing:{email:null}},{email:null},now);
  const changed=identityRow('ww',{id:1,customer_id:3,billing:{email:null}},null,now);
  const conflict=identityRow('ww',{id:1,customer_id:2,billing:{email:null}},{email:'new@fixture.example'},now);
  const cases=[[retained,missing],[retained,changed],[retained,conflict],[{...retained,source:'shopify'},{...missing,source:'shopify'}],[retained,missing]];
  const script=`import json,sqlite3,sys,re
p=json.loads(sys.argv[1])
sql=p['sql'].split(' THEN UPDATE SET ')[1].split(' WHEN NOT MATCHED')[0]
parts=[];depth=0;start=0
for i,c in enumerate(sql):
 if c=='(': depth+=1
 if c==')': depth-=1
 if c==',' and depth==0: parts.append(sql[start:i]);start=i+1
parts.append(sql[start:])
expressions=[s.split('=',1) for s in parts]
results=[]
for t,s in p['cases']:
 db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
 for name,row in [('T',t),('S',s)]:
  db.execute('CREATE TABLE '+name+' ('+','.join(row)+')')
  db.execute('INSERT INTO '+name+' VALUES ('+','.join('?' for _ in row)+')',list(row.values()))
 query='SELECT '+','.join(re.sub(r'\\bIF\\(', 'IIF(',expr)+' AS '+key for key,expr in expressions)+' FROM T CROSS JOIN S'
 results.append(dict(db.execute(query).fetchone()))
print(json.dumps(results))`;
  const run=spawnSync('python3',['-c',script,JSON.stringify({sql:evidenceMergeSql('p','d','stage'),cases})],{stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);const rows=JSON.parse(run.stdout);
  assert.equal(rows[0].order_email,'old@fixture.example');assert.equal(rows[0].customer_email_normalized,'old@fixture.example');assert.equal(rows[0].email_state,'candidate');
  assert.equal(rows[1].customer_email,null);assert.equal(rows[1].order_email,'old@fixture.example');
  assert.equal(rows[2].email_state,'conflict');assert.equal(rows[2].customer_email,'new@fixture.example');
  assert.equal(rows[3].order_email,null);assert.equal(rows[3].email_state,'missing');assert.deepEqual(rows[4],rows[0]);
});
