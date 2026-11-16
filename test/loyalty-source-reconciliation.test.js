import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {reconcileSource,retainedSql,decimal,LIMITS,prepareRepairPlan} from '../diagnostics/loyaltylion-source-reconciliation.mjs';
const start='2026-10-01T00:00:00Z',end='2026-11-01T00:00:00Z',now=()=> '2026-11-16T12:00:00.000Z';
const native=(kind,id)=>`gid://shopify/${kind}/${id}`;
function order(id){return {id:native('Order',id),createdAt:'2026-10-05T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',cancelledAt:null,customer:{id:native('Customer',id)},app:{id:native('App',1),name:'Online Store'},displayFinancialStatus:'PAID',totalPriceSet:{shopMoney:{amount:'100.00',currencyCode:'GBP'},presentmentMoney:{amount:'100',currencyCode:'GBP'}},totalRefundedSet:{shopMoney:{amount:'0',currencyCode:'GBP'}}};}
function row(o){return {order_id:o.id,created_at:{value:o.createdAt},original_total_shop:'100',original_total_presentment:{value:'100.000000000'},total_refunded_shop:'0.00',presentment_currency:'GBP',cancelled_at:null,customer_id:o.customer?.id??null,display_financial_status:o.displayFinancialStatus,customer_cancelled_at:null,customer_app_id:null,source_app_id:o.app?.id??null,order_source:o.app?.name??null,has_finance:true,has_customer:true,has_channel:true};}
function fixture(n=2){const source=Array.from({length:n},(_,i)=>order(i+1)),stored=source.map(row),queries=[];let reads=0,countReads=0;
 const f={source,stored,queries,scopes:['read_all_orders','read_orders','read_customers'],counts:[n,n],warehouseReads:()=>reads,
 graphql:async(q,v)=>{queries.push({q,v});if(q.includes('LoyaltyPopulationScopes'))return {currentAppInstallation:{accessScopes:f.scopes.map(handle=>({handle}))}};if(q.includes('LoyaltyPopulationCount'))return {ordersCount:{count:f.counts[countReads++],precision:f.precision??'EXACT'}};const offset=v.cursor?Number(v.cursor):0,next=offset+100;return {orders:{nodes:source.slice(offset,next),pageInfo:{hasNextPage:next<source.length,endCursor:String(next)}}};},
 readWarehouse:async()=>{reads++;return stored;}};
 f.run=(extra={})=>reconcileSource({graphql:f.graphql,readWarehouse:f.readWarehouse,start,end,now,wait:async()=>{},...extra});return f;
}
test('over 10000 source orders exhaust pagination, reconcile exact IDs and values, and print aggregates only',async()=>{
 const f=fixture(10001),progress=[],r=await f.run({onProgress:x=>progress.push(x)});assert.equal(r.review_ready,true);assert.equal(r.certified,false);assert.equal(r.pages,101);assert.equal(r.calls,104);assert.equal(r.totals.source_orders,10001);assert.equal(r.source_ids_sha256,r.retained_ids_sha256);assert.equal(f.warehouseReads(),1);assert(progress.some(x=>x.orders===10001));assert(r.calls<LIMITS.calls);assert.doesNotMatch(JSON.stringify(r),/gid:\/\/|Customer\/|access_token/);
 assert(f.queries.filter(x=>x.q.includes('LoyaltyOrderPopulation')).every(x=>x.v.query.includes('created_at:>=')&&x.v.query.includes('created_at:<')));
});
test('missing orders, missing table rows and changed fields are separate blockers; customerless orders are not inferred repeat buyers',async()=>{
 const f=fixture(3);f.source[0].customer=null;f.stored[0].customer_id=null;f.stored[1].has_customer=false;f.stored[1].original_total_presentment='101';f.stored.pop();f.stored.push({...row(order(99))});
 const r=await f.run();assert.equal(r.review_ready,false);assert.equal(r.totals.source_only,1);assert.equal(r.totals.retained_only,1);assert.equal(r.totals.missing_customer_evidence,2);assert.equal(r.totals.source_customerless,1);assert.equal(r.differences.gross,1);assert.equal(r.monthly_differences.length,1);
});
test('exact count, historical scopes and concurrent changes are required before review',async()=>{
 for(const mutate of [f=>f.scopes=['read_orders','read_customers'],f=>f.precision='AT_LEAST',f=>f.counts=[2,3]]){const f=fixture();mutate(f);await assert.rejects(f.run(),e=>/^SOURCE_/.test(e.code));assert.equal(f.warehouseReads(),0);}
 const f=fixture();f.source[0].updatedAt=now();const r=await f.run();assert.equal(r.review_ready,false);assert.equal(r.totals.changed_during_read,1);
});
test('duplicate IDs, bad timestamps, late-page failure and cancelled collection never reach warehouse reconciliation',async()=>{
 for(const mutate of [f=>f.source[1].id=f.source[0].id,f=>f.source[1].createdAt=end,f=>f.source[1].customer={id:'123'},f=>{const read=f.graphql;f.graphql=async(q,v)=>{if(v.cursor)throw Object.assign(Error('private payload'),{code:'SOURCE_TEST_FAILURE'});return read(q,v);};}]){const f=fixture(101);mutate(f);await assert.rejects(f.run());assert.equal(f.warehouseReads(),0);}
 const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(f.run({signal:controller.signal}));assert.equal(f.warehouseReads(),0);
});
test('throttling is retried within explicit budget; failed warehouse reads never produce a review result',async()=>{
 const f=fixture(),read=f.graphql;let first=true;f.graphql=async(q,v)=>{if(first){first=false;throw Object.assign(Error('private'),{code:'THROTTLED'});}return read(q,v);};assert.equal((await f.run()).review_ready,true);
 const g=fixture();g.readWarehouse=async()=>{throw Error('private warehouse detail');};await assert.rejects(g.run());
});
test('amount comparisons preserve decimals and SQL only reads bounded exact native populations',()=>{
 assert.equal(decimal({value:'000123.450000000'}),'123.45');assert.equal(decimal('123456789123456789.123456789'),'123456789123456789.123456789');assert.equal(decimal('-0.00'),'0');assert.equal(decimal(null),null);assert.throws(()=>decimal('NaN'));
 const sql=retainedSql('fixture');assert.match(sql,/UNION DISTINCT SELECT order_id FROM c/);assert.match(sql,/UNNEST\(@ids\)/);assert.match(sql,/LIMIT 25001/);assert.doesNotMatch(sql,/\b(?:INSERT|MERGE|DELETE|UPDATE|CREATE)\b/);assert.throws(()=>retainedSql('bad.project'));
});
const sqlAvailable=spawnSync('python3',['-c','import duckdb,sqlglot']).status===0;
test('executed retained SQL includes source-only IDs and customer-only orphan rows without duplicate orders',{skip:!sqlAvailable},()=>{
 const tables={order_financials:[[native('Order',1),100,0,'GBP',null,now(),'2026-10-05T00:00:00Z',100,0]],order_customers:[[native('Order',1),native('Customer',1),'PAID',null,now(),null,'2026-10-05T00:00:00Z'],[native('Order',2),native('Customer',2),'PAID',null,now(),null,'2026-10-05T00:00:00Z']],order_locations:[]};
 const r=spawnSync('python3',['test/loyalty-performance-sql.py'],{input:JSON.stringify({queries:{retained:retainedSql('fixture')},params:{start,end,as_of:now(),ids:[native('Order',1),native('Order',3)],matrixify_app_id:native('App',1758145)},tables}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);const rows=JSON.parse(r.stdout).retained;assert.equal(rows.length,3);assert.equal(rows.find(r=>r.order_id===native('Order',2)).has_finance,false);assert.equal(rows.find(r=>r.order_id===native('Order',1)).has_customer,true);
});


test('row caps, repeated cursors, future windows and interruption during warehouse read stay fail closed',async()=>{
 const capped=fixture();capped.counts=[LIMITS.rows+1,LIMITS.rows+1];await assert.rejects(capped.run(),{code:'SOURCE_ROW_BOUND'});assert.equal(capped.warehouseReads(),0);
 const repeated=fixture(201),read=repeated.graphql;repeated.graphql=async(q,v)=>{const r=await read(q,v);if(q.includes('LoyaltyOrderPopulation')&&v.cursor)r.orders.pageInfo.endCursor='100';return r;};await assert.rejects(repeated.run(),{code:'SOURCE_CURSOR_INVALID'});assert.equal(repeated.warehouseReads(),0);
 const future=fixture();await assert.rejects(future.run({end:'2026-11-17T00:00:00Z'}),{code:'SOURCE_WINDOW_BOUND'});assert.equal(future.queries.length,0);
 const interrupted=fixture(),controller=new AbortController();interrupted.readWarehouse=async()=>{controller.abort();return interrupted.stored;};await assert.rejects(interrupted.run({signal:controller.signal}));
});

import {mkdtemp,readFile,stat,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('source-seeded placeholder rows cannot inflate retained population or make ID hashes agree',async()=>{
 const f=fixture();f.stored[1]={order_id:f.source[1].id,has_finance:false,has_customer:false,has_channel:false};let issues;
 const r=await f.run({onDifferences:x=>{issues=x;}});assert.equal(r.totals.source_orders,2);assert.equal(r.totals.retained_orders,1);assert.equal(r.totals.source_only,1);assert.notEqual(r.source_ids_sha256,r.retained_ids_sha256);assert.equal(r.affected_orders,1);assert.equal(issues[0].order_id,f.source[1].id);assert.deepEqual(issues[0].fields,['missing_channel_evidence','missing_customer_evidence','missing_finance','source_only']);assert.doesNotMatch(JSON.stringify(r),/gid:\/\//);
});
test('explicit repair preparation saves only bounded exact IDs and fields in a private preview file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ll-repair-test-'));t.after(()=>rm(root,{recursive:true,force:true}));const f=fixture();f.stored[0].display_financial_status='PENDING';let issues;const r=await f.run({onDifferences:x=>{issues=x;}});
 const preview=await prepareRepairPlan(r,issues,{root,now});assert.equal(preview.affected_orders,1);assert.equal(preview.apply_supported,false);assert.equal(preview.warehouse_writes,false);assert.equal((await stat(preview.private_plan_file)).mode&0o777,0o600);const directory=preview.private_plan_file.slice(0,preview.private_plan_file.lastIndexOf('/'));assert.equal((await stat(directory)).mode&0o777,0o700);
 const plan=JSON.parse(await readFile(preview.private_plan_file,'utf8'));assert.deepEqual(plan.orders,[{order_id:f.source[0].id,fields:['financial_status']}]);assert.equal(plan.status,'preview_only');assert.equal(plan.source_run_id,r.run_id);assert.doesNotMatch(JSON.stringify(plan),/Customer\/|access_token|PAID|PENDING/);assert.doesNotMatch(JSON.stringify(preview),/gid:\/\//);
 for(const [bad,items]of [[{...r,totals:{...r.totals,changed_during_read:1}},issues],[r,[]],[r,[{order_id:'not-native',fields:['financial_status']}]],[{...r,differences:{gross:1}},issues]])await assert.rejects(prepareRepairPlan(bad,items,{root,now}));
 await assert.rejects(prepareRepairPlan(r,issues,{root,now:()=> '2026-11-16T13:00:00Z'}),{code:'SOURCE_REPAIR_PLAN_EXPIRED'});assert.equal((await readdir(root)).length,1);
});
test('normal reconciliation never writes a plan and no-difference previews create no file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'ll-repair-empty-'));t.after(()=>rm(root,{recursive:true,force:true}));const f=fixture();let issues;const r=await f.run({onDifferences:x=>{issues=x;}});assert.equal(r.review_ready,true);assert.deepEqual(issues,[]);assert.equal((await prepareRepairPlan(r,issues,{root,now})).local_file_written,false);assert.deepEqual(await readdir(root),[]);
});
