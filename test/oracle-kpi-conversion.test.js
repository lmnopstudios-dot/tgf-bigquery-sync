import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {createKpiConversionReader,kpiConversionRows,kpiConversionRange,assertKpiConversionEvidence,KPI_CONVERSION_BOUNDS} from '../oracle/kpi-conversion.js';
import {buildKpiEvidence,assertKpiArtifact} from '../oracle/kpi-dashboard.js';
import {kpiBaselineValue} from '../public/oracle/kpi-readiness.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {assertEvidenceAgreement,executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {kpiFixture,KPI_NOW} from './helpers/kpi-fixture.js';
import {conversionFixture} from './helpers/kpi-conversion-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const p={id:'selected',label:'October',start_date:'2026-10-01',end_date:'2026-10-31'},scope={channel:'combined',currency:'GBP',geography:'all'};
const read=async(f,periods=[p],s=scope)=>f.read({periods,scope:s,now:KPI_NOW});
const context=message=>transitionAnalysisContext(null,message,{now:KPI_NOW}).context;
test('native converted-session numerator and weighted UK/international/global rates; cached shared queries cost four calls',async()=>{
 const f=conversionFixture(),source=await read(f),e=kpiConversionRows(source,[p]),uk=e.rows.find(r=>r.geography==='uk'),global=e.rows.find(r=>r.geography==='combined'),intl=e.rows.find(r=>r.geography==='international');
 assert.equal(source.api_attempts,4);assert.equal(f.calls.length,4);assert.equal(uk.sessions,16*100+15*900);assert.equal(uk.converted_sessions,16*10+15*9);assert.equal(uk.value,uk.converted_sessions/uk.sessions);assert.notEqual(uk.value,(.1+.01)/2);assert.equal(intl.value,.01);
 assert.equal(global.sessions,uk.sessions+intl.sessions+31*50);assert.equal(e.unknown[0].sessions,1550);assert.equal(e.unknown[0].converted_sessions,31);assert.match(source.definition,/Not GA4/);
});
test('missing UK dates do not erase global and never become zero; failed international query preserves global and UK',async()=>{
 const missing=await read(conversionFixture({missingDay:'2026-10-04'})),a=kpiConversionRows(missing,[p]);assert.equal(a.rows[0].status,'supported');assert.equal(a.rows[1].value,null);assert.equal(a.rows[1].sessions,null);assert.equal(a.unknown[0].sessions,null);
 const failed=await read(conversionFixture({failGroup:'international'})),b=kpiConversionRows(failed,[p]);assert.equal(b.rows[0].status,'supported');assert.equal(b.rows[1].status,'supported');assert.equal(b.rows[2].value,null);assert.equal(b.unknown[0].sessions,null);assert.doesNotMatch(JSON.stringify(failed),/private synthetic/);
});
test('zero observed sessions keeps zero counts and an unavailable rate',async()=>{
 const rows=kpiConversionRows(await read(conversionFixture({zero:true})),[p]);assert(rows.rows.every(r=>r.sessions===0&&r.converted_sessions===0&&r.value===null));assert.equal(rows.unknown[0].sessions,0);
});
test('pre-launch and September rollout days remain gaps; measurement eras do not pool or compare',async()=>{
 const periods=[{...p,start_date:'2025-11-01',end_date:'2025-11-30'}, {...p,id:'previous',start_date:'2026-09-01',end_date:'2026-09-30'}, {...p,id:'baseline',start_date:'2025-12-01',end_date:'2026-02-28'},p];
 const source=await read(conversionFixture(),periods),a=kpiConversionRows(source,periods);assert(a.rows.filter(r=>r.period==='previous').every(r=>r.value===null&&r.observed_days===27));assert(a.rows.filter(r=>r.period==='selected'&&r.start_date==='2025-11-01').every(r=>r.value===null));
 const f=kpiFixture({conversionReader:conversionFixture().read,baselineStart:'2025-12-01'}),c=context('KPI dashboard for October 2026'),result=await f.service('KPI dashboard for October 2026',{analysisContext:c,now:KPI_NOW,exportOwner:'o',requestId:'era'}),r=result.evidence.summary.find(r=>r.period==='selected'&&r.metric==='conversion'&&r.geography==='uk');
 assert.equal(r.value!=null,true);assert.equal(r.previous_value,null);assert.equal(r.baseline_value,null);assert.match(r.baseline_comparison_reason,/eras differ/);assert.match(kpiBaselineValue({...result.evidence,baseline:{...result.evidence.baseline,fixed:false}},r).reason,/eras differ/);
});
test('native conversion coverage is independent of finance certificates; currency and shipping geography never filter sessions',async()=>{
 const native=conversionFixture(),f=kpiFixture({coverage:[],conversionReader:native.read}),c=context('KPI dashboard for October 2026 USD'),r=await f.service('KPI dashboard for October 2026 USD',{analysisContext:c,now:KPI_NOW,exportOwner:'o',requestId:'independent'});
 assert(r.evidence.summary.filter(r=>r.metric==='aov').every(r=>r.value===null));assert(r.evidence.summary.filter(r=>r.metric==='conversion').some(r=>r.value!=null));assert(r.evidence.rows.filter(r=>r.metric==='conversion').every(r=>r.currency===null&&!r.currency_filter_applied&&!r.commerce_geography_filter_applied));assert(native.calls.every(c=>!/(presentment_currency|shipping_country)/.test(c.variables?.query||'')));
});
test('POS, unavailable grant, wrong timezone and cancellation fail explicitly without substituted rates',async()=>{
 const f=conversionFixture(),pos=await read(f,[p],{...scope,channel:'instore'});assert.equal(f.calls.length,0);assert.equal(kpiConversionRows(pos,[p]).rows[0].value,null);
 const denied=await read(conversionFixture({grants:false}));assert(kpiConversionRows(denied,[p]).rows.every(r=>r.value===null));assert.equal(denied.api_attempts,1);
 const wrong=await read(conversionFixture({timezone:'America/New_York'}));assert.equal(wrong.unavailable_reason,'KPI_CONVERSION_TIMEZONE_MISMATCH');
 const ctrl=new AbortController();ctrl.abort();const cancelled=await f.read({periods:[p],scope,now:KPI_NOW,signal:ctrl.signal});assert.equal(cancelled.api_attempts,0);
});
test('bounded scope and lease loss cannot publish a substituted conversion source',async()=>{
 assert.throws(()=>kpiConversionRange([{...p,start_date:'2025-11-20',end_date:'2035-01-01'}],Date.parse('2035-01-02T12:00:00Z')),{code:'KPI_CONVERSION_BOUND'});
 const r=createKpiConversionReader({env:{}}),noConfig=await r({periods:[p],scope,now:KPI_NOW});assert.equal(noConfig.api_attempts,0);assert.match(noConfig.unavailable_reason,/connection unavailable/);
 const f=conversionFixture();await assert.rejects(f.read({periods:[p],scope,now:KPI_NOW,assertLease:async()=>{throw Object.assign(Error('lease lost'),{code:'LEASE_NOT_OWNED'});}}),{code:'LEASE_NOT_OWNED'});
});
test('saved conversion replays source counts and rejects modified monthly cards, summary rates and raw native reports',async()=>{
 const f=kpiFixture({conversionReader:conversionFixture().read}),c=context('KPI dashboard'),r=await f.service('KPI dashboard',{analysisContext:c,now:KPI_NOW,exportOwner:'o',requestId:'proof'}),e=r.evidence;
 assertEvidenceAgreement(c,e);assertKpiConversionEvidence(e);await assertKpiArtifact(await f.exportStore.get(r.artifact.id,'o'));
 for(const mutate of [e=>{e.summary.find(r=>r.metric==='conversion'&&r.value!=null).value+=.01;},e=>{e.monthly.find(r=>r.metric==='conversion'&&r.value!=null).sessions++;},e=>{e.conversion.sources.combined.source.reports[0].pages[0].rows[0].sessions++;}]){const bad=structuredClone(e);mutate(bad);assert.throws(()=>assertKpiConversionEvidence(bad));}
});
test('direct, interactive and durable KPI conversion preserves successful commerce, authenticated XLSX and recovery without source replay',async()=>{
 for(const durable of [false,true]){const native=conversionFixture({failGroup:'international'}),f=kpiFixture({conversionReader:native.read}),h=await acceptanceServer(f,{durable,now:KPI_NOW});
 try{if(!durable){const direct=await executeGovernedAgentAnalysis({message:'KPI dashboard for October 2026',baselineOverview:f.baseline,now:KPI_NOW,baselineOptions:{exportOwner:'direct-owner',requestId:'direct-conversion'}});assert(direct.evidence.summary.some(r=>r.metric==='conversion'&&r.value!=null));}
 const r=await h.submit('KPI dashboard for October 2026',{fresh:true});assert(r.evidence.summary.some(r=>r.metric==='aov'&&r.value!=null));assert(r.evidence.summary.some(r=>r.metric==='conversion'&&r.geography==='uk'&&r.value!=null));assert(r.evidence.summary.filter(r=>r.metric==='conversion'&&r.geography==='international').every(r=>r.value===null));assert.deepEqual(r.proposals??[],[]);
 const response=await fetch(h.origin+r.artifact.download_url,{headers:h.headers}),wb=new ExcelJS.Workbook();assert.equal(response.status,200);await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));assert(wb.getWorksheet('Conversion coverage'));assert.notEqual((await fetch(h.origin+r.artifact.download_url)).status,200);
 if(durable){const count=native.calls.length;await h.get('/jobs/'+r.job_id);assert.equal(native.calls.length,count);}
 }finally{await h.close();}}
});
test('four-year bounded collection shares duplicate reports across chunks and never exceeds twenty actual API attempts',async()=>{
 const now=Date.parse('2030-01-01T12:00:00Z'),f=conversionFixture({now}),periods=[{...p,start_date:'2025-11-20',end_date:'2029-11-16'}],source=await f.read({periods,scope,now});
 assert(source.api_attempts<=KPI_CONVERSION_BOUNDS.max_graphql_calls);assert.equal(source.api_attempts,13);assert.equal(f.calls.length,13);assert(Object.values(source.sources).every(r=>r.source.supported));
});
test('a throttled international source is disclosed while valid global/UK results survive without automatic retries',async()=>{
 const f=conversionFixture({failGroup:'international',failCode:'THROTTLED'}),source=await read(f),result=kpiConversionRows(source,[p]);assert.equal(f.calls.length,4);assert.equal(source.sources.international.source.failure.code,'THROTTLED');assert.equal(result.rows[0].status,'supported');assert.equal(result.rows[1].status,'supported');assert.equal(result.rows[2].value,null);
});
