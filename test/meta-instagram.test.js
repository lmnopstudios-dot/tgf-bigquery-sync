import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMetaConfig,contractId} from '../meta/config.js';
import {MetaClient} from '../meta/client.js';
import {adsParams,normalizeAds} from '../meta/ads.js';
import {planAds,collectAds,collectInstagram} from '../meta/collect.js';
import {MetaStore} from '../meta/storage.js';
import {governedMetaRun} from '../meta/governance.js';
import {probeMetric,metricObservations} from '../instagram/collect.js';
import {createMetaInstagramService,metaPerformanceQuery,instagramPerformanceQuery,coverageFor} from '../oracle/meta-instagram.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {createBaselineOverviewService} from '../oracle/baseline-overview.js';
import {dispatchAnalysisRequest,executeGovernedAgentAnalysis,assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {createMemoryExportStore} from '../oracle/product-priority-storage.js';
const account={account_id:'123',display_name:'UK Meta',collection_status:'active',timezone:'Europe/London',currency:'GBP',token_env:'META_TEST_TOKEN',history_start:'2024-01-01',action_report_time:'conversion',purchase_action_type:'omni_purchase',refresh_days:35};
const config=loadMetaConfig({META_API_VERSION:'v25.0',META_AD_ACCOUNTS_JSON:JSON.stringify([account])});
const raw={account_id:'123',account_name:'UK Meta',campaign_id:'10',campaign_name:'Campaign',adset_id:'11',adset_name:'Ad set',ad_id:'12',ad_name:'Ad',date_start:'2024-01-01',date_stop:'2024-01-01',spend:'10.20',impressions:'100',clicks:'5',inline_link_clicks:'3',actions:[{action_type:'omni_purchase',value:'2'},{action_type:'purchase',value:'2'},{action_type:'offsite_conversion.fb_pixel_purchase',value:'2'},{action_type:'landing_page_view',value:'1'}],action_values:[{action_type:'omni_purchase',value:'50'},{action_type:'purchase',value:'50'}]};
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers});
const client=(fetchImpl,opts={})=>new MetaClient({apiVersion:'v25.0',token:'sentinel-secret',fetchImpl,sleep:async()=>{},...opts});
const ctx={config,account:config.accounts[0],start:'2024-01-01',end:'2024-01-01',grain:'base',observedAt:'2026-10-06T01:00:00Z'};
function memoryStore(){const checkpoints=new Map(),writes=[],failures=[];const key=c=>[c.account.account_id,c.start,c.end,c.grain,c.contract].join('|');return {checkpoints,writes,failures,ensure:async()=>{},checkpoint:async c=>checkpoints.get(key(c)),saveJob:async(c,id)=>checkpoints.set(key(c),{status:'pending',job_id:id}),promote:async(c,t)=>{writes.push({ctx:c,tables:t});checkpoints.set(key(c),{status:'complete'});return {account_id:c.account.account_id,start:c.start,end:c.end,grain:c.grain};},failure:async(c,e)=>failures.push({ctx:c,code:e.code})};}

