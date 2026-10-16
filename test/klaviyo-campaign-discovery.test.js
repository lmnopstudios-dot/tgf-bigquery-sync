import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignSendMetadata,collectMetadata } from '../klaviyo/metadata.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { campaignDiscoveryLimitation } from '../klaviyo/campaign-discovery.js';
import { selectSentEntities } from '../oracle/entity-relative-scope.js';
const cutoff='2026-10-16T12:00:00Z';
const resource=(id,status='Sent',extra={})=>({type:'campaign',id,attributes:{name:id,status,send_time:'2026-10-15T09:00:00Z',send_strategy:{method:'static'},...extra},relationships:{'campaign-messages':{data:[{id:id+'-ab'},{id:id+'-resend'}]}}});
const env={KLAVIYO_PRIVATE_API_KEY:'fixture-key',KLAVIYO_API_REVISION:'2026-07-15'};
function dependencies(pages){
 const calls=[],queries=[];
 const provider=createOracleProviderDependencies({env,project:'fixture',bigquery:{dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{queries.push(q);return [[{reporting_cutoff:'2026-10-16'}]];}},klaviyoFetch:async(url,options)=>{calls.push({url,method:options.method});const payload=pages[Math.min(calls.length-1,pages.length-1)];return {ok:true,status:200,json:async()=>payload};}}).klaviyo;
 return {provider,calls,queries};
}
test('collector and read-only discovery share conservative actual send semantics',async()=>{
 const sent=resource('sent');
 assert.equal(campaignSendMetadata(sent.attributes).send_time_semantics,'actual campaign send timestamp');
 assert.equal(campaignSendMetadata({...sent.attributes,send_strategy:{method:'immediate'}}).send_time_semantics,'actual campaign send timestamp');
 for(const extra of [{send_time:null},{send_time:'invalid'},{send_strategy:{method:'smart_send_time'}},{send_strategy:{method:'static',options_static:{is_local:true}}},{status:'Scheduled'},{status:'Draft'},{status:'Cancelled'}])
   assert.equal(campaignSendMetadata({...sent.attributes,...extra}).send_time_semantics,'actual send timestamp unavailable');
 const rows=await collectMetadata({client:{paginate:async path=>({data:path.includes('campaigns')?[sent]:[],included:[]})}});
 assert.equal(rows[0].send_time_semantics,'actual campaign send timestamp');
 assert.equal(rows.length,1);
});
test('pagination discovers all candidates; parent identities collapse messages and ignore creation/revenue ordering',async()=>{
 const f=dependencies([{data:[resource('draft','Draft'),resource('old','Sent',{send_time:'2026-10-01T09:00:00Z',created_at:'2026-10-16'})],links:{next:'https://a.klaviyo.com/api/campaigns?page[cursor]=2'}},{data:[resource('new'),resource('scheduled','Scheduled'),resource('ongoing','Sending'),resource('cancelled','Cancelled')],links:{next:null}}]);
 const listing=await f.provider.resolveCampaigns({cutoff});
 assert.equal(listing.complete,true);assert.equal(f.calls.length,2);
 assert.ok(f.calls.every(c=>c.method==='GET'));
 const result=selectSentEntities(listing.candidates,{count:3,cutoff});
 assert.deepEqual(result.selected.map(c=>c.entity_id),['new','ongoing','old']);
 assert.equal(result.selected[1].status,'Sending');
 assert.ok(result.selected.every(c=>c.account==='production'&&c.channel==='email'&&c.reporting_cutoff==='2026-10-16'));
 assert.ok(f.queries.every(q=>q.maximumBytesBilled===1_000_000_000));
});
test('missing actual time cannot silently produce a successful latest selection',async()=>{
 const f=dependencies([{data:[resource('valid'),resource('unknown','Sent',{send_time:null})]}]);
 const listing=await f.provider.resolveCampaigns({cutoff});
 assert.equal(selectSentEntities(listing.candidates,{count:1,cutoff}).blocker,'missing_send_metadata');
});
test('incomplete discovery fails closed at page bound without partial ranking',async()=>{
 const f=dependencies([{data:[],links:{next:'/api/campaigns?page[cursor]=loop'}}]);
 await assert.rejects(f.provider.resolveCampaigns({cutoff}),{code:'PAGINATION_BOUND'});
 assert.equal(f.calls.length,20);assert.equal(f.queries.length,0);
});

test('access failures explain the missing read capability without exposing exceptions',async()=>{
 const f=createOracleProviderDependencies({env,project:'fixture',bigquery:{},klaviyoFetch:async()=>({ok:false,status:403,json:async()=>({errors:[{code:'permission_denied',detail:'private account information'}]})})}).klaviyo;
 let failure;try{await f.resolveCampaigns({cutoff});}catch(error){failure=error;}
 assert.equal(failure.status,403);
 const answer=campaignDiscoveryLimitation(failure);
 assert.match(answer,/Campaign read access/);assert.doesNotMatch(answer,/permission_denied|private account/);
});
test('discovery remains available when warehouse coverage access fails',async()=>{
 const f=createOracleProviderDependencies({env,project:'fixture',bigquery:{dataset:()=>({getMetadata:async()=>{throw Object.assign(Error('private'),{code:403});}})},klaviyoFetch:async()=>({ok:true,status:200,json:async()=>({data:[resource('new')]})})}).klaviyo;
 const listing=await f.resolveCampaigns({cutoff});
 assert.equal(listing.candidates[0].entity_id,'new');assert.equal(listing.candidates[0].reporting_cutoff,null);
});
