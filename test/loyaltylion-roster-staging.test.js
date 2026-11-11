import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoyaltyClient} from '../loyaltylion/client.js';
import {collectReviewedPlan,previewRoster,promotionSql} from '../loyaltylion/sync.js';
import {rosterStagingPlan} from '../loyaltylion/contracts.js';
import {reviewedConfig} from './helpers/loyalty-fixture.js';
const profile={reviewed_by:'fixture',reviewed_at:'2026-11-11T00:00:00Z',
 max_rows:100000,max_pages:250,max_calls:300,max_ms:900000,max_bytes:64000000,page_bytes:2000000};
function fixture(fault){
 const config=reviewedConfig();config.roster_staging=profile;
 const customer=id=>({id,merchant_id:String(id),enrolled:true,guest:false,blocked:false,
   points_approved:0,points_pending:0,points_spent:0,updated_at:'2026-11-01T00:00:00Z'});
 let clock=0,staged=0,published=0,failPage=22;
 const writes=[];
 const client=createLoyaltyClient({key:'fixture',limits:{...config.limits,max_calls:300,max_ms:900000},
  now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async url=>{
   const u=new URL(url),path=u.pathname.split('/').pop();
   let body;
   if(path==='whoami')body={identity:{program_id:config.program_id,account_id:config.account_id,scopes:['read_customers','read_orders']}};
   if(path==='sites')body={sites:[{id:config.site_id,program_id:config.program_id,platform:'shopify',url:config.site_url}]};
   if(path==='customers'){
    const page=Number(u.searchParams.get('cursor')||0);
    if(fault==='late'&&page===failPage)throw Error('private payload');
    if(fault==='interrupt'&&page===failPage)throw Object.assign(Error('abort'),{name:'AbortError'});
    const start=page*500,end=Math.min(start+500,12050);
    body={customers:Array.from({length:end-start},(_,i)=>customer(fault==='duplicate'&&page===2&&i===0?1:start+i+1)),
      cursor:{next:end===12050?null:String(page+1)}};
   }
   if(path==='transactions')body={transactions:[],cursor:{next:null}};
   return {ok:true,status:200,json:async()=>body};
  }});
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}],
  table:()=>({exists:async()=>[true],getMetadata:async()=>[{}]})}),
  query:async q=>{
   writes.push(q);
   if(q.query.startsWith('INSERT INTO'))staged+=JSON.parse(q.params.rows).length;
   if(q.labels?.operation==='promote'){assert.equal(q.params.row_count,q.params.resource==='customers'?staged:0);published++;}
   return [[]];
  }};
 return {config,client,bigquery,writes,stats:()=>({staged,published})};
}
test('12050 customers are staged pagewise, then atomically promoted, without whole-roster payload',async()=>{
 const f=fixture(),progress=[];
 const r=await collectReviewedPlan({...f,project:'fixture',apply:true,env:{LOYALTYLION_COLLECTION_ENABLED:'true'},onProgress:x=>progress.push(x)});
 assert.equal(r.complete,true);assert.equal(r.resources[0].rows,12050);
 assert.equal(f.stats().staged,12050);assert.equal(f.stats().published,2);
 assert.ok(progress.some(x=>x.pages===25&&x.rows===12050));
 const promote=f.writes.find(q=>q.labels?.operation==='promote');
 assert.equal(promote.params.rows,'[]');
 assert.match(promote.query,/SELECT \* FROM .*_loyalty_roster_/);
 assert.match(promote.query,/COUNT\(DISTINCT customer_ref_id\)/);
 assert.match(promote.query,/INSERT INTO .*coverage_windows/);
 assert.ok(f.writes.some(q=>/INTERVAL 24 HOUR/.test(q.query)));
});
for(const fault of ['late','duplicate','interrupt'])test(fault+' failure leaves previous complete roster and coverage unchanged',async()=>{
 const f=fixture(fault);
 const r=await collectReviewedPlan({...f,project:'fixture',apply:true,env:{LOYALTYLION_COLLECTION_ENABLED:'true'}});
 assert.equal(r.complete,false);assert.equal(r.guard_status,'released');
 assert.equal(r.resources[1].status,'not_attempted_after_resource_failure');
 assert.equal(f.stats().published,0);assert.ok(f.stats().staged>0);
});
test('preview validates over 10000 customers without warehouse access; profile is explicit',async()=>{
 const f=fixture(),r=await previewRoster({...f});
 assert.equal(r.rows,12050);assert.equal(r.warehouse_writes,false);assert.equal(f.writes.length,0);
 assert.throws(()=>rosterStagingPlan({...f.config,roster_staging:{...profile,reviewed_by:null}}),{code:'LOYALTY_STAGING_PLAN_NOT_REVIEWED'});
 assert.throws(()=>rosterStagingPlan({...f.config,roster_staging:{...profile,max_rows:100001}}),{code:'LOYALTY_STAGING_BOUNDS'});
 assert.doesNotMatch(promotionSql('fixture','loyaltylion','transactions'),/\$\{transaction/);
});
