import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TABLES,candidates,preview,apply,validatePreview,digest,promotionSql,snapshotSql,mergeCandidate} from '../shopify/commerce-repair.js';
const NOW='2026-11-16T13:00:00.000Z',now=()=>NOW,old='2026-11-15T00:00:00.000Z',id='gid://shopify/Order/1';
function fixture(){
 const source={id,name:'#test',createdAt:'2026-10-05T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',processedAt:null,cancelledAt:null,displayFinancialStatus:'PAID',paymentGatewayNames:['fixture'],customer:{id:'gid://shopify/Customer/1'},app:{id:'gid://shopify/App/1',name:'Online Store'},retailLocation:null,transactions:[]};
 for(const set of ['totalPriceSet','subtotalPriceSet','totalTaxSet','totalDiscountsSet','totalShippingPriceSet','totalRefundedSet','totalReceivedSet'])source[set]={shopMoney:{amount:set==='totalRefundedSet'?'0':'100',currencyCode:'GBP'},presentmentMoney:{amount:set==='totalRefundedSet'?'0':'100',currencyCode:'GBP'}};
 const original=candidates([source],old);original.order_customers[0].display_financial_status='PENDING';original.order_customers[0].customer_name='private legacy name';
 const schemas=Object.fromEntries(TABLES.map(t=>[t,Object.keys(original[t][0]).map(name=>({name,type:name==='is_guest'?'BOOLEAN':name.endsWith('_at')?'TIMESTAMP':/_(shop|presentment)$/.test(name)?'NUMERIC':'STRING',mode:name==='order_id'?'REQUIRED':'NULLABLE'}))]));
 const snapshots=TABLES.map(t=>({table_name:t,order_id:id,fingerprint:'HASH_'+t,row_json:JSON.stringify(original[t][0])}));const states=[{table_name:'customer_refresh_state',fingerprint:'CUSTOMER'},{table_name:'finance_refresh_state',fingerprint:'FINANCE'}],events=[],manifests=new Map();let holder=null;
 const f={source,schemas,snapshots,states,events,manifests,published:0,failLoad:false,unknownCommit:false,changeAfterStage:false};
 f.graphql=async(q)=>{if(q.includes('LoyaltyPopulationScopes'))return {currentAppInstallation:{accessScopes:['read_all_orders','read_orders','read_customers'].map(handle=>({handle}))}};if(q.includes('LoyaltyPopulationCount'))return {ordersCount:{count:1,precision:'EXACT'}};if(q.includes('LoyaltyOrderPopulation'))return {orders:{nodes:[source],pageInfo:{hasNextPage:false,endCursor:'end'}}};if(f.changeAfterStage&&events.some(x=>x.load))return {nodes:[{...source,updatedAt:NOW}]};return {nodes:[source]};};
 const table=t=>({getMetadata:async()=>[{schema:{fields:schemas[t]||[]},expirationTime:null}],create:async o=>{events.push({create:t,options:o});},load:async(file,o)=>{events.push({load:t,options:o,rows:(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse)});if(f.failLoad)throw Error('private load failure');}});
 f.db={dataset:()=>({table}),query:async q=>{events.push({sql:q.query,params:q.params});const sql=q.query;
  if(sql.includes('has_finance'))return [[{order_id:id,created_at:source.createdAt,original_total_shop:'100',original_total_presentment:'100',total_refunded_shop:'0',presentment_currency:'GBP',cancelled_at:null,customer_id:source.customer.id,display_financial_status:'PENDING',customer_cancelled_at:null,customer_app_id:null,source_app_id:source.app.id,order_source:'Online Store',has_finance:true,has_customer:true,has_channel:true}]];
  if(sql.includes('row_json'))return [snapshots];if(sql.startsWith('SELECT')&&sql.includes('finance_refresh_state'))return [states];
  if(sql.startsWith('SELECT status'))return [[...(manifests.get(q.params.run)?[{status:manifests.get(q.params.run)}]:[])]];
  if(sql.includes("VALUES(@run,'preparing'")){if(holder)throw Error('busy');holder=q.params.run;manifests.set(holder,'preparing');}
  if(sql.includes("SET status='failed_before_publication'")){manifests.set(q.params.run,'failed_before_publication');holder=null;}
  return [[]];},createQueryJob:async q=>{events.push({job:q});if(q.dryRun)return [{}];return [{getQueryResults:async()=>{f.published++;manifests.set(q.params.run,'committed');holder=null;for(const row of snapshots)row.fingerprint='NEW_'+row.fingerprint;if(f.unknownCommit)throw Error('timeout private details');return [[]];}}];}};
 f.prepare=async root=>{const result=await preview({db:f.db,project:'fixture',location:'US',graphql:f.graphql,start:'2026-10-01T00:00:00Z',end:'2026-11-01T00:00:00Z',now,root});return {result,plan:JSON.parse(await readFile(result.preview_file,'utf8'))};};
 f.apply=(plan,extra={})=>apply({db:f.db,project:'fixture',location:'US',graphql:f.graphql,plan,env:{SHOPIFY_COMMERCE_REPAIR_ENABLED:'true'},confirmedPaused:true,now,...extra});return f;
}
async function root(t){const p=await mkdtemp(join(tmpdir(),'repair-fixture-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('fresh preview captures only bounded targets, preserves unknown columns and exact decimals, and performs no live writes',async t=>{
 const f=fixture(),{result,plan}=await f.prepare(await root(t));assert.equal(result.affected_orders,1);assert.equal(result.warehouse_writes,false);assert.equal(f.published,0);assert.equal(plan.data.order_customers[0].customer_name,'private legacy name');assert.equal(plan.data.order_financials[0].original_total_shop,'100');assert.equal((await stat(result.preview_file)).mode&0o777,0o600);assert(f.events.every(x=>!x.create&&!x.load&&!x.job));assert.doesNotMatch(JSON.stringify(result),/gid:\/\/|private legacy/);validatePreview(plan,NOW);
});
test('gated apply stages three snapshots and atomically appends with manifest; watermarks and old rows are never changed',async t=>{
 const f=fixture(),{plan}=await f.prepare(await root(t));const r=await f.apply(plan);assert.equal(r.status,'committed');assert.equal(r.watermarks_changed,false);assert.equal(r.history_preserved,true);assert.equal(f.published,1);assert.equal(f.events.filter(e=>e.load).length,3);assert(f.events.filter(e=>e.create).every(e=>Number(e.options.expirationTime)>Date.now()));assert(f.events.filter(e=>e.load).every(e=>e.options.writeDisposition==='WRITE_EMPTY'));
 const q=f.events.find(e=>e.job&&!e.job.dryRun).job;assert.match(q.jobId,/commerce_repair_/);assert.match(q.query,/REPAIR_ROWS_CHANGED/);assert.match(q.query,/REPAIR_WATERMARK_CHANGED/);assert.match(q.query,/COMMIT TRANSACTION/);assert.doesNotMatch(q.query,/\bDELETE\b|\bMERGE\b|UPDATE `fixture\.shopify_data\.(?:finance_refresh_state|customer_refresh_state|order_)/);assert.equal(f.manifests.get(plan.run_id),'committed');
 await assert.rejects(f.apply(plan),{code:'REPAIR_WAREHOUSE_CHANGED'});assert.equal(f.published,1);
});
test('disabled apply, missing pause confirmation, stale/tampered plans and changed source/warehouse refuse before staging',async t=>{
 const f=fixture(),{plan}=await f.prepare(await root(t));await assert.rejects(f.apply(plan,{env:{}}),{code:'REPAIR_APPLY_DISABLED'});await assert.rejects(f.apply(plan,{confirmedPaused:false}),{code:'REPAIR_APPLY_DISABLED'});await assert.rejects(f.apply(plan,{now:()=> '2026-11-16T14:00:00Z'}),{code:'REPAIR_PREVIEW_INVALID_OR_EXPIRED'});
 const edited=structuredClone(plan);edited.data.order_financials[0].original_total_shop='999';assert.throws(()=>validatePreview(edited,NOW),{code:'REPAIR_PREVIEW_CHANGED'});delete edited.integrity;edited.integrity=digest(edited);await assert.rejects(f.apply(edited),{code:'REPAIR_PREVIEW_CHANGED'});
 f.source.displayFinancialStatus='REFUNDED';await assert.rejects(f.apply(plan),{code:'REPAIR_SOURCE_CHANGED'});assert.equal(f.published,0);assert(!f.events.some(e=>e.create));
});
test('stage failure or source change after staging leaves live rows unchanged and records prepublication failure',async t=>{
 for(const option of ['failLoad','changeAfterStage']){const f=fixture(),{plan}=await f.prepare(await root(t));f[option]=true;await assert.rejects(f.apply(plan),{code:'REPAIR_PREPUBLICATION_FAILED'});assert.equal(f.published,0);assert.equal(f.manifests.get(plan.run_id),'failed_before_publication');}
});
test('ambiguous publication is never replayed or labelled failed; durable status can show committed',async t=>{
 const f=fixture(),{plan}=await f.prepare(await root(t));f.unknownCommit=true;await assert.rejects(f.apply(plan),e=>e.code==='REPAIR_COMMIT_UNKNOWN'&&e.run_id===plan.run_id);assert.equal(f.published,1);assert.equal(f.manifests.get(plan.run_id),'committed');assert(!f.events.some(e=>e.sql?.includes("SET status='failed_before_publication'")));
});
test('source rows and generated SQL protect decimal precision, exact IDs, retention and snapshot fingerprints',()=>{
 const f=fixture();f.source.totalPriceSet.shopMoney.amount='123456789123456789.123456789';assert.equal(candidates([f.source],NOW).order_financials[0].original_total_shop,'123456789123456789.123456789');assert.throws(()=>candidates([f.source,f.source],NOW));const sql=snapshotSql('fixture',f.schemas);assert.match(sql,/CAST\(x\.`original_total_shop` AS STRING\)/);assert(!sql.includes("'"+String.fromCharCode(10)+"'"));assert.match(promotionSql('fixture',Object.fromEntries(TABLES.map(t=>[t,'stage_'+t])),f.schemas),/INSERT INTO `fixture.shopify_data.order_customers`/);
});


test('retention, active-writer checks and incomplete source reads block before live publication',async t=>{
 const f=fixture(),{plan}=await f.prepare(await root(t));const originalQuery=f.db.query;f.db.query=async q=>{if(q.query.startsWith('ASSERT'))throw Error('active collector');return originalQuery(q);};await assert.rejects(f.apply(plan));assert.equal(f.published,0);assert(!f.events.some(e=>e.create));
 const g=fixture();g.db.dataset=()=>({table:()=>({getMetadata:async()=>[{expirationTime:'1',schema:{fields:[]}}]})});await assert.rejects(g.prepare(await root(t)),{code:'REPAIR_RETENTION'});
 const h=fixture(),read=h.graphql;h.graphql=async(q,v)=>q.includes('query CommerceRepair')?{nodes:[null]}:read(q,v);await assert.rejects(h.prepare(await root(t)),{code:'REPAIR_SOURCE_INCOMPLETE'});assert.equal(h.published,0);
});


test('corrected customer links clear stale personal names while stable links preserve existing columns',()=>{
 const old={order_id:id,customer_id:'gid://shopify/Customer/1',customer_name:'old person',extra:'preserve'};
 assert.equal(mergeCandidate('order_customers',old,{customer_id:'gid://shopify/Customer/2'}).customer_name,null);
 assert.equal(mergeCandidate('order_customers',old,{customer_id:null}).customer_name,null);
 assert.equal(mergeCandidate('order_customers',old,{customer_id:old.customer_id}).customer_name,'old person');
 assert.equal(mergeCandidate('order_customers',old,{customer_id:'gid://shopify/Customer/2'}).extra,'preserve');
});

test('compound BigQuery ASSERT predicates are wholly parenthesized, including idle, stage and ownership checks',()=>{
 const f=fixture(),sql=promotionSql('gf-full-data',Object.fromEntries(TABLES.map(t=>[t,'stage_'+t])),f.schemas);
 for(const statement of sql.split(';').filter(s=>s.trim().startsWith('ASSERT')&&s.includes(' AND '))){
  const expr=statement.trim().replace(/^ASSERT\s+/,'').replace(/\s+AS\s+'[^']+'$/,'');assert.equal(expr[0],'(');let depth=0;for(let i=0;i<expr.length;i++){if(expr[i]==='(')depth++;if(expr[i]===')')depth--;if(depth===0)assert.equal(i,expr.length-1,'ASSERT predicate must not end before its AND clause');}assert.equal(depth,0);
 }
});

import {spawnSync} from 'node:child_process';
import {idleSql} from '../shopify/commerce-repair.js';
const guardSqlAvailable=spawnSync('python3',['-c','import duckdb,sqlglot']).status===0;
test('executed idle guard expressions retain active-writer and singleton ownership protections',{skip:!guardSqlAvailable},()=>{
 const expressions=idleSql('gf-full-data').split(';').map(s=>s.trim()).filter(Boolean).map(s=>s.replace(/^ASSERT\s+/,'').replace(/\s+AS\s+'[^']+'$/,''));
 const script=`import sys,json,re,duckdb,sqlglot
expr=json.load(sys.stdin);result=[]
for finance,customer,holders in [(False,False,[None]),(True,False,[None]),(False,True,[None]),(False,False,['busy']),(False,False,[]),(False,False,[None,None])]:
 c=duckdb.connect()
 c.execute('CREATE TABLE finance_refresh_runs(status VARCHAR)');c.execute('CREATE TABLE customer_refresh_runs(status VARCHAR)');c.execute('CREATE TABLE customer_incremental_guard(holder VARCHAR)')
 if finance:c.execute("INSERT INTO finance_refresh_runs VALUES ('running')")
 if customer:c.execute("INSERT INTO customer_refresh_runs VALUES ('running')")
 for holder in holders:c.execute('INSERT INTO customer_incremental_guard VALUES (?)',[holder])
 values=[]
 for e in expr:
  q=re.sub(r'\x60gf-full-data.shopify_data.([^\x60]+)\x60',r'\\1','SELECT '+e)
  q=sqlglot.parse_one(q,read='bigquery').sql(dialect='duckdb');values.append(c.execute(q).fetchone()[0])
 result.append(values)
print(json.dumps(result))`;
 const r=spawnSync('python3',['-c',script],{input:JSON.stringify(expressions),encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),[[true,true,true],[false,true,true],[true,false,true],[true,true,false],[true,true,false],[true,true,false]]);
});