test('explicit Meta scope/version and real dates; never infer accounts from Google Ads',()=>{
 assert.throws(()=>loadMetaConfig({GOOGLE_ADS_ACCOUNTS_JSON:'[]'}),/META_API_VERSION/);
 assert.throws(()=>planAds(config,{start:'2024-02-30',end:'2024-03-01',accountIds:['123']}));
 assert.throws(()=>planAds(config,{start:'2024-01-01',end:'2024-01-02'}),/explicit/);
 assert.throws(()=>planAds(config,{start:'2024-01-01',end:'2024-01-02',accountIds:['999']}),/Unknown/);
 assert.notEqual(contractId(config,config.accounts[0]),contractId({...config,api_version:'v26.0'},config.accounts[0]));
});
test('pagination retains query, uses opaque cursors and never follows token-bearing next URLs',async()=>{
 const urls=[];const c=client(async(url,options)=>{urls.push(String(url));assert.equal(options.headers.Authorization,'Bearer sentinel-secret');return response(urls.length===1?{data:[{id:'1'}],paging:{next:'https://evil.test/?access_token=secret',cursors:{after:'cursor-one'}}}:{data:[{id:'2'}]});});
 assert.deepEqual(await c.pages('123/media',{fields:'id'}),[{id:'1'},{id:'2'}]);assert.match(urls[1],/after=cursor-one/);assert.match(urls[1],/fields=id/);assert.doesNotMatch(urls.join(''),/sentinel|evil/);
});
test('failed last page and cursor loops are incomplete, never empty evidence',async()=>{
 let n=0;await assert.rejects(client(async()=>++n===1?response({data:[raw],paging:{next:'x',cursors:{after:'a'}}}):response({error:{code:190,message:'secret token detail'}},400)).pages('123/media'),e=>e.code==='TOKEN_EXPIRED_OR_INVALID'&&!e.message.includes('secret'));
 await assert.rejects(client(async()=>response({data:[],paging:{next:'x',cursors:{after:'a'}}})).pages('123/media'),e=>e.code==='INVALID_PAGINATION');
});
test('bounded rate-limit retry honors delay, permission/token errors are terminal and sanitized',async()=>{
 let n=0;const delays=[];const c=client(async()=>++n===1?response({error:{code:4}},429,{'retry-after':'2'}):response({data:[]}),{sleep:async ms=>delays.push(ms)});await c.pages('123/media');assert.deepEqual(delays,[2000]);
 n=0;await assert.rejects(client(async()=>{n++;return response({error:{code:200,message:'token sentinel-secret'}},403)}).request('123'),e=>e.code==='PERMISSION_DENIED'&&!e.message.includes('sentinel'));assert.equal(n,1);
 await assert.rejects(client(async()=>response({error:{code:4}},429),{maxRetries:1}).request('123'),e=>e.code==='RETRIES_EXHAUSTED');
 await assert.rejects(client(async()=>response({data:[]}),{deadlineAt:0}).request('123'),e=>e.code==='COLLECTION_DEADLINE');
 await assert.rejects(c.request('123','x','POST'),/mutation prohibited/);
});
test('async completion saves job before polling; pending jobs resume without another creation',async()=>{
 const methods=[],paths=[],saved=[];const c=client(async(url,options)=>{methods.push(options.method);paths.push(new URL(url).pathname);if(options.method==='POST')return response({report_run_id:'987'});if(String(url).includes('/987/insights'))return response({data:[raw]});return response({async_status:methods.length===2?'Job Running':'Job Completed'});});
 assert.deepEqual(await c.insights('123',adsParams(config.accounts[0],ctx.start,ctx.end),{saveJob:async id=>saved.push(id)}),[raw]);assert.deepEqual(saved,['987']);assert.equal(methods.filter(m=>m==='POST').length,1);
 const resumed=client(async url=>String(url).includes('/insights')?response({data:[]}):response({async_status:'Job Completed'}));assert.deepEqual(await resumed.insights('123',{}, {jobId:'987'}),[]);assert.equal(resumed.calls,2);
 const pending=client(async()=>response({async_status:'Job Running'}));await assert.rejects(pending.insights('123',{}, {jobId:'987',maxPolls:1}),e=>e.code==='ASYNC_REPORT_PENDING'&&e.job_id==='987');
});
test('selected purchase action cannot double-count synonyms; raw actions and attribution contract retained',()=>{
 const [row]=normalizeAds([raw],ctx);assert.equal(row.purchase_count,'2');assert.equal(row.purchase_value,'50');assert.equal(JSON.parse(row.actions_json).length,4);assert.equal(row.spend,'10.20');assert.equal(row.currency,'GBP');assert.match(row.attribution_json,/historical_settings_verified/);
 assert.equal(normalizeAds([{...raw,actions:undefined}],ctx)[0].purchase_count,null);
 assert.throws(()=>normalizeAds([{...raw,date_stop:'2024-01-02'}],ctx),/daily/);
 assert.throws(()=>normalizeAds([raw,raw],ctx),/Duplicate/);
 assert.notEqual(row.attribution_contract_id,normalizeAds([raw],{...ctx,account:{...ctx.account,purchase_action_type:'purchase'}})[0].attribution_contract_id);
});
test('scheduled windows use each account-local completed day and fail when budgets omit active accounts',()=>{
 const multi={...config,accounts:[{...config.accounts[0],timezone:'Asia/Tokyo',account_id:'1'},{...config.accounts[0],timezone:'America/Los_Angeles',account_id:'2',currency:'USD'},{...config.accounts[0],collection_status:'historical_only',account_id:'3'}]};
 const plan=planAds(multi,{scheduled:true,now:new Date('2026-10-06T00:30:00Z'),maxWindows:100});assert.equal(plan.windows.filter(w=>w.account.account_id==='1').at(-1).end,'2026-10-05');assert.equal(plan.windows.filter(w=>w.account.account_id==='2').at(-1).end,'2026-10-04');assert.equal(plan.windows.filter(w=>w.account.account_id==='3').length,0);
 assert.throws(()=>planAds(multi,{scheduled:true,maxWindows:1}),/budget/);
 const bounded=planAds(config,{start:'2024-01-01',end:'2024-01-31',accountIds:['123'],maxWindows:1});assert.equal(bounded.remaining_windows,4);
});
test('partial breakdown failure retains base, resumes pending report and revisions replace windows',async()=>{
 const store=memoryStore(),plan=planAds(config,{start:ctx.start,end:ctx.end,accountIds:['123']});let fail=true,created=0;
 const factory=()=>({request:async()=>({account_id:'123',currency:'GBP',timezone_name:'Europe/London'}),pages:async()=>[],insights:async(_id,p,o)=>{if(!o.jobId){created++;await o.saveJob(String(created));}if(p.breakdowns==='country'&&fail)throw Object.assign(new Error('private'),{code:'TOKEN_EXPIRED_OR_INVALID'});return [{...raw,...(p.breakdowns==='country'?{country:'GB'}:p.breakdowns?.includes('publisher_platform')?{publisher_platform:'instagram',platform_position:'feed'}:p.breakdowns==='impression_device'?{impression_device:'mobile'}:{})}];}});
 await assert.rejects(collectAds({config,plan,store,clientFactory:factory}),e=>e.code==='META_PARTIAL_FAILURE');assert.equal(store.writes.length,1);assert.equal(store.writes[0].ctx.grain,'base');assert.equal(store.failures[0].ctx.grain,'country');
 fail=false;const result=await collectAds({config,plan,store,clientFactory:factory});assert.equal(result.results[0].resumed,true);assert.equal(store.writes.length,4);assert.equal(created,4);
 await collectAds({config,plan,store,clientFactory:factory,refresh:true});assert.equal(store.writes.length,8);assert.deepEqual(store.writes[4].tables.ad_daily[0].purchase_count,'2');
});
test('warehouse promotion loads all stages before atomic delete/insert/coverage and cleans failed loads',async()=>{
 const calls=[],deleted=[],bq={query:async options=>{calls.push(options);return [[]]},dataset:()=>({table:name=>({create:async()=>{},load:async()=>{},delete:async()=>deleted.push(name)})})},store=new MetaStore({bigquery:bq,project:'fixture'}),c={source:'meta_ads',account:ctx.account,start:ctx.start,end:ctx.end,grain:'base',contract:'contract',runId:'r'};
 await store.promote(c,{ad_daily:normalizeAds([raw],ctx)});assert.equal(calls.length,1);assert.match(calls[0].query,/BEGIN TRANSACTION/);assert.match(calls[0].query,/INSERT INTO `fixture.meta.coverage`/);assert.equal(calls[0].types.observedAt,'TIMESTAMP');assert.equal(deleted.length,1);
 bq.dataset=()=>({table:()=>({create:async()=>{},load:async()=>{throw new Error('load failed')},delete:async()=>deleted.push('failed')})});await assert.rejects(store.promote(c,{ad_daily:normalizeAds([raw],ctx)}),/load failed/);assert.equal(calls.length,1);assert.equal(deleted.at(-1),'failed');
});
test('manual and scheduled work share existing warehouse overlap protection and sanitize failures',async()=>{
 const calls=[],bq={query:async o=>{calls.push(o);if(o.query.includes('ASSERT NOT EXISTS'))throw new Error('collector already running');return [[]]}};let ran=false;
 await assert.rejects(governedMetaRun({bigquery:bq,project:'fixture',source:'meta_ads',run:async()=>{ran=true}}),e=>e.stage==='lock_acquisition');assert.equal(ran,false);assert.deepEqual(calls.find(o=>o.query.includes('ASSERT NOT EXISTS')).params.source,'meta_ads');
 bq.query=async o=>{calls.push(o);return [[{run_id:'r'}]]};await assert.rejects(governedMetaRun({bigquery:bq,project:'fixture',source:'instagram',run:async()=>{throw Object.assign(new Error('sentinel-secret'),{code:'TOKEN_EXPIRED'})}}));const failure=calls.findLast(o=>o.params?.error);assert.equal(failure.params.error,'TOKEN_EXPIRED');assert.doesNotMatch(JSON.stringify(failure),/sentinel/);
});
test('Instagram capability mismatch is recorded while auth/transport failures remain failures',async()=>{
 const p={metric:'views',period:'lifetime',metric_type:'total_value',evidence_kind:'lifetime_total',breakdown:null};
 const unsupported=await probeMetric({pages:async()=>{throw Object.assign(new Error('deprecated'),{code:'UNSUPPORTED_REQUEST'})}},'123',p,{start:ctx.start,end:ctx.end},true);assert.equal(unsupported.availability,'unsupported_or_unavailable');
 await assert.rejects(probeMetric({pages:async()=>{throw Object.assign(new Error('expired'),{code:'TOKEN_EXPIRED_OR_INVALID'})}},'123',p,{start:ctx.start,end:ctx.end},true));
 const rows=metricObservations({profile:p,key:'views|lifetime',availability:'available',rows:[{name:'views',period:'lifetime',description:'Native plays or displays',values:[{value:40}]}]},{account:ctx.account,resource:'77',media:{media_type:'VIDEO',media_product_type:'REELS',timestamp:'2024-01-01T00:00:00Z'},window:{start:ctx.start,end:ctx.end},observedAt:ctx.observedAt,apiVersion:config.api_version});assert.equal(rows[0].evidence_kind,'lifetime_total');assert.equal(rows[0].report_date,null);assert.equal(rows[0].paid_organic_scope,'native_scope_unverified');assert.equal(rows[0].value,'40');
});
test('Instagram never backfills expired historical periods or treats lifetime totals as daily followers',async()=>{
 const ig={...account,auth_path:'facebook_login',account_profiles:[],media_profiles:{},history_days:1};
 await assert.rejects(collectInstagram({config:{...config,instagram:[ig]},accountIds:['123'],start:'2024-01-01',end:'2024-01-02',now:()=>new Date('2026-10-06T12:00:00Z'),store:memoryStore(),clientFactory:()=>{throw new Error('must not call')}}),/last 90 days/);
});
test('provider separates breakdowns/contracts, recomputes ratios from numerators and never sums reach/frequency',async()=>{
 const sql=metaPerformanceQuery('fixture',{group_by:'campaign',breakdown:'placement',sort_metric:'cpa',sort_direction:'asc'});assert.match(sql,/meta.placement_daily/);assert.doesNotMatch(sql,/ad_daily|UNION|SUM\(reach\)|AVG\(/);assert.match(sql,/currency,reporting_timezone,purchase_action_type/);assert.match(sql,/attribution_contract_id/);assert.match(sql,/SAFE_DIVIDE\(spend,purchase_count\)/);assert.match(sql,/COUNTIF\(purchase_count IS NULL\)/);
 assert.match(instagramPerformanceQuery('fixture',{scope:'media',metric:'saved'}),/DATE\(publication_at/);assert.match(instagramPerformanceQuery('fixture',{scope:'media',metric:'saved'}),/ORDER BY observed_at DESC/);assert.doesNotMatch(instagramPerformanceQuery('fixture',{scope:'account',metric:'reach'}),/SUM\(/);
 const service=createMetaInstagramService({project:'fixture',bigquery:{query:async()=>{throw new Error('private SQL secret')}}});await assert.rejects(service('get_meta_performance',{start_date:ctx.start,end_date:ctx.end,account_id:null,limit:100,group_by:'account',breakdown:'base',sort_metric:'spend',sort_direction:'desc'}),e=>e.code==='META_RETRIEVAL_FAILED'&&!e.message.includes('private'));
 assert.equal(coverageFor([{account_id:'123',status:'collected',window_start:'2024-01-01',window_end:'2024-01-02'},{account_id:'123',status:'collected',window_start:'2024-01-04',window_end:'2024-01-05'}],'2024-01-01','2024-01-05').complete,false);
});
const now=()=>new Date('2026-10-06T12:00:00Z');
function oracleFixture(){const calls=[],bigquery={query:async o=>{calls.push(o);if(o.query.includes('meta.coverage'))return [[{source:'meta_ads',account_id:'123',status:'collected',window_start:o.params.start.value,window_end:o.params.end.value}]];return [[{account_id:'123',account_name:'UK Meta',currency:'GBP',campaign_id:'10',campaign_name:'Campaign',spend:'10',purchase_count:'2',purchase_value:'50',cpa:'5',roas:'5',attribution_contract_id:'same',observed_at:'2026-10-06'}]];}};const deps=createOracleProviderDependencies({bigquery,project:'fixture',env:{}}),exports=createMemoryExportStore(),baseline=createBaselineOverviewService({social:deps.social,socialExportStore:exports,now});return {calls,exports,baseline};}
test('shared dependency, direct agent and dispatch retain scoped follow-ups and produce shared presentation/charts',async()=>{
 const f=oracleFixture();let context=transitionAnalysisContext({},'How did Meta ads perform last month?',{now:+now()}).context;assert.equal(context.tool_route,'get_meta_performance');assert.equal(context.start_date,'2026-09-01');
 const direct=await executeGovernedAgentAnalysis({message:'How did Meta ads perform last month?',analysisContext:context,scopeResolved:true,baselineOverview:f.baseline});assert.equal(direct.evidence.subject,'meta_ads');assert.match(direct.answer,/Show details/);assert.ok(direct.charts.length);
 context=transitionAnalysisContext(context,'Which ads had the lowest purchase CPA?',{now:+now()}).context;assert.equal(context.social_scope.group_by,'ad');assert.equal(context.social_scope.metric,'cpa');assert.equal(context.social_scope.sort_direction,'asc');assert.equal(context.start_date,'2026-09-01');
 context=transitionAnalysisContext(context,'Break that down by Instagram versus Facebook placements.',{now:+now()}).context;assert.equal(context.requested_subject,'meta_ads');assert.equal(context.social_scope.breakdown,'placement');
 const answer=await dispatchAnalysisRequest({message:'placements',analysisContext:context,baselineOverview:f.baseline,chat:async()=>{throw new Error('fallback forbidden')}});assert.match(f.calls.at(-2).query,/placement_daily/);assert.match(answer.answer,/Attributed purchases/);
 const ig=transitionAnalysisContext(context,'Which Instagram posts got the most saves this year?',{now:+now()}).context;assert.equal(ig.requested_subject,'instagram');assert.equal(ig.social_scope.metric,'saved');assert.equal(ig.social_scope.breakdown,null);assert.equal(ig.start_date,'2026-01-01');
 assert.throws(()=>assertEvidenceAgreement(ig,answer.evidence),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
test('compatible comparisons retrieve exact periods independently; workbook persists with ownership and recovers',async()=>{
 const f=oracleFixture(),base=transitionAnalysisContext({},'Meta ads last month',{now:+now()}).context,comparison=transitionAnalysisContext(base,'What changed between August and September?',{now:+now()}).context;
 const answer=await dispatchAnalysisRequest({message:'comparison',analysisContext:comparison,baselineOverview:f.baseline});assert.deepEqual(answer.evidence.periods,[{start_date:'2026-09-01',end_date:'2026-09-30'},{start_date:'2026-08-01',end_date:'2026-08-31'}]);assert.equal(answer.evidence.comparison_compatible,true);assert.ok(answer.charts.length);
 const exportContext=transitionAnalysisContext(base,'Export campaign spend and attributed revenue by month',{now:+now()}).context;
 const exported=await dispatchAnalysisRequest({message:'export',analysisContext:exportContext,baselineOverview:f.baseline,baselineOptions:{exportOwner:'owner',requestId:'request'}});assert.equal(exported.artifact.filename,'oracle-meta-evidence.xlsx');const saved=await f.exports.get(exported.artifact.id,'owner');assert.ok(Buffer.from(saved.xlsx_base64,'base64').length>1000);assert.equal(await f.exports.get(exported.artifact.id,'stranger'),null);
 const recovered=await dispatchAnalysisRequest({message:'export',analysisContext:exportContext,baselineOverview:f.baseline,baselineOptions:{exportOwner:'owner',requestId:'request'}});assert.equal(recovered.artifact.id,exported.artifact.id);assert.deepEqual(recovered.evidence.rows,exported.evidence.rows);
});

test('cross-source singleton lock rejects overlap before source run ledgers execute',async()=>{
 let locked=false,entered=0,unlock;const wait=new Promise(resolve=>unlock=resolve),bq={query:async o=>{if(o.query.includes('SET owner=@runId')){if(locked)throw new Error('transaction conflict');locked=true;}if(o.query.includes('SET owner=NULL'))locked=false;return [[{run_id:'r'}]];}};
 const first=governedMetaRun({bigquery:bq,project:'fixture',source:'meta_ads',run:async()=>{entered++;await wait;return {results:[]}}});
 while(!entered)await new Promise(r=>setTimeout(r,1));await assert.rejects(governedMetaRun({bigquery:bq,project:'fixture',source:'instagram',run:async()=>{entered++}}),/transaction conflict/);assert.equal(entered,1);unlock();await first;assert.equal(locked,false);
});

test('complete Instagram native snapshot retains carousel/Reel/Story metadata, followers and per-type availability',async()=>{
 const p={metric:'saved',period:'lifetime',metric_type:'time_series',evidence_kind:'lifetime_total',breakdown:null},a={...account,auth_path:'facebook_login',account_profiles:[{metric:'reach',period:'day',metric_type:'time_series',evidence_kind:'historical_daily',breakdown:null}],media_profiles:{CAROUSEL_ALBUM:[p],REELS:[p],STORY:[p]},history_days:1},store=memoryStore();
 const calls=[],c={request:async()=>({id:'123',username:'business_fixture',followers_count:200}),pages:async(path,params)=>{calls.push({path,params});if(path==='123/media')return [{id:'501',media_type:'CAROUSEL_ALBUM',timestamp:'2024-02-01T12:00:00Z',permalink:'https://www.instagram.com/p/example/',children:{data:[{id:'child'}]}},{id:'502',media_type:'VIDEO',media_product_type:'REELS',timestamp:'2024-03-01T12:00:00Z'}];if(path==='123/stories')return [{id:'503',media_type:'IMAGE',timestamp:'2026-10-06T11:00:00Z'}];if(path==='503/insights')throw Object.assign(new Error('incompatible'),{code:'UNSUPPORTED_REQUEST'});return [{name:params.metric,period:params.period,description:'Native description',values:[{value:3,...(path==='123/insights'?{end_time:'2026-10-05T23:00:00Z'}:{})}]}];}};
 await collectInstagram({config:{...config,instagram:[a]},store,clientFactory:()=>c,accountIds:['123'],now});
 const t=store.writes[0].tables;assert.equal(t.instagram_media.length,3);assert.equal(t.instagram_media[0].media_type,'CAROUSEL_ALBUM');assert.deepEqual(JSON.parse(t.instagram_media[0].metadata_json).children.data,[{id:'child'}]);assert.equal(t.instagram_observations.find(r=>r.metric==='followers_count').report_date,null);assert.equal(t.instagram_observations.find(r=>r.media_type==='REELS').evidence_kind,'lifetime_total');assert.equal(t.instagram_observations.find(r=>r.media_type==='STORY').availability,'unsupported_or_unavailable');assert.equal(t.instagram_observations.find(r=>r.metric==='reach').report_date,'2026-10-05');assert.doesNotMatch(calls.map(c=>c.path).join(','),/messages|audience\/users/);
});

test('unsupported secondary breakdown does not block base history and failed async jobs can be recreated',async()=>{
 const store=memoryStore(),plan=planAds(config,{start:ctx.start,end:ctx.end,accountIds:['123']}),reset=[];store.resetJob=async c=>reset.push(c.grain);let fail=false;
 const factory=()=>({request:async()=>({account_id:'123',currency:'GBP',timezone_name:'Europe/London'}),pages:async()=>[],insights:async(_id,p)=>{if(fail)throw Object.assign(new Error('async'),{code:'ASYNC_REPORT_FAILED'});if(p.breakdowns==='country')throw Object.assign(new Error('unsupported'),{code:'UNSUPPORTED_REQUEST'});return []}});
 const result=await collectAds({config,plan,store,clientFactory:factory});assert.equal(result.results[1].status,'unsupported');assert.equal(result.results[0].grain,'base');assert.equal(store.writes.length,3);
 fail=true;await assert.rejects(collectAds({config,plan,store,clientFactory:factory,refresh:true}),e=>e.code==='META_PARTIAL_FAILURE');assert.deepEqual(reset,['base']);
});

test('reviewed audience timeframe and local DST boundaries are sent without invented daily evidence',async()=>{
 const {localMidnightSeconds}=await import('../meta/config.js');const {metricParams}=await import('../instagram/collect.js');
 assert.equal(localMidnightSeconds('2026-10-05','Europe/London'),Date.parse('2026-10-04T23:00:00Z')/1000);assert.equal(localMidnightSeconds('2026-01-05','Europe/London'),Date.parse('2026-01-05T00:00:00Z')/1000);
 const p={metric:'follower_demographics',period:'lifetime',metric_type:'total_value',evidence_kind:'audience_snapshot',breakdown:'country',timeframe:'last_30_days'},params=metricParams(p,{start:ctx.start,end:ctx.end});assert.equal(params.timeframe,'last_30_days');assert.equal(params.since,undefined);assert.equal(params.breakdown,'country');
 const rows=metricObservations({profile:p,key:'audience',availability:'available',rows:[{name:p.metric,period:p.period,total_value:{breakdowns:[{dimension_keys:['country'],results:[{dimension_values:['GB'],value:80}]}]}}]},{account:ctx.account,resource:'123',window:{start:ctx.start,end:ctx.end},observedAt:ctx.observedAt,apiVersion:config.api_version});assert.equal(rows[0].evidence_kind,'audience_snapshot');assert.equal(rows[0].value,null);assert.equal(rows[0].report_date,null);assert.match(rows[0].breakdown_json,/GB/);
});

test('period reach/frequency requests return their limitation without spending queries or retaining spend reports',async()=>{
 const service=createMetaInstagramService({project:'fixture',env:{},bigquery:{query:async()=>{throw new Error('must not query')}}}),context=transitionAnalysisContext({},'Show Meta ads reach last month',{now:+now()}).context;
 assert.equal(context.social_scope.metric,'reach');const result=await service('get_meta_performance',{start_date:context.start_date,end_date:context.end_date,account_id:null,limit:100,sort_metric:'reach'});assert.equal(result.unsupported_metric,'reach');assert.deepEqual(result.rows,[]);assert.match(result.limitations[0],/cannot establish/);
 const failed={account_id:'123',grain:'base',contract_id:'c',window_start:'2024-01-01',window_end:'2024-01-01',status:'failed',observed_at:'2026-10-05'},fixed={...failed,status:'collected',observed_at:'2026-10-06'};assert.equal(coverageFor([fixed,failed],'2024-01-01','2024-01-01').unresolved_failed_attempts,0);assert.equal(coverageFor([fixed],'2024-01-01','2024-01-01',null,['123','456']).complete,false);
});

test('profile-action breakdown is an exact-window total, distinct from aggregate audience snapshots',()=>{
 const p={metric:'profile_activity',period:'day',metric_type:'total_value',evidence_kind:'window_total',breakdown:'action_type'},rows=metricObservations({profile:p,key:'profile-actions',availability:'available',rows:[{name:p.metric,period:p.period,total_value:{value:10,breakdowns:[{dimension_keys:['action_type'],results:[{dimension_values:['website'],value:2}]}]}}]},{account:ctx.account,resource:'123',window:{start:ctx.start,end:ctx.end},observedAt:ctx.observedAt,apiVersion:config.api_version});assert.equal(rows[0].evidence_kind,'window_total');assert.equal(rows[0].value,'10');assert.match(rows[0].breakdown_json,/website/);
});


test('source health cannot use failed coverage attempts as collected bounds or freshness',async()=>{
 const {sourceInspections,plannedCommand}=await import('../ops/collector-runner.js');
 for(const source of ['meta_ads','instagram']){const query=sourceInspections('fixture',source)[0].query;assert.match(query,/MIN\(IF\(status='collected',window_start,NULL\)\)/);assert.match(query,/MAX\(IF\(status='collected',observed_at,NULL\)\)/);assert.match(query,/COUNTIF\(status='failed'\)/);assert.equal(plannedCommand(source)[1][1],source==='meta_ads'?'schedule:meta':'schedule:instagram');}
});
