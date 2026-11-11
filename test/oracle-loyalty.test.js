import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {transitionAnalysisContext,validateAnalysisContext} from '../oracle/analysis-context.js';
import {analyticalPlanKey,resolveAnalyticalPlan} from '../oracle/analytical-plan.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {loyaltyFixture,LOYALTY_NOW} from './helpers/loyalty-fixture.js';
const scope=(text,base=null)=>transitionAnalysisContext(base,text,{now:LOYALTY_NOW}).context;
test('loyalty scope precedes generic customer/sales routing; refinements and unrelated switches preserve validation',()=>{
 const c=scope('Show LoyaltyLion overview for October 2026');assert.equal(c.requested_subject,'loyalty');assert.equal(c.start_date,'2026-10-01');assert.equal(c.loyalty_scope.tier_basis,'current');assert.equal(c.loyalty_scope.sections.length,5);
 const refined=scope('Only Gold, daily',c);assert.equal(refined.loyalty_scope.tier,'gold');assert.equal(refined.grain,'day');assert.equal(refined.start_date,c.start_date);
 const switched=scope('Show online sales for September 2026',c);assert.notEqual(switched.requested_subject,'loyalty');assert.equal(switched.loyalty_scope,null);
 assert.throws(()=>validateAnalysisContext({...c,loyalty_scope:null}));assert.throws(()=>validateAnalysisContext({...c,loyalty_scope:{...c.loyalty_scope,guess_tier:true}}));
 const historical=scope('Now use the tier held when they ordered',c);assert.equal(historical.loyalty_scope.tier_basis,'historical');assert.notEqual(analyticalPlanKey(resolveAnalyticalPlan(c)),analyticalPlanKey(resolveAnalyticalPlan(historical)));
});
test('disabled and unavailable access are limitations, not zero activity or generic date questions',async t=>{
 const f=loyaltyFixture({disabled:true}),h=await acceptanceServer(f,{now:LOYALTY_NOW});t.after(h.close);const r=await h.submit('Show LoyaltyLion overview',{fresh:true});assert.match(r.answer,/LOYALTY_REPORTING_DISABLED/);assert.doesNotMatch(r.answer,/What date range/);assert.equal(f.queries.length,0);assert.equal(r.partial,true);
});
for(const durable of [false,true])test(`real ${durable?'durable':'interactive'} chat, partial sections, refinement and retained XLSX without provider replay`,async t=>{
 const f=loyaltyFixture({failure:'points'}),h=await acceptanceServer(f,{durable,now:LOYALTY_NOW});t.after(h.close);
 const r=await h.submit('Show LoyaltyLion overview for October 2026',{fresh:true});assert.equal(r.evidence.kind,'governed_loyalty');assert.equal(r.evidence.sections.find(s=>s.section==='membership').rows[0].profiles,4);assert.equal(r.evidence.sections.find(s=>s.section==='points').status,'unavailable');assert.equal(r.evidence.sections.find(s=>s.section==='claims').rows[0].reward_claims,1);assert.equal(r.partial,true);assert.match(r.answer,/Reward claims consume points/);assert.match(r.answer,/\| enrolled \| guest[^\n]*\n\| ---/);
 const count=f.queries.length,exported=await h.submit('Export those results to Excel');assert.equal(f.queries.length,count);assert.ok(exported.artifact?.download_url,JSON.stringify(exported));
 const response=await fetch(h.origin+exported.artifact.download_url,{headers:{cookie:h.headers.cookie}});assert.equal(response.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));assert(wb.getWorksheet('Source notes'));assert.doesNotMatch(JSON.stringify(wb.model),/private@example|SECRET_GIFT_CARD/);
 if(durable){const recovered=await h.get('/jobs/'+exported.job_id);assert.equal(recovered.artifact.id,exported.artifact.id);assert.equal(f.queries.length,count);}
 const refined=await h.submit('Show points only for September 2026');assert.equal(refined.analysis_context.requested_subject,'loyalty');assert.equal(refined.analysis_context.start_date,'2026-09-01');assert.deepEqual(refined.analysis_context.loyalty_scope.sections,['points']);
});
test('historical tier and actual reward-use requests never receive current tier or claim substitutes',async t=>{
 const f=loyaltyFixture(),h=await acceptanceServer(f,{now:LOYALTY_NOW});t.after(h.close);let r=await h.submit('Show LoyaltyLion historical tiers',{fresh:true});assert.match(r.answer,/HISTORICAL_TIERS_UNAVAILABLE/);assert.doesNotMatch(r.answer,/What date range/);r=await h.submit('Show LoyaltyLion rewards actually used in October 2026',{fresh:true});assert.match(r.answer,/REWARD_USE_UNAVAILABLE/);assert.equal(r.evidence.sections[0].rows.length,0);
});
test('missing coverage and successful empty retain different meanings; evidence cannot lose scope or a section',async()=>{
 const c=scope('Show LoyaltyLion points daily for October 2026'),a=loyaltyFixture({empty:true}),b=loyaltyFixture({empty:true,noCoverage:true});const complete=await a.provider(c),missing=await b.provider(c);assert.equal(complete.sections[0].coverage_complete,true);assert.equal(missing.sections[0].coverage_complete,false);assert.equal(missing.sections[0].status,'partial');assertEvidenceAgreement(c,complete);
 for(const change of [e=>e.sections.pop(),e=>e.loyalty_scope.tier='gold',e=>e.requested_subject='sales']){const e=structuredClone(complete);change(e);assert.throws(()=>assertEvidenceAgreement(c,e));}
});

