import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {transitionAnalysisContext,validateAnalysisContext} from '../oracle/analysis-context.js';
import {resolveAnalyticalPlan} from '../oracle/analytical-plan.js';
import {assertEvidenceAgreement} from '../oracle/analysis-route-dispatcher.js';
import {inventoryReportConfigKey,filteredInventoryScope,inventoryVariantSelection} from '../oracle/inventory-report-config.js';
import {readInventoryReport,inventoryReportWorkbook,createInventoryReportService} from '../oracle/inventory-report.js';
import {filteredInventoryRequest as request,filteredInventoryFixture,realInventoryLocations} from './helpers/filtered-inventory.js';
const config=filteredInventoryScope(request).inventory_report;
test('exact chat intent retains a validated stock predicate in the shared context and plan',()=>{
 const c=transitionAnalysisContext(null,request).context;assert.equal(c.tool_route,'get_shopify_inventory_by_location');assert.equal(c.start_date,null);assert.deepEqual(c.inventory_report,config);assert.deepEqual(resolveAnalyticalPlan(c).inventory_report,config);assert.equal(resolveAnalyticalPlan(c).grain,'variant');assert.deepEqual(resolveAnalyticalPlan(c).metrics,['available_inventory']);assert.throws(()=>validateAnalysisContext({...c,inventory_report:null}));assert.deepEqual(config.statuses,['ACTIVE']);assert.deepEqual(config.excluded_tags,['enquire']);assert.deepEqual(config.pos.names,['Kings Cross','Shoreditch','Soho']);assert.equal(config.online.names[0],'Online Ready to Ship');assert.equal(transitionAnalysisContext(c,'Show online sales last month').context.inventory_report,null);
 assert.throws(()=>validateAnalysisContext({...c,inventory_report:{...config,require_known_available:false}}));
 const changed=filteredInventoryScope(request.replace('> 7','>= 10').replace('< 3','< -1')).inventory_report;assert.equal(changed.pos.operator,'gte');assert.equal(changed.pos.threshold,10);assert.equal(changed.online.threshold,-1);assert.notEqual(inventoryReportConfigKey(changed),inventoryReportConfigKey(config));
});
async function read(options={}){const f=filteredInventoryFixture(options),e=await readInventoryReport({...f,reportConfig:config,entityQuery:'filtered variant inventory'});return{...f,e};}
test('full pagination, exact native location IDs, MTO inclusion, exact tags and strict numeric thresholds',async()=>{
 const f=await read(),s=inventoryVariantSelection(f.e);assert.equal(f.e.complete,true);assert.equal(f.e.products.length,28);assert.equal(f.e.locations.length,4);assert.deepEqual(new Set(f.e.locations.map(l=>l.id)),new Set(realInventoryLocations.slice(0,4).map(l=>l.id)));assert.equal(f.calls.filter(c=>c.q.includes('InventoryCatalogue')).length,2);assert.equal(f.calls.filter(c=>c.q.includes('InventoryReportVariants')&&c.a.cursor).length,1);
 assert.deepEqual(s.qualified.map(r=>r.pos_total_available),[15,9,8,8,8]);assert.deepEqual(new Set(s.qualified.map(r=>r.v.id.split('/').at(-1))),new Set(['201','101','102','401','1201']));assert.equal(s.unknown_count,2);assert.ok(s.qualified.some(r=>r.p.tags.includes('made-to-order')));assert.ok(s.qualified.some(r=>r.online_available===0));assert.ok(s.qualified.some(r=>r.online_available<0));assert.ok(!f.e.products.some(p=>p.tags.includes('EnQuIrE')));assert.ok(f.e.products.some(p=>p.tags.includes('enquire later')));
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(await inventoryReportWorkbook(f.e));const sheet=wb.getWorksheet('Inventory');assert.equal(sheet.rowCount,6);assert.equal(sheet.getRow(1).values.filter(v=>String(v).startsWith('Available:')).length,3);assert.equal(wb.getWorksheet('Location quantities').rowCount,21);assert.match(JSON.stringify(sheet.getRow(1).values),/Online RTS/);assert.equal(sheet.getRow(2).getCell(11).value,15); // Total POS follows three store columns.
});
for(const options of [{missingNode:true},{missingLocation:true},{duplicateLocation:true},{failLocation:true}])test(`unknown or unresolved quantities never qualify: ${JSON.stringify(options)}`,async()=>{const f=await read(options),s=inventoryVariantSelection(f.e);assert.equal(f.e.complete,false);assert.ok(s.unknown_count>0);if(options.missingNode)assert.ok(!s.qualified.some(r=>r.v.id.endsWith('/1201')));else assert.equal(s.qualified.length,0);assert.ok(!JSON.stringify(f.e.failures).includes('private'));});
test('scope agreement rejects a missing or altered inventory filter after persistence',async()=>{
 const {e}=await read(),context=transitionAnalysisContext(null,request).context;assert.equal(assertEvidenceAgreement(context,e,request),true);assert.throws(()=>assertEvidenceAgreement(context,{...e,inventory_report:null},request),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');assert.throws(()=>assertEvidenceAgreement(context,{...e,inventory_report:{...config,pos:{...config.pos,threshold:6}}},request),e=>e.code==='EVIDENCE_SCOPE_MISMATCH');
});
const {filteredInventoryServer}=await import('./helpers/filtered-inventory-server.js');
for(const durable of [false,true])test(`exact request through production ${durable?'background job':'chat'} and authenticated Excel download preserves every filter`,async t=>{
 const h=await filteredInventoryServer({durable});t.after(h.close);
 const route=await fetch(h.base+'/analysis/route',{method:'POST',headers:h.headers,body:JSON.stringify({message:request,new_question:true})});assert.equal((await route.json()).route,'job');assert.equal(h.calls.length,0);
 const result=await h.submit(request,{fresh:true,id:`filtered-${durable}`});assert.deepEqual(result.analysis_context.inventory_report,config);assert.deepEqual(result.evidence.analytical_plan.inventory_report,config);assert.equal(result.artifact.row_count,5);assert.equal(result.evidence.complete,true);
 if(durable)assert.equal(inventoryReportConfigKey(h.jobs.jobs.get(result.job_id).payload_json.analysis_context.inventory_report),inventoryReportConfigKey(config));
 const n=h.calls.length,dl=await fetch(h.origin+result.artifact.download_url,{headers:h.headers});assert.equal(dl.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await dl.arrayBuffer()));assert.equal(wb.getWorksheet('Inventory').rowCount,6);assert.equal(wb.getWorksheet('Inventory').getRow(2).getCell(11).value,15);
 const manifest=await fetch(h.origin+result.artifact.download_url+'/manifest?inventory_report='+encodeURIComponent(JSON.stringify(config)),{headers:h.headers});assert.equal(manifest.status,200);assert.deepEqual((await manifest.json()).analysis_context.inventory_report,config);
 const wrong={...config,pos:{...config.pos,threshold:8}};assert.equal((await fetch(h.origin+result.artifact.download_url+'/manifest?inventory_report='+encodeURIComponent(JSON.stringify(wrong)),{headers:h.headers})).status,409);
 assert.equal((await fetch(h.origin+result.artifact.download_url)).status,401);
 if(durable){const job=h.jobs.jobs.get(result.job_id);job.status='failed';job.result_json=null;job.error_code='DELIVERY_FAILED';const recovered=await h.get('/jobs/'+result.job_id);assert.equal(recovered.recovered_persisted_export,true);assert.equal(recovered.artifact.row_count,5);assert.deepEqual(recovered.evidence.inventory_report,config);}
 assert.equal(h.calls.length,n,'Downloads/recovery must not replay providers');assert.ok(h.sql.some(q=>q.query.startsWith('MERGE')));
});
test('changing saved thresholds cannot silently broaden a filtered download',async t=>{
 const h=await filteredInventoryServer();t.after(h.close);const r=await h.submit(request,{fresh:true,id:'tamper'}),a=h.artifacts.get(r.artifact.id);a.envelope.inventory_report.pos.threshold=6;const response=await fetch(h.origin+r.artifact.download_url,{headers:h.headers});assert.notEqual(response.status,200);assert.equal((await response.json()).code,'EVIDENCE_SCOPE_MISMATCH');
});
test('an empty qualifying set still exports requested location headers and a zero artifact row count',async()=>{
 const f=filteredInventoryFixture(),store=(await import('../oracle/product-priority-storage.js')).createMemoryExportStore(),c={...config,pos:{...config.pos,threshold:1000}},context=validateAnalysisContext({...transitionAnalysisContext(null,request).context,inventory_report:c});
 const service=createInventoryReportService({...f,artifactStore:store});const result=await service('Export that to Excel',{analysisContext:context,exportOwner:'owner',requestId:'empty'});assert.equal(result.artifact.row_count,0);const a=await store.get(result.artifact.id,'owner'),wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(a.xlsx_base64,'base64'));const sheet=wb.getWorksheet('Inventory');assert.equal(sheet.rowCount,1);assert.equal(sheet.getRow(1).values.filter(v=>String(v).startsWith('Available:')).length,3);assert.match(JSON.stringify(sheet.getRow(1).values),/Online RTS/);
});
