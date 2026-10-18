import { acceptanceFixture } from './helpers/oracle-acceptance.js';
import {readFileSync} from 'node:fs';
const {INITIAL,DETAIL,UNDERLYING}=JSON.parse(readFileSync(new URL('./fixtures/oracle-multipart-questions.json',import.meta.url)));
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import express from 'express';
import { population,order,line } from './helpers/basket-fixture.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { executeGovernedAgentAnalysis } from '../oracle/analysis-route-dispatcher.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import { createOracleBaselineDispatcher } from '../oracle/baseline-dispatcher.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { assertProductArtifact } from '../oracle/product-artifact-validation.js';
import { assertBasketEvidence,basketComposition,anonymousBasketRows } from '../oracle/basket-composition.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';



const NOW=Date.parse('2026-10-18T12:00:00Z'),apply=(c,m)=>transitionAnalysisContext(c,m,{now:NOW}).context;
function fixture({rows=population(),fail=false,store=createMemoryExportStore()}={}){
 const calls=[];const overview=createBaselineOverviewService({now:()=>new Date(NOW),socialExportStore:store,basketComposition:async(scope)=>{calls.push({kind:'basket',scope});if(fail)throw Error('read failed');return {scope,rows,coverage:{complete:false}};},orderValues:async(scope)=>{calls.push({kind:'orders',scope});return {scope,rows:rows.map(r=>({date:r.date,amount:Number(r.merchandise_amount),merchandise_amount:Number(r.merchandise_amount),shipping_charge:null,orders:1})),coverage:{eligible_orders:rows.length,complete:false}};}});
 return {calls,store,baseline:createOracleBaselineDispatcher({ecommerceBaselineOverview:overview}),run(message,analysisContext=null,requestId='multipart-1'){return executeGovernedAgentAnalysis({message,analysisContext,baselineOverview:this.baseline,now:NOW,baselineOptions:{exportStore:store,exportOwner:'owner',requestId}});}};
}
async function workbook(f,r){assert.ok(r.artifact, r.answer);const saved=await f.store.get(r.artifact.id,'owner');assert.ok(saved);await assertProductArtifact(saved);const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));return {saved,book};}
test('multipart exact request executes both governed populations, mean/median, width, comparisons, charts and persisted XLSX',async()=>{
 for(const previous of [null,apply(null,'Show mobile and desktop conversion for September 2026.')]){const f=fixture(),r=await f.run(INITIAL,previous);assert.deepEqual(f.calls.map(c=>c.kind),['basket','orders']);for(const {scope} of f.calls){assert.equal(scope.start_date,'2026-01-01');assert.equal(scope.end_date,'2026-10-17');assert.equal(scope.country,'GB');assert.equal(scope.currency,'GBP');assert.equal(scope.channel,'online');}assert.ok(r.evidence.components.every(c=>c.status==='supported'||c.status==='conditional'));assert.ok(r.evidence.order_result);assert.equal(r.evidence.order_result.evidence.sections[0].population,10);assert.equal(r.evidence.sections[0].reconciled_orders,7);assert.equal(r.evidence.order_result.evidence.sections[0].bands[1].lower,25);assert.match(r.answer,/denominators differ/);assert.ok(r.charts.length);assert.ok(r.answer.includes(r.artifact.download_url));const {book}=await workbook(f,r);assert.ok(book.getWorksheet('Order Order statistics'));assert.ok(book.getWorksheet('Combinations'));assert.equal(r.component_outcomes.find(c=>c.component==='xlsx').status,'delivered');}
});
test('exact follow-ups change subset, output and workbook; unrelated incident counts never drive membership',async()=>{
 const f=fixture(),initial=await f.run(INITIAL),detail=await f.run(DETAIL,initial.analysis_context,'detail-1');const s=detail.evidence.sections[1];assert.equal(s.subset_orders,4);assert.deepEqual(s.bands.map(b=>b.orders),[1,1,1,1]);assert.equal(s.overlap_orders,2);assert.equal(s.subset_mixed_products,3);assert.equal(s.subset_repeated_product,1);assert.match(detail.presentation.summary_markdown,/4 reconciled baskets/);assert.doesNotMatch(detail.presentation.summary_markdown,/113|Additional items required/);const {book}=await workbook(f,detail);const bands=book.getWorksheet('Basket bands').getSheetValues();assert.equal(bands.length,6);assert.deepEqual(bands.slice(2).map(r=>r[2]),[260,275,300,undefined]);assert.ok(JSON.stringify(book.getWorksheet('Combinations').getSheetValues()).includes('Product 4'));
 const underlying=await f.run(UNDERLYING,detail.analysis_context,'underlying-1');const {saved,book:rowsBook}=await workbook(f,underlying);const rows=saved.envelope.anonymous_rows;assert.equal(rows.length,7);assert.equal(rows.filter(r=>r.sale_excluded).length,1);assert.equal(rows.reduce((n,r)=>n+r.merchandise_subtotal,0),1769.99);assert.equal(rows.find(r=>r.highest_product==='Product 4').remaining_quantity,1);assert.equal(rows.find(r=>r.highest_product==='Product 4').remaining_discounted_value,125);assert.ok(rows.every(r=>/^[a-f0-9]{32}$/.test(r.basket_reference)));assert.ok(rowsBook.getWorksheet('Anonymous baskets'));assert.doesNotMatch(JSON.stringify(rows),/order_id|email|phone|gid:|line_item|admin/);const other=await f.run(UNDERLYING,detail.analysis_context,'underlying-2');const otherSaved=await f.store.get(other.artifact.id,'owner');assert.notEqual(otherSaved.envelope.anonymous_rows[0].basket_reference,rows[0].basket_reference);assert.equal(await f.store.get(underlying.artifact.id,'other-owner'),null);
 const damaged=structuredClone(saved);damaged.envelope.anonymous_rows[0].merchandise_subtotal++;assert.throws(()=>assertBasketEvidence(damaged.analysis_context,damaged.envelope),{code:'EVIDENCE_SCOPE_MISMATCH'});
});
test('changed exact bands, thresholds, highest-unit interval and inclusive exclusion dates are independent',()=>{
 let c=apply(null,INITIAL);c=apply(c,'Of baskets that reached £225 only through multiple items, show £225–£239.99, £240–£259.99 and £260+. Highest individual item worth £175–£224.99. Exclude 2–3 May inclusive.');assert.equal(c.request_detail.subset.total_at_least,22500);assert.deepEqual(c.request_detail.bands,[{lower:22500,upper:24000},{lower:24000,upper:26000},{lower:26000,upper:null}]);assert.deepEqual(c.request_detail.overlap,{lower:17500,upper:22500});assert.equal(c.start_date,'2026-01-01');assert.equal(c.promotion_context.supplied_periods[0].start_date,'2026-05-02');const result=basketComposition(population(),[225],'GBP',c.request_detail);assert.equal(result.subset_orders,3);assert.equal(result.overlap_orders,1);assert.throws(()=>apply(c,'Show £250–£279.99 and £260–£299.99.'),/Invalid requested bands/);
});
test('export failure retains valid evidence; recovery rejects a repeated summary or altered detail',async()=>{
 const store=createMemoryExportStore(),f=fixture({store}),initial=await f.run(INITIAL);store.put=async()=>{throw Object.assign(Error('size'),{code:'EXPORT_STORAGE_SIZE_EXCEEDED'});};const r=await f.run(DETAIL,initial.analysis_context,'failed-export');assert.equal(r.export_outcome.status,'failed');assert.equal(r.component_outcomes.find(c=>c.component==='xlsx').status,'failed');assert.equal(r.evidence.sections[1].subset_orders,4);assert.equal(r.artifact,undefined);assert.match(r.answer,/Export persistence failed/);const count=f.calls.length;const recovered=deliverOracleResult(r,r.analysis_context);assert.equal(f.calls.length,count);assert.equal(recovered.evidence.sections[1].subset_orders,4);const wrong=deliverOracleResult({...r,evidence:initial.evidence,analysis_unavailable:false},r.analysis_context);assert.equal(wrong.delivery.code,'ANSWER_INCOMPLETE');
});
test('empty evidence and provider failure do not invent supported nonzero findings or workbook completion',async()=>{
 const empty=fixture({rows:[]}),r=await empty.run(INITIAL);assert.equal(r.evidence.sections[0].reconciled_orders,0);assert.equal(r.analysis_unavailable,true);const failed=fixture({fail:true}),bad=await failed.run(INITIAL);assert.equal(bad.evidence.retrieval_failed,true);assert.equal(bad.artifact,undefined);assert.equal(bad.export_outcome.status,'failed');assert.equal(bad.evidence.order_result.evidence.sections[0].population,10);
});
for(const durable of [false,true])test(`exact detail and XLSX authenticate, persist and recover (${durable?'durable':'interactive'})`,async t=>{
 const f=fixture(),jobs=createMemoryAnalysisJobStore(),app=express();app.use('/api/oracle',createOracleUiRouter({baselineOverview:f.baseline,chat:async()=>assert.fail('model fallback'),knowledgeService:{},exportStore:f.store,analysisJobStore:jobs,generateProposals:async()=>[],env:{ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'fixture-secret-long-enough-32-characters',ORACLE_ANALYSIS_JOBS_ENABLED:String(durable)},now:()=>NOW}));const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`,origin=base;const login=await fetch(base+'/api/oracle/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password:'fixture'})}),auth=await login.json(),headers={cookie:login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '),origin,'content-type':'application/json','x-csrf-token':auth.csrf};let n=0;
 const send=async message=>{const id=`multipart-${durable}-${++n}`;const sendRequest=()=>fetch(base+'/api/oracle/'+(durable?'jobs':'chat'),{method:'POST',headers:{...headers,'x-request-id':id},body:JSON.stringify({message})});const response=await sendRequest();let r=await response.json();if(durable){const job=r.job_id;const retry=await(await sendRequest()).json();assert.equal(retry.job_id,job);for(let i=0;i<300;i++){r=await(await fetch(base+'/api/oracle/jobs/'+job,{headers})).json();if(['completed','failed'].includes(r.status))break;await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(r.status,'completed',JSON.stringify(r));}return r;};
 await send(INITIAL);const detail=await send(DETAIL);assert.equal(detail.evidence.sections[1].subset_orders,4);const r=await send(UNDERLYING);const download=await fetch(base+r.artifact.download_url,{headers});assert.equal(download.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));assert.equal(wb.getWorksheet('Anonymous baskets').rowCount,8);assert.equal((await fetch(base+r.artifact.download_url)).status,401);const count=f.calls.length;const recovered=await(await fetch(base+r.artifact.download_url+'/manifest',{headers})).json();assert.equal(recovered.evidence.anonymous_rows.length,7);if(durable){const again=await(await fetch(base+'/api/oracle/jobs/'+r.job_id,{headers})).json();assert.deepEqual(again.artifact,r.artifact);}assert.equal(f.calls.length,count);
});

test('unbound same-population references require dates/exclusions; supported detail does not default to a new population',async()=>{
 for(const prior of [null,apply(null,'Show mobile and desktop conversion for September 2026.')])for(const question of [DETAIL,UNDERLYING]){const f=fixture(),r=await f.run(question,prior);assert.ok(r.clarification);assert.equal(f.calls.length,0);assert.ok(r.clarification.fields.includes('start_date'));assert.ok(r.clarification.fields.includes('promotion_context'));assert.match(r.answer,/earlier analysis cannot be resolved/);}
 const f=fixture(),r=await f.run(INITIAL);const calls=f.calls.length;const retry=await f.run(INITIAL,null);assert.equal(f.calls.length,calls);assert.deepEqual(retry.artifact,r.artifact);const c=apply(apply(r.analysis_context,DETAIL),'Show aggregates only.');assert.equal(c.request_detail.level,'aggregate');const aggregate=await f.run('Show aggregates only.',apply(r.analysis_context,DETAIL),'aggregate-subset');assert.equal(aggregate.evidence.sections[1].comparisons.find(v=>v.threshold===250).additional_items_required,4);assert.equal(aggregate.evidence.sections[1].comparisons.find(v=>v.threshold===250).highest_unit_already_qualifies,0);assert.match(aggregate.answer,/same 4 selected/);
});

test('valid zero subset is calculated and chart or workbook tampering is rejected',async()=>{
 const f=fixture(),r=await f.run(INITIAL);const zero=await f.run('Show baskets with highest individual unit below £100 and combined merchandise value at least £1000. Show £1000+ and most common combinations. Export supporting tables.',r.analysis_context,'zero-subset');assert.equal(zero.evidence.sections[0].subset_orders,0);assert.equal(zero.evidence.sections[0].bands[0].orders,0);assert.ok(zero.artifact);assert.match(zero.answer,/0 reconciled baskets/);
 const underlying=await f.run(UNDERLYING,r.analysis_context,'tamper-rows');const e=structuredClone(underlying.evidence);delete e.anonymous_rows;assert.throws(()=>assertBasketEvidence(underlying.analysis_context,e),{code:'EVIDENCE_SCOPE_MISMATCH'});
 const changed=structuredClone(r.evidence);changed.chart_datasets[0].points[0].value++;assert.throws(()=>assertBasketEvidence(r.analysis_context,changed),{code:'EVIDENCE_SCOPE_MISMATCH'});
});

test('shared campaign/conversion exports and cohort calendar refinement account for executed outputs',async()=>{
 for(const [options,question,kind] of [[{campaigns:true},'How did the last 3 Klaviyo campaigns go?','governed_klaviyo_campaign_set'],[{country_conversion:true},'Compare UK visitor conversion with global visitor conversion for 2026.','governed_population_conversion'],[{retention:true},'Rank collaborations by repeat purchase rate after their first order online in 2025.','governed_cohort_retention']]){
  const now=Date.parse('2026-10-14T12:00Z'),f=acceptanceFixture(options);const first=await executeGovernedAgentAnalysis({message:question,baselineOverview:f.baseline,now});assert.equal(first.evidence.kind,kind);
  const exported=await executeGovernedAgentAnalysis({message:'Export the current result to XLSX.',analysisContext:first.analysis_context,baselineOverview:f.baseline,baselineOptions:{exportOwner:'owner',requestId:'cross-family'},now});
  if(options.retention){assert.equal(exported.component_outcomes.find(c=>c.component==='xlsx').status,'unsupported');assert.equal(exported.artifact,undefined);}else {assert.equal(exported.component_outcomes.find(c=>c.component==='xlsx').status,'delivered');const saved=await f.exportStore.get(exported.artifact.id,'owner');await assertProductArtifact(saved);assert.equal(saved.envelope.kind,kind);}
  const before=f.calls.length;
  if(options.retention||options.campaigns){const regrouped=await executeGovernedAgentAnalysis({message:'By week instead',analysisContext:first.analysis_context,baselineOverview:f.baseline,now});assert.equal(regrouped.analysis_unavailable,true);assert.equal(f.calls.length,before);assert.match(regrouped.answer,/grouping|regrouping/);}
 }
});

test('source proof hides raw order identities and legacy basket envelopes retain their original recovery contract',async()=>{
 const f=fixture(),r=await f.run('Show UK online GBP basket composition this year.');assert.ok(r.evidence.source_rows.every(row=>/^[a-f0-9]{64}$/.test(row.order_id)));
 const legacy=structuredClone(r.evidence),context={...r.analysis_context,request_detail:null};delete legacy.detail;delete legacy.export_scope;delete legacy.analytical_plan.request_detail;
 for(const section of legacy.sections){for(const k of ['subset_orders','overlap_orders','subset_mixed_products','subset_repeated_product'])delete section[k];for(const combo of section.combinations)delete combo.above_threshold;}
 assertBasketEvidence(context,legacy);assert.ok(anonymousBasketRows({...r.evidence,promotion:{status:'unavailable',dates:[]}}).every(row=>row.sale_excluded===null));
});

test('requested fixed-width order bands extend above the former fixed display ceiling',async()=>{
 const f=fixture({rows:[...population(),order('expensive',[line('1',1,524.99)])]}),r=await f.run(INITIAL);const sections=r.evidence.order_result.evidence.sections;assert.equal(sections[0].bands.find(b=>b.lower===500).orders,1);assert.equal(sections[0].bands.find(b=>b.lower===500).upper,525);assert.equal(sections[0].bands.find(b=>b.lower===350).orders,0);
});

test('XLSX validation rejects renamed columns and extra sheets, including with a recomputed byte hash',async()=>{
 const {createHash}=await import('node:crypto'),f=fixture(),r=await f.run(INITIAL);const {saved,book}=await workbook(f,r);
 for(const change of [b=>{b.getWorksheet('Combinations').getCell('A1').value='unverified';},b=>{b.addWorksheet('Private customer data');}]){const b=new ExcelJS.Workbook();await b.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));change(b);const bytes=Buffer.from(await b.xlsx.writeBuffer());await assert.rejects(()=>assertProductArtifact({...saved,xlsx_base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}),{code:'EVIDENCE_SCOPE_MISMATCH'});}
 assert.ok(book.getWorksheet('Combinations'));
});

test('direct agent exports retain the authenticated download base and delivered outcome',async()=>{
 const f=fixture(),r=await executeGovernedAgentAnalysis({message:INITIAL,baselineOverview:f.baseline,now:NOW,baselineOptions:{exportOwner:'direct-owner',requestId:'direct-basket',downloadBase:'/agent/exports'}});assert.match(r.artifact.download_url,/^\/agent\/exports\/[a-f0-9]{64}$/);assert.equal(r.component_outcomes.find(c=>c.component==='xlsx').status,'delivered');assert.ok(await f.store.get(r.artifact.id,'direct-owner'));assert.equal(await f.store.get(r.artifact.id,'owner'),null);
});