test('direct agent and durable request idempotency preserve submitted loyalty scope without reusing old sales',async t=>{
 const f=loyaltyFixture(),h=await acceptanceServer(f,{durable:true,now:LOYALTY_NOW});t.after(h.close);
 const direct=await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:'Show LoyaltyLion points daily for October 2026'})});assert.equal(direct.status,200);const r=await direct.json();assert.equal(r.evidence.sections[0].rows[0].net_points_delta,0);assert.equal(r.analysis_context.grain,'day');
 const response=await h.submit('Show LoyaltyLion claims for October 2026',{fresh:true,id:'loyalty-idempotent'}),count=f.queries.length;
 const duplicate=await fetch(h.base+'/jobs',{method:'POST',headers:{...h.headers,'x-request-id':'loyalty-idempotent'},body:JSON.stringify({message:'Show LoyaltyLion claims for October 2026'})});assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).job_id,response.job_id);assert.equal(f.queries.length,count);
 const recovered=await h.get('/jobs/'+response.job_id);assert.deepEqual(recovered.evidence,response.evidence);assert.equal(f.queries.length,count);
});

test('presentation failure renders validated loyalty sections without another provider call',async()=>{
 const {deliverOracleResult}=await import('../oracle/result-delivery.js'),{answerLoyaltyReport}=await import('../oracle/loyaltylion.js');
 const f=loyaltyFixture({failure:'points'}),context=scope('Show LoyaltyLion overview for October 2026'),r=await answerLoyaltyReport({context,provider:f.provider}),count=f.queries.length;
 const recovered=deliverOracleResult({...r,answer:null,presentation:null},context,{present:()=>{throw Error('renderer fixture failed');}});assert.match(recovered.answer,/Gold/);assert.match(recovered.answer,/LOYALTY_SECTION_ACCESS_UNAVAILABLE/);assert.equal(f.queries.length,count);
});

test('fresh requested XLSX shares retained export path; numeric movement cells and scope survive',async t=>{
 const f=loyaltyFixture(),h=await acceptanceServer(f,{now:LOYALTY_NOW});t.after(h.close);
 const r=await h.submit('Export LoyaltyLion points daily for October 2026 to Excel',{fresh:true});assert(r.artifact,JSON.stringify(r));assert.equal(r.analysis_context.grain,'day');assert.equal(f.queries.filter(q=>q.labels.operation==='points').length,1);
 const response=await fetch(h.origin+r.artifact.download_url,{headers:{cookie:h.headers.cookie}}),wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));assert(wb.worksheets.some(s=>s.getSheetValues().flat(2).includes(-20)));
});

test('unsupported purchasing values and weekly grain cannot silently become linkage counts or daily rows',async()=>{
 const f=loyaltyFixture();const values=scope('Show LoyaltyLion purchasing revenue for October 2026'),r=await f.provider(values);assert.equal(r.sections[0].code,'LOYALTY_PURCHASING_VALUES_UNAVAILABLE');
 const daily=scope('Show LoyaltyLion points daily for October 2026'),weekly=scope('By week',daily),w=await f.provider(weekly);assert.equal(w.sections[0].code,'LOYALTY_GRAIN_UNSUPPORTED');
});
