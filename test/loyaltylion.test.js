import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoyaltyClient} from '../loyaltylion/client.js';
import {collectionGate,gid,normalizeCustomer,normalizeTransaction} from '../loyaltylion/contracts.js';
import {collectReviewedPlan,initialSyncPlan,promotionSql} from '../loyaltylion/sync.js';
import {coverageComplete,londonMidnight,loyaltyQueries} from '../oracle/loyaltylion.js';
import {reviewedConfig} from './helpers/loyalty-fixture.js';
const limits={max_calls:10,max_pages:3,max_rows:5,max_ms:5000,requests_per_second:4,retries:1};
const run={program_id:'1',observed_at:'2026-11-06T10:00:00.000Z',run_id:'fixture'};
const customer={id:1,merchant_id:'123',enrolled:true,guest:false,blocked:false,enrolled_at:'2025-11-01T12:00Z',points_approved:20,points_pending:10,points_spent:5,updated_at:'2026-11-01T12:00Z',email:'private@example.com',birthday:'private',loyalty_tier_membership:{loyalty_tier:{id:4,name:'Gold'}}};
const tx={id:10,customer:{id:1,merchant_id:'123',email:'private@example.com'},created_at:'2026-10-01T12:00Z',points_approved:10,points_pending:-10,resource:'activity',activity:{id:2,order:{merchant_id:'234'}}};
test('GET allowlist, bounded complete pagination, duplicate/repeated cursors and secrets excluded from errors',async()=>{
 let requests=[],now=0;const make=body=>createLoyaltyClient({key:'secret',limits,now:()=>now,wait:async ms=>{now+=ms;},fetchImpl:async(u,o)=>{requests.push([u,o]);return {ok:true,status:200,json:async()=>body};}});
 assert.deepEqual(await make({customers:[customer],cursor:{next:null}}).list('customers'),[customer]);assert.equal(requests[0][1].method,'GET');assert.equal(requests[0][1].redirect,'error');
 await assert.rejects(make({}).get('customers/1/points'),{code:'LOYALTY_ENDPOINT_NOT_ALLOWED'});
 await assert.rejects(make({customers:[customer],cursor:{next:'repeat'}}).list('customers'),{code:'LOYALTY_DUPLICATE_PAGE_ID'});
 await assert.rejects(make({customers:[],cursor:{next:'next'}}).list('customers'),{code:'LOYALTY_CURSOR_INVALID'});
 const denied=createLoyaltyClient({key:'secret',limits,fetchImpl:async()=>({ok:false,status:403})});await assert.rejects(denied.get('identity/whoami'),e=>e.code==='LOYALTY_PERMISSION_UNAVAILABLE'&&!e.message.includes('secret'));
});
test('retry-after is honored without exceeding elapsed/call bounds',async()=>{
 let now=0,n=0;const waits=[];const c=createLoyaltyClient({key:'fixture',limits,now:()=>now,wait:async ms=>{waits.push(ms);now+=ms;},fetchImpl:async()=>++n===1?{status:429,headers:{get:()=> '2'}}:{ok:true,status:200,json:async()=>({identity:{}})}});await c.get('identity/whoami');assert(waits.includes(2000));assert.equal(c.stats().calls,2);
 const bounded=createLoyaltyClient({key:'fixture',limits:{...limits,max_ms:1000},wait:async()=>{},fetchImpl:async()=>({status:429,headers:{get:()=> '20'}})});await assert.rejects(bounded.get('identity/whoami'),{code:'LOYALTY_TIME_BOUND'});
});
test('lossless typed IDs and signed deltas; no PII, codes, balance-derived history or alias merging',()=>{
 assert.equal(gid('Customer','123'),'gid://shopify/Customer/123');assert.equal(gid('Order','gid://shopify/Order/234'),'gid://shopify/Order/234');assert.equal(gid('Customer','gid://shopify/Order/234'),null);assert.throws(()=>gid('Customer',9007199254740992));
 const c=normalizeCustomer(customer,run),t=normalizeTransaction(tx,run);assert.equal(c.tier_name,'Gold');assert.equal(t.transaction.approved_delta+t.transaction.pending_delta,0);assert.equal(t.transaction.shopify_order_gid,'gid://shopify/Order/234');
 const reward=normalizeTransaction({...tx,resource:'claimed_reward',activity:undefined,claimed_reward:{id:9,claimed_at:tx.created_at,point_cost:20,state:'approved',reward:{kind:'gift_card'},redeemable:{code:'SECRET_GIFT_CARD'},session:{token:'SECRET_SESSION'}}},run);
 assert.equal(reward.claim.claim_id,'9');assert.doesNotMatch(JSON.stringify([c,t,reward]),/email|birthday|private@example|SECRET_|redeemable|session|linked_merchant_ids/);assert.equal(reward.transaction.shopify_order_gid,null);
});
test('plan is inert; reviewed identity, explicit initial plan, flag and apply all required before IO',async()=>{
 const c=reviewedConfig();c.initial_sync.end_exclusive='2026-10-02T23:00:00Z';assert.equal(initialSyncPlan(c).collection_enabled,false);
 assert.throws(()=>collectionGate(c,{}, {apply:true}),{code:'LOYALTY_COLLECTION_DISABLED'});assert.throws(()=>collectionGate({...c,access_status:'unverified'},{LOYALTYLION_COLLECTION_ENABLED:'true'},{apply:true}),{code:'LOYALTY_ACCESS_NOT_REVIEWED'});
 await assert.rejects(collectReviewedPlan({config:c,env:{},apply:true,client:{get:()=>assert.fail('No vendor IO before gate')}}),{code:'LOYALTY_COLLECTION_DISABLED'});
 assert.throws(()=>collectionGate({...c,initial_sync:null},{LOYALTYLION_COLLECTION_ENABLED:'true'},{apply:true}),{code:'LOYALTY_SYNC_PLAN_NOT_REVIEWED'});
});
test('resource pagination failure cannot promote rows or advance checkpoints; independent success retained',async()=>{
 const c=reviewedConfig();c.initial_sync.end_exclusive='2026-10-02T23:00:00Z';const writes=[];
 const result=await collectReviewedPlan({config:c,env:{LOYALTYLION_COLLECTION_ENABLED:'true'},apply:true,project:'fixture',now:()=>run.observed_at,client:{get:async path=>path==='sites'?{sites:[{id:3,program_id:1,platform:'shopify',url:'https://fixture.example'}]}:{identity:{program_id:1,account_id:2,scopes:['read_orders','read_customers']}},list:async r=>{if(r==='transactions')throw Error('late page failed');return [customer];}},bigquery:{dataset:()=>({getMetadata:async()=>[{location:'US'}],table:()=>({exists:async()=>[true]})}),query:async q=>{writes.push(q);return [[]];}}});
 const promotions=writes.filter(q=>q.labels?.operation==='promote');assert.equal(promotions.length,1);assert.equal(promotions[0].params.resource,'customers');assert.equal(result.guard_status,'released');assert.equal(result.resources[0].status,'complete');assert.equal(result.resources[1].status,'failed_or_commit_unknown');assert.equal(result.complete,false);
 assert.match(promotions[0].query,/BEGIN TRANSACTION/);assert.match(promotions[0].query,/COMMIT TRANSACTION/);assert.doesNotMatch(promotions[0].query,/TRUNCATE|DELETE|CREATE TABLE/);
 const sql=promotionSql('fixture','loyaltylion','transactions');assert.match(sql,/IMMUTABLE_CONFLICT/);assert.match(sql,/WHEN NOT MATCHED THEN INSERT \(/);assert.doesNotMatch(sql,/WHEN MATCHED THEN UPDATE SET.*approved_delta/);
});
test('London exact boundaries and contiguous coverage refuse partial-day, gap and failure',()=>{
 assert.equal(londonMidnight('2026-05-01'),'2026-04-30T23:00:00.000Z');assert.equal(londonMidnight('2026-11-01'),'2026-11-01T00:00:00.000Z');assert.throws(()=>londonMidnight('2026-02-30'));
 const rows=[{start_at:'2026-04-30T23:00Z',end_exclusive:'2026-05-02T23:00Z',status:'complete'},{start_at:'2026-05-02T23:00Z',end_exclusive:'2026-05-04T23:00Z',status:'complete'}];assert(coverageComplete(rows,londonMidnight('2026-05-01'),londonMidnight('2026-05-05')));assert(!coverageComplete([{...rows[0],start_at:'2026-05-01T08:00Z'},rows[1]],londonMidnight('2026-05-01'),londonMidnight('2026-05-05')));
});
test('read SQL shares Shopify eligibility and exact typed linkage; unknown channel/currency and unmatched coverage survive',()=>{
 const q=loyaltyQueries('fixture','loyaltylion',{grain:'day'});for(const sql of Object.values(q)){assert.doesNotMatch(sql,/INSERT|MERGE|DELETE|UPDATE|CREATE|metorik_|email|voucher|gift_card/);}
 assert.match(q.linkage,/shopify_order_gid=o.source_order_id/);assert.match(q.linkage,/shopify_customer_gid!=o.source_customer_id/);assert.match(q.linkage,/Unknown currency/);assert.match(q.linkage,/COUNT\(DISTINCT IF/);assert.match(q.linkage,/NOT is_migrated_order/);assert.match(q.linkage,/partially_refunded/);assert.match(q.linkage,/online store/);assert.match(q.linkage,/ELSE 'unknown'/);assert.match(q.points,/Europe\/London/);assert.match(q.points,/transaction_runs/);
});
import {spawnSync} from 'node:child_process';
const sqlAvailable=spawnSync('python3',['-c','import duckdb,sqlglot']).status===0;
test('executed generated SQL: London bounds, exact Shopify IDs, Matrixify/status exclusions, deduplication, unknown channels and claim counts', {skip:!sqlAvailable},()=>{
 const cid='gid://shopify/Customer/1',oid=n=>'gid://shopify/Order/'+n,stamp='2026-11-01T12:00:00Z',tables={customer_snapshots:[['1','1',cid,true,false,false,50,10,'Gold','roster']],points_transactions:[],reward_claim_observations:[['1','claim','1','2026-10-02T12:00:00Z',20,'cart_discount_voucher',stamp,'points'],['1','claim','1','2026-10-02T12:00:00Z',20,'cart_discount_voucher',stamp,'points']],order_customers:[],order_financials:[],order_locations:[]};
 for(let i=1;i<=6;i++){
  tables.order_customers.push([oid(i),cid,i===6?'REFUNDED':'PAID',null,stamp]);tables.order_financials.push([oid(i),100,i===6?100:0,i===2?'USD':'GBP',null,stamp]);tables.order_locations.push([oid(i),i===3?'gid://shopify/App/1758145':null,'2026-09-01T12:00:00Z',i===2?'POS':null,i===4?'Shopify Draft Order':'Online Store',stamp]);
 }
 const add=(id,order,customer=cid,a=10,p=0,created='2026-09-30T23:00:00Z')=>tables.points_transactions.push(['1',id,'1',customer,order,created,'activity',a,p,'points']);
 add('1',oid(1),cid,10,-10);add('2',oid(1));add('3',oid(2));add('4',oid(3));add('5',oid(4));add('6',oid(5),'gid://shopify/Customer/2');add('7',oid(6));add('8',null);add('before',oid(1),cid,999,0,'2026-09-30T22:59:59Z');add('after',oid(1),cid,999,0,'2026-11-01T00:00:00Z');
 const all=loyaltyQueries('fixture','loyaltylion'),queries=Object.fromEntries(['membership','tiers','points','claims','linkage','linkage_coverage'].map(k=>[k,all[k]])),params={program_id:'1',roster_run:'roster',transaction_runs:['points'],start_date:'2026-10-01',end_date:'2026-10-31',tier:null,channel:null,currencies:[],matrixify_app_id:'gid://shopify/App/1758145'};
 const r=spawnSync('python3',['test/loyalty-sql.py'],{input:JSON.stringify({queries,params,tables}),encoding:'utf8'});assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout);
 assert.equal(result.membership[0].profiles,1);assert.equal(result.claims[0].reward_claims,1);assert.equal(result.points[0].point_movements,8);assert.equal(result.points[0].approved_delta,80);assert.equal(result.points[0].pending_delta,-10);assert.equal(result.points[0].net_points_delta,70);assert.equal(result.points[0].date,'2026-10-01');
 assert.equal(result.linkage.find(r=>r.channel==='online'&&r.linkage_state==='matched').linked_qualifying_orders,1);assert.equal(result.linkage.find(r=>r.channel==='instore').currency,'USD');assert(result.linkage.some(r=>r.channel==='unknown'&&r.linkage_state==='matched'));assert.equal(result.linkage_coverage[0].point_records,8);assert.equal(result.linkage_coverage[0].unmatched_or_ineligible_order,2);assert.equal(result.linkage_coverage[0].ambiguous_customer,1);assert.equal(result.linkage_coverage[0].no_order_reference,1);assert.equal(result.linkage_coverage[0].matched,4);
});

test('metadata access verification never fetches customers or exposes keys/export URLs/codes',async()=>{
 const {verifyLoyaltyAccess}=await import('../loyaltylion/access.js');const calls=[];
 const absent=await verifyLoyaltyAccess({env:{},config:reviewedConfig(),fetchImpl:()=>assert.fail('No key means no calls')});assert.equal(absent.permissions,'unverified');
 const r=await verifyLoyaltyAccess({env:{LOYALTYLION_API_KEY:'SECRET_API_KEY'},config:reviewedConfig(),fetchImpl:async(url,opts)=>{calls.push(url);assert.equal(opts.method,'GET');return {ok:true,status:200,json:async()=>url.includes('whoami')?{identity:{kind:'api_key',program_id:1,account_id:2,scopes:['read_customers','read_orders']}}:url.endsWith('/sites')?{sites:[{id:3,url:'https://fixture.example?secret=SECRET_URL',program_id:1,platform:'shopify'}]}:{exports:[{id:4,status:'completed',download_url:'SECRET_DOWNLOAD',download_url_expires_at:'secret',filters:{email:'secret@example.com'},row_count:5}],cursor:{next:null}}};}});
 assert.equal(r.permissions,'observed');assert.equal(r.export_jobs[0].row_count,5);assert(calls.every(u=>/\/identity\/whoami$|\/sites$|\/customers\/exports\?/.test(u)));assert.doesNotMatch(JSON.stringify(r),/SECRET_|secret@example|download_url/);
});

test('unknown promotion retains the warehouse guard and prevents automatic recollection',async()=>{
 const c=reviewedConfig();let locked=false,listCalls=0;const writes=[];
 const client={get:async path=>path==='sites'?{sites:[{id:3,program_id:1,platform:'shopify',url:'https://fixture.example'}]}:{identity:{program_id:1,account_id:2,scopes:['read_customers','read_orders']}},list:async()=>{listCalls++;return [customer];}};
 const bq={dataset:()=>({getMetadata:async()=>[{location:'US'}],table:()=>({exists:async()=>[true]})}),query:async q=>{writes.push(q);if(q.labels.operation==='acquire'){if(locked)throw Error('busy');locked=true;return [[]];}if(q.labels.operation==='promote')throw Error('commit result lost');assert.fail('Must not release uncertain guard');}};
 const first=await collectReviewedPlan({config:c,env:{LOYALTYLION_COLLECTION_ENABLED:'true'},apply:true,client,bigquery:bq,project:'fixture',now:()=>run.observed_at});assert.equal(first.guard_status,'retained_commit_unknown');assert.equal(first.resources[1].status,'not_attempted_after_resource_failure');
 const second=await collectReviewedPlan({config:c,env:{LOYALTYLION_COLLECTION_ENABLED:'true'},apply:true,client,bigquery:bq,project:'fixture',now:()=>run.observed_at});assert.equal(second.status,'guard_acquisition_failed_or_unknown');assert.equal(listCalls,1);
});

test('multi-site programmes fail before customer collection instead of assuming shared merchant IDs',async()=>{
 const c=reviewedConfig();await assert.rejects(collectReviewedPlan({config:c,env:{LOYALTYLION_COLLECTION_ENABLED:'true'},apply:true,client:{get:async path=>path==='sites'?{sites:[{id:3,program_id:1},{id:4,program_id:1}]}:{identity:{program_id:1,account_id:2,scopes:['read_customers','read_orders']}},list:()=>assert.fail('No customer reads')},bigquery:{},project:'fixture'}),{code:'LOYALTY_MULTI_SITE_MAPPING_UNAVAILABLE'});
});
