import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ExcelJS from 'exceljs';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {blackFridayRoutingFixture,routingPrompts} from './helpers/black-friday-routing-fixture.js';
import {explicitKnowledgeSaveIntent} from '../oracle/clarification-consumption.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveAnalysisDecision} from '../oracle/analysis-decision.js';
const now=Date.parse('2026-11-04T12:00:00Z');
test('both exact failures were reproduced at the independently verified running revision',()=>{
 const traces=JSON.parse(readFileSync(new URL('./fixtures/black-friday-routing-415/before-traces.json',import.meta.url))),revision=JSON.parse(readFileSync(new URL('./fixtures/black-friday-routing-415/render-revision.json',import.meta.url)));
 assert.equal(revision.local.revision,revision.public.revision);assert.equal(revision.checkout,revision.local.revision);
 for(const t of traces){assert.equal(t.local_code_base,revision.local.revision);assert.equal(t.prompt,routingPrompts[t.name]);assert.equal(t.provider_calls,0);}
 assert.equal(traces[0].resolved.operations[0],'product_attribution');assert.equal(traces[1].knowledge_save,true);assert.deepEqual(traces[1].fallback,['export_product_priorities']);assert.ok(traces[1].helper_scope);
});
for(const [name,message]of Object.entries(routingPrompts))test(`${name}: shared context owns the sale event before attribution or product classification`,()=>{
 assert.equal(explicitKnowledgeSaveIntent(message),false);const r=transitionAnalysisContext(null,message,{now});
 assert.equal(r.context.tool_route,'compare_historical_events');assert.equal(r.context.request_kind,null);assert.deepEqual(r.context.requested_operations,[]);assert.equal(r.context.product_report,null);assert.deepEqual(r.context.event_scope.years,[2025,2024]);assert.equal(r.context.event_scope.products,true);assert.equal(r.context.event_scope.source_policy,'bf-2024-2025-v1');
 const d=resolveAnalysisDecision(r.context);assert.equal(d.outcome,'execution');assert.equal(d.scope_method,'governed_event_knowledge');assert.equal(d.execution.plan.operation,'named_event_comparison');assert.equal(r.context.start_date,null);assert.equal(r.context.end_date,null);
});
for(const durable of [false,true])for(const [name,message]of Object.entries(routingPrompts))test(`${name}: real ${durable?'durable':'interactive'} chat/preflight dispatch with both competing producers present`,async t=>{
 const f=blackFridayRoutingFixture(),h=await acceptanceServer(f,{durable,now,revision:'fixture-fixed'});t.after(h.close);
 const pre=await fetch(h.base+'/analysis/route',{method:'POST',headers:h.headers,body:JSON.stringify({message,new_question:true})});assert.equal(pre.status,200);const preview=await pre.json();assert.equal(preview.tool_route,'compare_historical_events');assert.equal(preview.operation,'named_event_comparison');assert.equal(preview.capability_selection.registered,true);assert.equal(preview.providers_attempted,0);assert.equal(preview.deployed_revision,'fixture-fixed');assert.equal(f.calls.length,0);
 const r=await h.submit(message,{fresh:true,id:`routing-${name}-${durable}`});assert.deepEqual(f.attempts,['compare_historical_events']);assert.equal(r.analysis_context.tool_route,preview.tool_route);assert.deepEqual(r.analysis_context.event_scope,preview.event_scope);assert.equal(r.evidence.version,'event_sale_report.v2');assert.equal(r.evidence.sections.length,5);
 const w=r.evidence.sections.map(s=>s.window);assert.equal(w.filter(s=>s.year===2025&&s.channel==='online').length,2);assert.ok(w.some(s=>s.year===2024&&s.location_name==='Soho'&&s.start_at==='2024-11-07T12:00:00Z'));assert.ok(w.some(s=>s.year===2024&&s.location_name==='East'&&s.start_at==='2024-11-09T10:30:00Z'));assert.ok(!w.some(s=>s.year===2025&&s.channel==='instore'));
 const pending=r.evidence.sections.find(s=>s.window.year===2024&&s.window.channel==='online');assert.equal(pending.totals.code,'AMBIGUOUS_MIDNIGHT_ENDPOINT');assert.ok(!f.calls.some(c=>['finance','products'].includes(c.provider)&&c.args.time_issue));
 assert.match(r.answer,/Ring A/);assert.match(r.answer,/2025 public campaign/);assert.match(r.answer,/2025 VIP early access/);assert.doesNotMatch(r.answer,/Product attribution is unavailable|current Online Store published|Resolved dates:.*2025-01-01/);assert.equal(r.evidence.analytical_plan.operation,'named_event_comparison');assert.ok(f.stages.some(s=>s.stage==='event_capability_selection'));
 const fixed=await h.submit('end of november the 10th',{id:`endpoint-${name}-${durable}`});assert.match(fixed.answer,/2024-11-11T00:00:00Z/);
 const n=f.calls.length,sheet=await h.submit('Can I have this as a spreadsheet',{id:`sheet-${name}-${durable}`});assert.equal(f.calls.length,n);const dl=await fetch(h.origin+sheet.artifact.download_url,{headers:h.headers});assert.equal(dl.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await dl.arrayBuffer()));assert.match(JSON.stringify(wb.worksheets.map(s=>s.getSheetValues())),/Ring A/);assert.ok(!f.attempts.includes('export_product_priorities'));
});
for(const failure of ['failProducts','failTotals','failKnowledge'])test(`historical ${failure} remains inside the Black Friday answer`,async t=>{
 const f=blackFridayRoutingFixture({[failure]:true}),h=await acceptanceServer(f,{now});t.after(h.close);const r=await h.submit(routingPrompts.short,{fresh:true,id:failure});assert.equal(r.analysis_context.tool_route,'compare_historical_events');assert.equal(r.partial,true);assert.deepEqual(f.attempts,['compare_historical_events']);assert.match(r.answer,/Black Friday sale periods/);assert.doesNotMatch(r.answer,/current Online Store published|Product attribution is unavailable/);if(failure==='failProducts')assert.match(r.answer,/200/);if(failure==='failTotals')assert.match(r.answer,/Ring A/);
});
test('source-specific unsupported selection blocks only the affected historical channel/year',async t=>{
 const f=blackFridayRoutingFixture(),h=await acceptanceServer(f,{now});t.after(h.close);
 const r=await h.submit('Compare Black Friday sales and products sold in 2025 and 2024 online and in-store. For 2024 use Shopify online.',{fresh:true,id:'unsupported-source'});
 assert.equal(r.analysis_context.tool_route,'compare_historical_events');assert.match(r.answer,/EVENT_REQUESTED_SOURCE_UNSUPPORTED/);assert.match(r.answer,/Ring A/);assert.ok(!f.calls.some(c=>['finance','products'].includes(c.provider)&&c.args.year===2024&&c.args.channel==='online'));assert.ok(f.calls.some(c=>c.provider==='finance'&&c.args.year===2025));assert.ok(!f.attempts.includes('export_product_priorities'));
});
test('session and source wording variants preserve historical scope; non-sale domains stay separate',()=>{
 for(const message of [routingPrompts.long.replace('each session','each sale session'),routingPrompts.short.replace('in-store','in store'),routingPrompts.short.replace('knowledge base','stored event records'),'Compare 2025 and 2024 Black Friday sales and products with traffic metrics.'])assert.equal(transitionAnalysisContext(null,message,{now}).context.tool_route,'compare_historical_events');
 assert.notEqual(transitionAnalysisContext(null,'Compare Black Friday visitor session counts in 2025 and 2024',{now}).context.tool_route,'compare_historical_events');
 for(const message of ['Compare in-store sales using our knowledge base.','Show store sales from knowledge.','Add net sales using our knowledge base.'])assert.equal(explicitKnowledgeSaveIntent(message),false);
 for(const message of ['Save this as a knowledge record.','Could you store this as a governed rule?','Add a fact about the sale dates.','Compare sales and then remember this as a policy.'])assert.equal(explicitKnowledgeSaveIntent(message),true);
});
test('a stale current-product clarification cannot consume either complete event request',async t=>{
 const f=blackFridayRoutingFixture(),h=await acceptanceServer(f,{now});t.after(h.close);
 const seed=await h.submit('Show products sold online and in-store.',{fresh:true,id:'seed-product'});assert.equal(seed.analysis_context.tool_route,'export_product_priorities');
 for(const [name,message]of Object.entries(routingPrompts)){f.attempts.length=0;const r=await h.submit(message,{id:'after-product-'+name});assert.equal(r.analysis_context.tool_route,'compare_historical_events');assert.deepEqual(f.attempts,['compare_historical_events']);assert.equal(r.analysis_context.product_report,null);}
});

test('endpoint clarification retains an unsupported historical source selection',()=>{
 const c=transitionAnalysisContext(null,'Compare Black Friday 2025 online WooCommerce, 2024 online Shopify.',{now}).context;
 const next=transitionAnalysisContext(c,'end of november the 10th',{now}).context;
 assert.deepEqual(next.event_scope.unsupported_sources,c.event_scope.unsupported_sources);assert.equal(next.event_scope.endpoint_choice,'end_of_day');
});
for(const [name,message]of Object.entries(routingPrompts))test(`${name}: direct agent shares historical scope and renderer`,async t=>{
 const f=blackFridayRoutingFixture(),h=await acceptanceServer(f,{now});t.after(h.close);
 const response=await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message})});assert.equal(response.status,200);const r=await response.json();assert.match(r.answer,/2025 VIP early access/);assert.match(r.answer,/Ring A/);assert.deepEqual(f.attempts,['compare_historical_events']);
});
