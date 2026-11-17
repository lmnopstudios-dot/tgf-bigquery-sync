import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {assertKpiArtifact} from '../oracle/kpi-dashboard.js';
import {assertWorksheetEvidence} from '../oracle/workbook-evidence.js';
import {kpiJobError} from '../public/oracle/kpi-dashboard.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {kpiFixture,KPI_NOW} from './helpers/kpi-fixture.js';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const context=transitionAnalysisContext(null,'KPI dashboard',{now:KPI_NOW}).context;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const retained=async()=>{const f=kpiFixture(),r=await f.service('KPI dashboard',{analysisContext:context,now:KPI_NOW,exportOwner:'owner',requestId:'json-order'});return {f,r,a:await f.exportStore.get(r.artifact.id,'owner')};};
const rebytes=async(a,change)=>{const w=new ExcelJS.Workbook();await w.xlsx.load(Buffer.from(a.xlsx_base64,'base64'));change(w);const b=Buffer.from(await w.xlsx.writeBuffer());return {...a,xlsx_base64:b.toString('base64'),sha256:createHash('sha256').update(b).digest('hex')};};
test('KPI artifact survives production BigQuery JSON canonicalization and repeated hydration',async()=>{
 const {a,f,r}=await retained();await assertKpiArtifact(canonical(a));const calls=f.calls.length;
 const again=await f.service('KPI dashboard',{analysisContext:context,now:KPI_NOW,exportOwner:'owner',requestId:'json-order'});assert.equal(again.artifact.id,r.artifact.id);assert.equal(f.calls.length,calls);
});
test('legacy KPI workbook keeps original column order and insertion-order baseline text',async()=>{
 const {a}=await retained(),e=a.envelope;
 const legacy=await rebytes(a,w=>{const sheet=w.getWorksheet('Definitions and coverage'),b=e.baseline;for(let i=2;i<=sheet.rowCount;i++)if(sheet.getCell(i,1).value==='Baseline'&&String(sheet.getCell(i,2).value).startsWith('{'))sheet.getCell(i,2).value=JSON.stringify({id:b.id,label:b.label,start_date:b.start_date,end_date:b.end_date,fixed:b.fixed});});
 await assertKpiArtifact(canonical(legacy));
});
test('header-based workbook validation rejects duplicate/missing columns, wrong values, extra sheets and hash tampering',async()=>{
 const {a}=await retained();
 for(const change of [w=>{w.getWorksheet('KPI summary').getCell(1,2).value=w.getWorksheet('KPI summary').getCell(1,1).value;},w=>{w.getWorksheet('KPI summary').getCell(2,1).value='tampered';},w=>{w.addWorksheet('Unexpected');}]){
  const tampered=await rebytes(a,change);await assert.rejects(assertKpiArtifact(tampered),e=>e.code==='KPI_ARTIFACT_INVALID'&&e.failed_stage==='kpi_export_validation');
 }
 await assert.rejects(assertKpiArtifact({...a,sha256:'0'.repeat(64)}),{code:'KPI_ARTIFACT_INVALID'});
 // Only the Baseline explanatory JSON cell is order-normalized; monetary/text cells remain exact.
 const bad=await rebytes(a,w=>{const s=w.getWorksheet('Definitions and coverage');for(let i=2;i<=s.rowCount;i++)if(s.getCell(i,1).value==='Baseline')s.getCell(i,2).value='{"fixed":true}';});await assert.rejects(assertKpiArtifact(bad),{code:'KPI_ARTIFACT_INVALID'});
});
test('shared worksheet validator preserves row order and exact null, zero, false and decimal strings',()=>{
 const w=new ExcelJS.Workbook(),s=w.addWorksheet('Evidence');s.addRows([['label','amount','flag'],['A','0.00',false],['B',null,true]]);
 assertWorksheetEvidence(s,[{flag:false,amount:'0.00',label:'A'},{label:'B',flag:true,amount:null}]);
 assert.throws(()=>assertWorksheetEvidence(s,[{flag:true,amount:null,label:'B'},{label:'A',flag:false,amount:'0.00'}]));
 s.getCell(2,2).value=0;assert.throws(()=>assertWorksheetEvidence(s,[{flag:false,amount:'0.00',label:'A'},{label:'B',flag:true,amount:null}]));
});
test('failed KPI job recovers an owned persisted workbook by polling and downloading without another provider call',async()=>{
 const f=kpiFixture({failReadbackOnce:true}),h=await acceptanceServer(f,{durable:true,now:KPI_NOW});try{
  const r=await h.submit('KPI dashboard',{fresh:true,id:'a3420369-000c-46c9-99c9-71f28a74e2cf'});
  assert.equal(r.recovered_persisted_export,true);assert.equal(r.evidence.kind,'kpi_dashboard');assert.equal(f.calls.length,1);
  const again=await h.get('/jobs/'+r.job_id);assert.equal(again.recovered_persisted_export,true);assert.equal(f.calls.length,1);
  assert.equal((await fetch(h.origin+r.artifact.download_url,{headers:h.headers})).status,200);
  assert.notEqual((await fetch(h.origin+r.artifact.download_url)).status,200);
 }finally{await h.close();}
});
test('failed KPI job without saved export remains failed and never reruns source reads',async()=>{
 const f=kpiFixture(),original=f.exportStore.put;f.exportStore.put=async()=>{throw Error('private synthetic store error');};const h=await acceptanceServer(f,{durable:true,now:KPI_NOW});
 try{const response=await fetch(h.base+'/jobs',{method:'POST',headers:h.headers,body:JSON.stringify({message:'KPI dashboard',new_question:true})});const {job_id}=await response.json();let r;for(let i=0;i<300;i++){r=await h.get('/jobs/'+job_id);if(r.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(r.status,'failed');assert.equal(r.code,'KPI_REPORT_FAILED');assert.equal(r.failed_stage,'kpi_export_persistence');const n=f.calls.length;await h.get('/jobs/'+job_id);assert.equal(f.calls.length,n);assert.equal(r.artifact,undefined);assert.doesNotMatch(JSON.stringify(r),/private synthetic/);
 }finally{f.exportStore.put=original;await h.close();}
});
test('KPI failure UI carries safe request/job references, code and phase',()=>{
 const e=kpiJobError({error:'Analysis failed',code:'KPI_ARTIFACT_INVALID',failed_stage:'kpi_export_validation',request_id:'a3420369-000c-46c9-99c9-71f28a74e2cf',job_id:'f4725535-2976-4189-ac3d-1541e409afaa'});assert.match(e.message,/a3420369/);assert.match(e.message,/f4725535/);assert.match(e.message,/kpi_export_validation/);assert.match(e.message,/KPI_ARTIFACT_INVALID/);
});
test('saved KPI recovery rejects request and currency-scope substitutions without source replay',async()=>{
 for(const tamper of [a=>({...a,request:'different request'}),a=>({...a,analysis_context:{...a.analysis_context,kpi_scope:{...a.analysis_context.kpi_scope,currency:'USD'}}})]){
  const f=kpiFixture({failReadbackOnce:true}),get=f.exportStore.get;f.exportStore.get=async(...args)=>{const a=await get(...args);return a?tamper(a):a;};const h=await acceptanceServer(f,{durable:true,now:KPI_NOW});
  try{const response=await fetch(h.base+'/jobs',{method:'POST',headers:h.headers,body:JSON.stringify({message:'KPI dashboard',new_question:true})}),{job_id}=await response.json();let polled;
   for(let i=0;i<300;i++){polled=await fetch(h.base+'/jobs/'+job_id,{headers:h.headers});if(!polled.ok)break;const r=await polled.json();if(r.status==='completed')assert.fail('Mismatched artifact delivered');await new Promise(r=>setTimeout(r,10));}
   assert.notEqual(polled.status,200);const error=await polled.json();assert(!error.evidence);assert(!error.artifact);assert.equal(f.calls.length,1);
  }finally{await h.close();}
 }
});
