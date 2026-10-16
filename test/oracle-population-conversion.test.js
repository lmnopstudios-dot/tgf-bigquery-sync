import { buildCountryEvidence, countryConversionQuery } from '../oracle/shopify-country-conversion.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { resolveAnalyticalPlan, analyticalPlanKey } from '../oracle/analytical-plan.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { dispatchAnalysisRequest, assertEvidenceAgreement, executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
import { createPopulationConversionProvider } from '../oracle/population-conversion.js';
import { acceptanceServer } from './helpers/oracle-acceptance.js';
const NOW=Date.parse('2026-10-14T12:00:00Z');
const Q='What is the conversion rate this year for online UK visitors only compared to global?';
const apply=(c,q)=>transitionAnalysisContext(c,q,{now:NOW}).context;
// Native-report fixture only; it does not certify this shop's live access/history.
function supported(args){
  const effective={start_date:args.start_date,end_date:args.end_date==='2026-10-14'?'2026-10-13':args.end_date};
  const reports=(args.population_scope.groups.some(g=>g!=='global')?['global','country']:['global']).map(group=>({group,period:effective,pages:[{query:countryConversionQuery(effective,group,args.population_scope.country),rows:['2026-01-01','2026-01-02'].map((day,i)=>({day,sessions:group==='country'?[100,900][i]:[200,1800][i],sessions_that_completed_checkout:group==='country'?[10,9][i]:[12,36][i],...(group==='country'?{session_country_code:args.population_scope.country}:{})}))}]}));
  return buildCountryEvidence({request:args,shop:{id:'shop-1',ianaTimezone:'Europe/London'},granted_scopes:['read_reports'],retrieved_at:new Date(NOW).toISOString(),effective_period:effective,reports});
}
function fixture({available=true,mutate=null}={}){
  const calls=[];return {calls,baseline:createBaselineOverviewService({populationConversion:async args=>{calls.push(args);const value=available?supported(args):await createPopulationConversionProvider({env:{}})(args);mutate?.(value);return value;},shopifyDevice:async(name,args)=>({rows:['mobile','desktop'].map(device_type=>({device_type,sessions:100,numerator:3,coverage:{covered_days:Math.round((Date.parse(args.end_date)-Date.parse(args.start_date))/86400000)+1,expected_days:Math.round((Date.parse(args.end_date)-Date.parse(args.start_date))/86400000)+1}}))}),now:()=>new Date(NOW)})};
}
const send=(f,c,q)=>dispatchAnalysisRequest({message:q,analysisContext:apply(c,q),baselineOverview:f.baseline});
test('fresh and device-retained scopes independently represent metric, geography, groups and breakdown',async()=>{
  for(const prior of [null,apply(null,'Monthly mobile and desktop conversion rates this year.')]){
    const f=fixture(),r=await send(f,prior,Q),c=r.analysis_context;
    assert.equal(c.requested_subject,'population_conversion');assert.deepEqual(c.dimensions,[]);
    assert.deepEqual(f.calls,[{start_date:'2026-01-01',end_date:'2026-10-14',population_scope:{geography_role:'visitor_country',country:'GB',groups:['country','global']},channel:'online',dimensions:[]}]);
    assert.deepEqual(r.evidence.sections[0].rows.map(r=>[r.sessions,r.numerator,r.rate]),[[1000,19,.019],[2000,48,.024]]);
    assert.ok(Math.abs(r.evidence.sections[0].percentage_point_difference+.5)<1e-12);
    assert.match(r.answer,/1\.90%/);assert.match(r.answer,/2\.40%/);assert.match(r.answer,/-0\.50/);assert.match(r.answer,/overlap/);assert.match(r.answer,/Actual evidence cutoff: 2026-01-02/);assert.match(r.answer,/Partial requested period/);assert.doesNotMatch(r.answer,/Mobile|Desktop|referrer/i);
    assert.equal(assertEvidenceAgreement(c,r.evidence),true);
    assert.throws(()=>assertEvidenceAgreement(c,{kind:'governed_device_conversion',requested_subject:'device_conversion',sections:[{rows:[{device_type:'mobile',rate:.1}]}]}),{code:'EVIDENCE_SCOPE_MISMATCH'});
  }
});
test('population followups distinguish overlapping global and disjoint rest of world; device switch clears filters',async()=>{
  const f=fixture();let r=await send(f,null,Q);const original=resolveAnalyticalPlan(r.analysis_context);
  for(const [q,groups] of [['UK only',['country']],['Worldwide instead',['global']],['Compare with the rest of the world',['country','rest_of_world']]]){
    r=await send(f,r.analysis_context,q);assert.deepEqual(r.analysis_context.population_scope.groups,groups);assert.deepEqual(f.calls.at(-1).population_scope.groups,groups);assert.notEqual(analyticalPlanKey(original),analyticalPlanKey(resolveAnalyticalPlan(r.analysis_context)));
    if(groups.includes('rest_of_world')){assert.match(r.answer,/excluding GB/);assert.match(r.answer,/disjoint/);assert.match(r.answer,/2\.90%/);assert.match(r.answer,/-1\.00/);}
    if(groups.length===1)assert.equal(r.evidence.sections[0].rows.length,1);
  }
  const device=apply(r.analysis_context,'Switch back to device breakdown');assert.equal(device.population_scope,null);assert.equal(device.geography,null);assert.deepEqual(device.filters,[]);assert.equal(device.requested_subject,'device_conversion');
  const result=await send(f,r.analysis_context,'Switch back to device breakdown');assert.equal(result.evidence.kind,'governed_device_conversion');assert.match(result.answer,/Mobile/);
});
test('related countries and geographic roles do not silently become shipping or devices',async()=>{
  for(const [country,code] of [['US','US'],['France','FR'],['Japan','JP']]){const f=fixture(),r=await send(f,null,`Compare online ${country} visitor conversion this year versus global`);assert.equal(f.calls[0].population_scope.country,code);assert.equal(r.evidence.sections[0].rows[0].sessions,1000);}
  for(const role of ['shipping country','billing country','storefront market']){const f=fixture(),r=await send(f,null,`UK ${role} conversion this year compared to global`);assert.equal(r.analysis_unavailable,true);assert.match(r.answer,/visitor\/session geography/);assert.equal(f.calls.length,0);}
});
test('unsupported governed storage returns an explicit limitation and no device/order substitute',async()=>{
  const f=fixture({available:false}),r=await send(f,apply(null,'Monthly mobile and desktop conversion rates this year.'),Q);
  assert.equal(r.analysis_unavailable,true);assert.equal(r.evidence,undefined);assert.match(r.answer,/Visitor-country conversion is unavailable/);assert.match(r.answer,/cutoff: unavailable/);assert.match(r.answer,/groups overlap/);assert.doesNotMatch(r.answer,/\|.*Mobile.*Desktop/);
  const noBinding=await dispatchAnalysisRequest({message:Q,analysisContext:apply(null,Q),baselineOverview:createBaselineOverviewService({shopifyDevice:()=>assert.fail('device substitution')})});assert.equal(noBinding.analysis_unavailable,true);
});
test('strict evidence rejects incompatible numerator, denominator, groups, days, calculations and recovered plans',async()=>{
  const f=fixture(),r=await send(f,null,Q);
  for(const mutate of [e=>e.source.partitions[0].rows[0].numerator_definition='shipping_orders',e=>e.source.partitions[0].rows[0].denominator_definition='users',e=>e.source.partitions[0].geography_role='shipping_country',e=>e.source.partitions[0].rows.pop(),e=>e.source.partitions[0].rows[0].date='2026-01-02',e=>e.source.partitions[0].evidence_cutoff='2025-12-31',e=>e.sections[0].rows[0].rate=.055,e=>e.sections[0].percentage_point_difference=0,e=>e.population_scope.groups=['country','rest_of_world'],e=>e.analytical_plan.population.country='US']){
    const e=structuredClone(r.evidence);mutate(e);assert.throws(()=>assertEvidenceAgreement(r.analysis_context,e),{code:'EVIDENCE_SCOPE_MISMATCH'});
  }
  const stale=apply(r.analysis_context,'UK only');assert.throws(()=>assertEvidenceAgreement(stale,r.evidence),{code:'EVIDENCE_SCOPE_MISMATCH'});
});
test('direct agent delivers comparison and the production capability limitation',async()=>{
  for(const available of [true,false]){const f=fixture({available});const r=await executeGovernedAgentAnalysis({message:Q,baselineOverview:f.baseline,now:NOW});if(available){assert.match(r.answer,/1\.90%/);assert.equal(r.evidence.kind,'governed_population_conversion');}else{assert.equal(r.analysis_unavailable,true);assert.match(r.answer,/Visitor-country/);}}
});
for(const durable of [false,true])test(`population comparison, retained device, limitation and recovery through ${durable?'durable':'interactive'} delivery`,async t=>{
  const f=fixture(),server=await acceptanceServer(f,{durable});t.after(server.close);
  await server.submit('Monthly mobile and desktop conversion rates this year.');
  const r=await server.submit(Q);assert.match(r.answer,/1\.90%/);assert.match(r.answer,/2\.40%/);assert.deepEqual(r.evidence.population_scope.groups,['country','global']);
  if(durable){const recovered=await server.get('/jobs/'+r.job_id);assert.deepEqual(recovered.evidence,r.evidence);assert.match(recovered.answer,/overlap/);server.jobs.jobs.get(r.job_id).result_json.evidence.sections[0].rows[0].numerator=22;const invalid=await fetch(server.base+'/jobs/'+r.job_id,{headers:server.headers});assert.equal(invalid.status,409);}
  else{const session=await server.get('/session');assert.match(JSON.stringify(session),/country|visitor|population_conversion/);}
  const local=await server.submit('UK only');assert.deepEqual(local.evidence.population_scope.groups,['country']);
  const world=await server.submit('Worldwide instead');assert.deepEqual(world.evidence.population_scope.groups,['global']);
  const rest=await server.submit('Compare with the rest of the world');assert.match(rest.answer,/2\.90%/);assert.match(rest.answer,/disjoint/);
  const device=await server.submit('Switch back to device breakdown');assert.equal(device.analysis_context.population_scope,null);assert.match(device.answer,/Mobile/);
  const absent=fixture({available:false}),other=await acceptanceServer(absent,{durable});t.after(other.close);const limitation=await other.submit(Q);assert.equal(limitation.analysis_unavailable,true);assert.match(limitation.answer,/unavailable/);
});
test('geography, comparison membership and requested breakdown remain independent; unrelated subjects clear country scope',async()=>{
  const c=apply(null,Q+' Break down by device.');assert.deepEqual(c.dimensions,['device']);assert.deepEqual(c.population_scope.groups,['country','global']);
  const f=fixture(),r=await dispatchAnalysisRequest({message:Q,analysisContext:c,baselineOverview:f.baseline});assert.equal(r.analysis_unavailable,true);assert.equal(f.calls.length,0);
  const sales=apply(apply(null,Q),'Show online sales in September 2026.');assert.equal(sales.population_scope,null);assert.equal(sales.requested_subject,'sales');
  const incomplete=apply(null,'Compare online conversion with the rest of the world this year.');assert.ok(incomplete.unresolved_required_fields.includes('population_scope'));
  assert.doesNotThrow(()=>apply(null,'Compare sales with the rest of the world this year.'));
});
test('production dependency explicitly reports unsupported without querying device or shipping providers',async()=>{
  const {createOracleProviderDependencies}=await import('../oracle/provider-dependencies.js');
  const dependencies=createOracleProviderDependencies({env:{},project:'fixture',bigquery:{query:()=>assert.fail('unrelated stored read')}});
  const source=await dependencies.populationConversion({start_date:'2026-01-01',end_date:'2026-10-14',population_scope:apply(null,Q).population_scope,channel:'online',dimensions:[]});
  assert.equal(source.supported,false);assert.equal(source.failure.code,'CONFIGURATION_UNAVAILABLE');
});
test('foreign platforms cannot be inserted into native Shopify source partitions',async()=>{
  const f=fixture({mutate:source=>{source.partitions[0].platform='woo';}});
  await assert.rejects(send(f,null,Q),{code:'EVIDENCE_SCOPE_MISMATCH'});
});

test('audited country capability absence is reported before asking for dates',async()=>{
  const f=fixture({available:false}),r=await send(f,null,'UK visitor conversion compared to global');assert.equal(r.analysis_unavailable,true);assert.equal(f.calls.length,0);assert.match(r.answer,/Visitor-country conversion is unavailable/);assert.doesNotMatch(r.answer,/What date range/);
});
test('explicit source platforms are retained and unsupported Woo scope does not call Shopify',async()=>{
  for(const prefix of ['WooCommerce','Shopify and WooCommerce']){const f=fixture(),r=await send(f,null,`${prefix} online UK visitor conversion this year compared to global`);assert.equal(r.analysis_unavailable,true);assert.equal(f.calls.length,0);assert.match(r.analysis_context.platform,/woo/);}
  const f=fixture(),r=await send(f,null,'Shopify online UK visitor conversion this year compared to global');assert.equal(r.analysis_context.platform,'shopify');assert.match(r.answer,/1\.90%/);
  const excluded=apply(apply(null,Q),'Worldwide excluding UK');assert.deepEqual(excluded.population_scope.groups,['rest_of_world']);
});
test('unsupported country-to-country comparisons remain independent and do not silently become UK-only',async()=>{
  const f=fixture(),r=await send(f,null,'US visitor conversion this year compared to UK');assert.equal(r.analysis_unavailable,true);assert.deepEqual(r.analysis_context.population_scope,{geography_role:'visitor_country',country:'US',comparison_country:'GB',groups:['country','other_country']});assert.equal(f.calls.length,0);assert.match(r.answer,/visitor-country pair/);
});
