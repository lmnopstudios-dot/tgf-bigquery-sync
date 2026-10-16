import test from 'node:test';
import assert from 'node:assert/strict';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { executeGovernedAgentAnalysis, assertEvidenceAgreement, dispatchAnalysisRequest } from '../oracle/analysis-route-dispatcher.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { countryConversionQuery, COUNTRY_READER_BOUNDS, buildCountryEvidence } from '../oracle/shopify-country-conversion.js';
import { runCountryProbe, probeArgs } from '../diagnostics/oracle-country-conversion.mjs';
import { acceptanceServer } from './helpers/oracle-acceptance.js';
const NOW=Date.parse('2026-10-14T12:00:00Z'),Q='What is the conversion rate this year for online UK visitors only compared to global?';
const args=(groups=['country','global'])=>({start_date:'2026-01-01',end_date:'2026-10-14',population_scope:{geography_role:'visitor_country',country:'GB',groups},channel:'online',dimensions:[]});
const metadata={shop:{id:'gid://shopify/Shop/42',ianaTimezone:'Europe/London'},currentAppInstallation:{accessScopes:[{handle:'read_reports'}]}};
const days=['2026-01-01','2026-01-02'];
function fixture({meta=metadata,parseError=false,malform=null,graphqlError=null,network=false,rowDays=days}={}){
  const calls=[],fetches=[];
  const graphql=async(query,variables)=>{
    calls.push({query,variables});assert.doesNotMatch(query,/\bmutation\b/);
    if(query.includes('OracleCountryCapability'))return structuredClone(meta);
    if(graphqlError)throw Object.assign(Error('private provider message must not be exposed'),{code:graphqlError,http_status:403});
    if(parseError)return {shopifyqlQuery:{parseErrors:['private query details'],tableData:null}};
    const local=variables.query.includes('session_country_code'),names=['day',...(local?['session_country_code']:[]),'sessions','sessions_that_completed_checkout'];
    const rows=rowDays.map((day,i)=>({day,...(local?{session_country_code:'GB'}:{}),sessions:local?[100,900][i%2]:[200,1800][i%2],sessions_that_completed_checkout:local?[10,9][i%2]:[12,36][i%2]}));malform?.(rows,local);
    return {shopifyqlQuery:{parseErrors:[],tableData:{columns:names.map(name=>({name})),rows:rows.map(row=>names.map(n=>row[n]))}}};
  };
  const fetchImpl=async(url,options)=>{
    fetches.push({url,method:options.method});assert.ok(options.signal);assert.equal(options.method,'POST');
    if(network)throw TypeError('fetch failed: private host/token');
    if(url.endsWith('/admin/oauth/access_token'))return {ok:true,status:200,json:async()=>({access_token:'fixture-token'})};
    const body=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({data:await graphql(body.query,body.variables)})};
  };
  const env={SHOPIFY_SHOP:'fixture-shop',SHOPIFY_CLIENT_ID:'fixture-id',SHOPIFY_CLIENT_SECRET:'fixture-secret'},deps=createOracleProviderDependencies({env,bigquery:{query:()=>assert.fail('Warehouse access not allowed')},project:'fixture',shopifyCountryFetch:fetchImpl,now:()=>new Date(NOW)});
  const f={calls,fetches,env,fetchImpl,graphql,reader:deps.populationConversion};f.baseline=createBaselineOverviewService({populationConversion:f.reader,now:()=>new Date(NOW)});return f;
}
test('production factory uses existing auth, metadata, native country and unfiltered global reports; ratio of sums',async()=>{
  const f=fixture(),r=await executeGovernedAgentAnalysis({message:Q,baselineOverview:f.baseline,now:NOW});
  assert.equal(f.fetches.length,4);assert.ok(f.fetches.every(c=>c.url.startsWith('https://fixture-shop.myshopify.com/')));assert.equal(f.calls.length,3);
  const reports=f.calls.filter(c=>c.variables.query),global=reports.find(c=>!c.variables.query.includes('session_country_code')),local=reports.find(c=>c.variables.query.includes('session_country_code'));
  for(const call of reports){assert.match(call.variables.query,/SHOW sessions, sessions_that_completed_checkout/);assert.match(call.variables.query,/human_or_bot_session = 'human'/);assert.match(call.variables.query,/SINCE 2026-01-01 UNTIL 2026-10-13/);assert.match(call.variables.query,/LIMIT 400/);assert.doesNotMatch(call.variables.query,/device|shipping|orders|referrer|TOP /i);}
  assert.ok(global);assert.match(local.variables.query,/session_country_code = 'GB'/);
  assert.deepEqual(r.evidence.sections[0].rows.map(r=>[r.sessions,r.numerator,r.rate]),[[1000,19,.019],[2000,48,.024]]);assert.match(r.answer,/1\.90%/);assert.match(r.answer,/2\.40%/);assert.match(r.answer,/-0\.50/);
  assert.equal(r.evidence.source.coverage.compatible_report_days,2);assert.equal(r.evidence.source.coverage.full_requested_period,false);assert.match(r.answer,/Upstream tracking completeness remains unverified/);assert.equal(r.evidence.source.coverage.source_collected_at,null);
});
test('global replacement does not retain a visitor-country predicate or depend on UK coverage; rest is explicit global minus UK',async()=>{
  const f=fixture(),global=await f.reader(args(['global']));assert.equal(f.calls.length,2);assert.ok(!f.calls[1].variables.query.includes('session_country_code'));assert.equal(global.partitions[0].rows.length,2);
  const rest=await f.reader(args(['country','rest_of_world']));assert.deepEqual(rest.partitions[0].rows.filter(r=>r.group==='rest_of_world').map(r=>[r.sessions,r.numerator]),[[100,2],[900,27]]);
});
test('native missing/duplicate keys, impossible counts, null numerators and incomplete pagination cannot fabricate rates',async()=>{
  for(const malform of [rows=>rows.push(rows[0]),rows=>rows[0].sessions_that_completed_checkout=null,rows=>rows[0].sessions_that_completed_checkout=5000,rows=>rows[0].sessions=-1,rows=>rows[0].sessions=true,rows=>rows[0].sessions=' ',(rows,local)=>{if(local)rows[0].session_country_code='US';}]){
    const f=fixture({malform}),r=await f.reader(args());assert.equal(r.supported,false);assert.equal(r.failure.code,'COUNTRY_EVIDENCE_INVALID');
  }
  const f=fixture({malform:(rows,local)=>{if(local)rows.pop();}}),source=await f.reader(args());assert.equal(source.supported,true);assert.equal(source.coverage.compatible_report_days,1);assert.ok(source.coverage.missing_days.includes('2026-01-02'));
  const paged=fixture({malform:rows=>{const row=rows[0];rows.splice(0,rows.length,...Array(400).fill(row));}}),bad=await paged.reader(args());assert.equal(bad.supported,false);assert.equal(bad.failure.code,'COUNTRY_PAGE_BOUND');assert.ok(bad.graphql_calls<=COUNTRY_READER_BOUNDS.max_graphql_calls);
});
test('only explicitly returned zero counts are zero; absent country rows remain unavailable',async()=>{
  const zero=fixture({malform:rows=>rows.forEach(r=>{r.sessions=0;r.sessions_that_completed_checkout=0;})}),result=await executeGovernedAgentAnalysis({message:Q,baselineOverview:zero.baseline,now:NOW});assert.equal(result.evidence.sections[0].rows[0].rate,null);assert.match(result.answer,/Unavailable/);
  const absent=fixture({malform:(rows,local)=>{if(local)rows.splice(0);}}),r=await executeGovernedAgentAnalysis({message:Q,baselineOverview:absent.baseline,now:NOW});assert.equal(r.analysis_unavailable,true);assert.equal(r.evidence,undefined);
});
test('scope, auth, SQL and network failures remain explicit safe limitations; no permission changes or fallbacks',async()=>{
  for(const options of [{meta:{...metadata,currentAppInstallation:{accessScopes:[]}}},{parseError:true},{graphqlError:'ACCESS_DENIED'},{network:true}]){
    const f=fixture(options),r=await executeGovernedAgentAnalysis({message:Q,baselineOverview:f.baseline,now:NOW});assert.equal(r.analysis_unavailable,true);assert.match(r.answer,/Visitor-country conversion is unavailable/);assert.doesNotMatch(r.answer,/private|fixture-token|fixture-secret|\|.*Mobile/i);assert.equal(r.capability_status.supported,false);
  }
});
test('requested bounds, dates, timezone and platform are validated before a rate can be delivered',async()=>{
  for(const changes of [{start_date:'2024-01-01'},{start_date:'2026-02-30'},{channel:'instore'},{dimensions:['device']},{population_scope:{geography_role:'shipping_country',country:'GB',groups:['country','global']}}]){const f=fixture(),r=await f.reader({...args(),...changes});assert.equal(r.supported,false);assert.equal(f.fetches.length,0);}
  const f=fixture({meta:{...metadata,shop:{...metadata.shop,ianaTimezone:'UTC'}}});await assert.rejects(executeGovernedAgentAnalysis({message:Q,baselineOverview:f.baseline,now:NOW}),{code:'EVIDENCE_SCOPE_MISMATCH'});
  const source=await fixture({rowDays:['2025-11-20']}).reader({...args(),start_date:'2025-11-19',end_date:'2025-11-20'});assert.equal(source.effective_period.start_date,'2025-11-20');assert.equal(source.coverage.compatible_report_days,1);assert.equal(source.coverage.excluded_days[0].reason,'before_governed_Shopify_launch');
});
test('September rollout dates are explicit gaps and the adjacent measurement partitions are separate',async()=>{
  const f=fixture({rowDays:['2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-24']}),source=await f.reader({...args(),start_date:'2026-09-20',end_date:'2026-09-24'});
  assert.equal(source.partitions.length,2);assert.equal(source.coverage.excluded_days.length,3);assert.deepEqual(source.partitions.map(p=>p.period),[{start_date:'2026-09-20',end_date:'2026-09-20'},{start_date:'2026-09-24',end_date:'2026-09-24'}]);
});
test('native report proofs, requested populations and rederived calculations are checked on recovery',async()=>{
  const f=fixture(),r=await executeGovernedAgentAnalysis({message:Q,baselineOverview:f.baseline,now:NOW});
  for(const mutate of [e=>e.source.reports[0].pages[0].query+=" WHERE session_country_code = 'GB'",e=>e.source.reports[0].pages[0].rows[0].sessions=1,e=>e.source.coverage.missing_days=[],e=>e.source.granted_scopes=[],e=>e.source.partitions[0].rows[0].numerator=999,e=>e.source.request.population_scope.groups=['country'],e=>e.source.effective_period.end_date='2026-10-14']){const e=structuredClone(r.evidence);mutate(e);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,e),{code:'EVIDENCE_SCOPE_MISMATCH'});}
});
test('Render probe calls the same production factory and reports only verified aggregate coverage',async()=>{
  const f=fixture(),r=await runCountryProbe(probeArgs(['--start','2026-01-01','--end','2026-10-14']),{env:f.env,shopifyCountryFetch:f.fetchImpl,now:()=>new Date(NOW)});assert.equal(r.capability_supported,true);assert.equal(r.source_data_writes,false);assert.equal(r.coverage.compatible_report_days,2);assert.match(r.live_acceptance,/not deployed/);assert.equal(r.actual_evidence_cutoff,'2026-01-02');
});
for(const durable of [false,true])test(`production country reader through direct HTTP and ${durable?'durable recovery':'interactive session'}`,async t=>{
  const f=fixture(),h=await acceptanceServer(f,{durable});t.after(h.close);
  const direct=await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:Q})});assert.equal(direct.status,200);const payload=await direct.json();assert.match(payload.answer,/1\.90%/);
  const r=await h.submit(Q);assert.match(r.answer,/2\.40%/);const before=f.fetches.length;
  if(durable){const recovered=await h.get('/jobs/'+r.job_id);assert.deepEqual(recovered.evidence,r.evidence);assert.equal(f.fetches.length,before);h.jobs.jobs.get(r.job_id).result_json.evidence.source.reports[0].pages[0].query+=' country';assert.equal((await fetch(h.base+'/jobs/'+r.job_id,{headers:h.headers})).status,409);}
  const world=await h.submit('Worldwide instead');assert.deepEqual(world.evidence.population_scope.groups,['global']);const rest=await h.submit('Compare with the rest of the world');assert.match(rest.answer,/2\.90%/);assert.match(rest.answer,/excluding GB/);
});

test('configured country reader asks a targeted date question without making unscoped API calls',async()=>{
  const f=fixture(),r=await executeGovernedAgentAnalysis({message:'UK visitor conversion compared to global',baselineOverview:f.baseline,now:NOW});assert.deepEqual(r.clarification.fields,['start_date','end_date']);assert.match(r.clarification.message,/bounded reporting period/);assert.equal(f.fetches.length,0);
  const result=await executeGovernedAgentAnalysis({message:'This year.',analysisContext:r.analysis_context,baselineOverview:f.baseline,now:NOW});assert.match(result.answer,/1\.90%/);
});
