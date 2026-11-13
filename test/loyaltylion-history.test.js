import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoyaltyClient} from '../loyaltylion/client.js';
import {collectReviewedPlan,promotionSql} from '../loyaltylion/sync.js';
import {historyPlan,nextHistoryWindow,runHistory,previewHistory} from '../loyaltylion/history.js';
import {reviewedConfig} from './helpers/loyalty-fixture.js';
const profile={reviewed_by:'fixture',reviewed_at:'2026-11-11T00:00:00Z',max_rows:100000,max_pages:250,max_calls:300,max_ms:900000,max_bytes:64000000,page_bytes:2000000};
const plan={version:1,status:'reviewed',reviewed_by:'fixture',reviewed_at:profile.reviewed_at,start_at:'2026-10-01T00:00:00Z',end_exclusive:'2026-10-15T00:00:00Z',window_days:7,incremental_enabled:false,roster_staging:profile,transaction_staging:profile};
const window={start_at:plan.start_at,end_exclusive:'2026-10-08T00:00:00Z'};
function fixture(fault){
 const config={...reviewedConfig(),transaction_staging:profile,initial_sync:{reviewed_by:'fixture',reviewed_at:profile.reviewed_at,resources:['transactions'],...window}};
 let clock=0,staged=0;const queries=[];
 const client=createLoyaltyClient({key:'fixture',limits:{...config.limits,max_calls:300,max_ms:900000},now:()=>clock,wait:async ms=>clock+=ms,fetchImpl:async url=>{
  const u=new URL(url),path=u.pathname.split('/').pop();let body;
  if(path==='whoami')body={identity:{program_id:config.program_id,account_id:config.account_id,scopes:['read_customers','read_orders']}};
  if(path==='sites')body={sites:[{id:config.site_id,program_id:config.program_id,platform:'shopify',url:config.site_url}]};
  if(path==='transactions'){
   const page=Number(u.searchParams.get('cursor')||0);
   if(['late','interrupt'].includes(fault)&&page===22)throw Error('private payload');
   const start=page*500,end=Math.min(start+500,12050);
   body={transactions:Array.from({length:end-start},(_,i)=>({id:fault==='duplicate'&&page===2&&i===0?1:start+i+1,customer:{id:1,merchant_id:'1'},created_at:fault==='window'?'2026-09-30T23:59:00Z':'2026-10-01T12:00:00Z',resource:'activity',points_approved:1,points_pending:0})),cursor:{next:end===12050?null:String(page+1)}};
  }
  return {ok:true,status:200,json:async()=>body};
 }});
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}],table:()=>({exists:async()=>[true],getMetadata:async()=>[{}]})}),query:async q=>{
  queries.push(q);
  if(q.query.startsWith('INSERT INTO')){staged+=JSON.parse(q.params.rows).length;if(fault==='stage'&&staged>10000)throw Error('stage unavailable');}
  if(q.labels?.operation==='promote'&&fault==='commit')throw Error('uncertain');
  return [[]];
 }};
 return {config,client,bigquery,queries,stats:()=>({staged})};
}
test('12050 historical transactions stage pagewise with completion marker and monotonic checkpoint in one transaction',async()=>{
 const f=fixture(),progress=[];const r=await collectReviewedPlan({...f,project:'fixture',apply:true,env:{LOYALTYLION_COLLECTION_ENABLED:'true'},onProgress:x=>progress.push(x)});
 assert.equal(r.complete,true);assert.equal(r.resources[0].rows,12050);assert.equal(f.stats().staged,12050);
 assert(progress.some(p=>p.phase==='transactions_staging'&&p.pages===25));
 const q=f.queries.find(q=>q.labels?.operation==='promote');assert.equal(q.params.rows,'[]');assert.equal(q.params.claims,'[]');
 assert.match(q.query,/SELECT \* FROM .*_loyalty_points_/);assert.match(q.query,/COUNT\(DISTINCT transaction_id\)/);assert.match(q.query,/IMMUTABLE_CONFLICT/);assert.match(q.query,/s.end_exclusive>t.end_exclusive/);assert.match(q.query,/COMMIT TRANSACTION/);
 assert(f.queries.filter(q=>q.query.startsWith('CREATE TABLE')).every(q=>q.query.includes('INTERVAL 24 HOUR')));
});
for(const fault of ['late','interrupt','duplicate','window','stage'])test(fault+' cannot publish a partial transaction window or advance state',async()=>{
 const f=fixture(fault),r=await collectReviewedPlan({...f,project:'fixture',apply:true,env:{LOYALTYLION_COLLECTION_ENABLED:'true'}});
 assert.equal(r.complete,false);assert.equal(r.guard_status,'released');assert(!f.queries.some(q=>q.labels?.operation==='promote'));
});
test('uncertain publication retains guard; no automatic release or replay',async()=>{
 const f=fixture('commit'),r=await collectReviewedPlan({...f,project:'fixture',apply:true,env:{LOYALTYLION_COLLECTION_ENABLED:'true'}});
 assert.equal(r.guard_status,'retained_commit_unknown');assert.equal(r.resources[0].publication_submitted,true);assert(!f.queries.some(q=>q.labels?.operation==='release'));
});
test('complete coverage intervals resume at first gap, not at highest watermark',()=>{
 const c=reviewedConfig();assert.throws(()=>historyPlan(c,{...plan,status:'proposed'}));assert.throws(()=>historyPlan(c,{...plan,transaction_staging:{...profile,max_calls:301}}));
 const coverage=[{resource:'transactions',status:'complete',start_at:plan.start_at,end_exclusive:'2026-10-03T00:00:00Z'},{resource:'transactions',status:'complete',start_at:'2026-10-05T00:00:00Z',end_exclusive:plan.end_exclusive}];
 assert.deepEqual(nextHistoryWindow(plan,coverage),{start_at:'2026-10-03T00:00:00.000Z',end_exclusive:'2026-10-05T00:00:00.000Z'});
 assert.equal(nextHistoryWindow(plan,[...coverage,{resource:'transactions',status:'complete',start_at:'2026-10-03T00:00:00Z',end_exclusive:'2026-10-05T00:00:00Z'}]),null);
});
test('bounded preview handles large population without writes; incremental requires reviewed enable and complete history',async()=>{
 const f=fixture(),r=await previewHistory({...f,plan,resource:'transactions',window});assert.equal(r.rows,12050);assert.equal(r.warehouse_writes,false);assert.equal(f.queries.length,0);
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>[q.labels.operation==='guard'?[{guard_rows:1,held_guards:0}]:[]]};
 await assert.rejects(runHistory({config:f.config,plan,bigquery,project:'fixture',mode:'incremental',clientFactory:()=>assert.fail('No source reads')}),{code:'LOYALTY_HISTORY_OR_INCREMENTAL_NOT_READY'});
 assert.doesNotMatch(promotionSql('fixture','loyaltylion','transactions','_points','_claims'),/TRUNCATE|DELETE/);
});
