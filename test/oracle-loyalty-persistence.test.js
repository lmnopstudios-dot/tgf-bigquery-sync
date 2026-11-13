import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {exportRetainedSpreadsheet,assertRetainedSpreadsheet} from '../oracle/retained-spreadsheet.js';
import {emptyAnalysisContext} from '../oracle/analysis-context.js';
import {performanceFixture} from './helpers/loyalty-performance-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
import {exportJsonWire} from './helpers/export-json-wire.js';
import {durableJsonWire} from './helpers/durable-json-wire.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
const now=Date.parse('2026-11-13T18:00:00Z');
for(const durable of [false,true])test(`LoyaltyLion performance survives canonical export JSON through ${durable?'durable':'interactive'} chat`,async t=>{
 const f=performanceFixture(),exports=exportJsonWire(),jobs=durableJsonWire({canonicalObjectKeys:true});f.exportStore=exports.store;
 const h=await acceptanceServer(f,{durable,now,jobStore:durable?jobs.store:null});t.after(h.close);
 const result=await h.submit('LoyaltyLion performance report',{fresh:true});assert(result.artifact,JSON.stringify(result));assert.equal(result.evidence.performance.tables.find(t=>t.section==='purchasing').rows[0].eligible_orders,3);
 const count=f.queries.length;
 const response=await fetch(h.origin+result.artifact.download_url,{headers:{cookie:h.headers.cookie}});assert.equal(response.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));assert(wb.getWorksheet('Customer purchasing'));assert(wb.getWorksheet('Coverage'));
 const original=JSON.parse([...exports.rows.values()][0]);
 const damaged=structuredClone(original),sheet=wb.getWorksheet('Customer purchasing'),column=sheet.getRow(1).values.indexOf('eligible_orders');
 sheet.getRow(2).getCell(column).value=999;
 const badBytes=Buffer.from(await wb.xlsx.writeBuffer());damaged.xlsx_base64=badBytes.toString('base64');damaged.sha256=createHash('sha256').update(badBytes).digest('hex');
 await assert.rejects(()=>assertRetainedSpreadsheet(damaged),{code:'EXPORT_INTEGRITY_FAILED'});

 const again=await fetch(h.origin+result.artifact.download_url,{headers:{cookie:h.headers.cookie}});assert.equal(again.status,200);assert.equal(f.queries.length,count);
 const exported=await h.submit('Export those results to Excel');assert(exported.artifact);assert.equal(f.queries.length,count);
 if(durable){const recovered=await h.get('/jobs/'+result.job_id);assert.equal(recovered.artifact.id,result.artifact.id);assert.equal(f.queries.length,count);}
 assert.notEqual((await fetch(h.origin+result.artifact.download_url)).status,200);
 const refined=await h.submit('For October 2026');assert.equal(refined.analysis_context.start_date,'2026-10-01');assert(refined.artifact);
});
test('canonical scope equality accepts key order only; dates, labels, programme and populations still fail closed',async()=>{
 const f=performanceFixture(),context=transitionAnalysisContext(null,'LoyaltyLion performance report',{now}).context,e=await f.provider(context);
 const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
 const saved=canonical(e);assertEvidenceAgreement(context,saved);
 for(const mutate of [v=>v.loyalty_scope.program_id='999',v=>v.performance.windows[0].end_date='2026-11-12',v=>v.performance.windows[0].label='Other',v=>v.loyalty_scope.sections.reverse(),v=>v.performance.tables[0].rows[0].period='Other']){
  const bad=structuredClone(saved);mutate(bad);assert.throws(()=>assertEvidenceAgreement(context,bad));
 }
});

test('ordinary LoyaltyLion overview export also survives the production JSON store without rereading providers',async t=>{
 const f=performanceFixture(),exports=exportJsonWire();f.exportStore=exports.store;
 const h=await acceptanceServer(f,{now});t.after(h.close);
 await h.submit('Show LoyaltyLion overview for October 2026',{fresh:true});const count=f.queries.length;
 const result=await h.submit('Export those results to Excel');assert(result.artifact,JSON.stringify(result));assert.equal(f.queries.length,count);
 const response=await fetch(h.origin+result.artifact.download_url,{headers:{cookie:h.headers.cookie}});assert.equal(response.status,200);assert.equal(f.queries.length,count);
});

test('shared generic workbook keeps nested tables, currencies, nulls and source rows across canonical JSON',async()=>{
 const wire=exportJsonWire(),context=emptyAnalysisContext(),now=Date.now();
 const evidence={kind:'retained_fixture',z_rows:[{period:'2026-01',currency:'USD',orders:2,value:null},{period:'2026-01',currency:'GBP',orders:3,value:100}],a_nested:{rows:[{label:'Other group',denominator:5,observed_rate:0.4}]},coverage:{complete:false}};
 const r=await exportRetainedSpreadsheet({context,store:wire.store,owner:'synthetic-owner',requestId:'generic',assertAgreement:assertEvidenceAgreement,recent:{evidence,answer:'Synthetic partial report',retained_at:new Date(now).toISOString()},now});
 assert(r.artifact);const saved=await wire.store.get(r.artifact.id,'synthetic-owner');await assertRetainedSpreadsheet(saved);
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(saved.xlsx_base64,'base64'));
 const s=wb.getWorksheet('z_rows');assert(s);const columns=s.getRow(1).values;
 assert.equal(s.getRow(2).getCell(columns.indexOf('currency')).value,'USD');assert.equal(s.getRow(3).getCell(columns.indexOf('currency')).value,'GBP');assert.equal(s.getRow(2).getCell(columns.indexOf('value')).value,null);
});

test('direct governed report entrypoint persists and exports canonical loyalty evidence without replay',async()=>{
 const {executeGovernedAgentAnalysis}=await import('../oracle/analysis-route-dispatcher.js');
 const f=performanceFixture(),wire=exportJsonWire(),message='LoyaltyLion performance report',context=transitionAnalysisContext(null,message,{now}).context;
 const result=await executeGovernedAgentAnalysis({message,analysisContext:context,scopeResolved:true,baselineOverview:f.baseline,baselineOptions:{exportStore:wire.store,exportOwner:'direct-owner',requestId:'direct-report',now},now});
 assert(result.artifact);const count=f.queries.length;
 const again=await executeGovernedAgentAnalysis({message:'Export those results to Excel',analysisContext:context,scopeResolved:true,baselineOverview:f.baseline,baselineOptions:{exportStore:wire.store,exportOwner:'direct-owner',requestId:'direct-export',recentEvidence:result,now},now});
 assert(again.artifact);assert.equal(f.queries.length,count);
});
