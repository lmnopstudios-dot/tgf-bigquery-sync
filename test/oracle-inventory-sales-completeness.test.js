import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {filteredInventoryRequest,filteredInventoryFixture} from './helpers/filtered-inventory.js';
import {filteredInventoryServer} from './helpers/filtered-inventory-server.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveAnalyticalPlan} from '../oracle/analytical-plan.js';
import {inventoryVariantSelection,filteredInventoryScope} from '../oracle/inventory-report-config.js';
import {readInventoryReport,inventoryReportWorkbook} from '../oracle/inventory-report.js';
import {deliverOracleResult} from '../oracle/result-delivery.js';

// Synthetic extension of the existing fixture, NOT the unrecovered original
// multipart production request or the 106-variant retained export.
const request=filteredInventoryRequest.replace('Sort total POS descending.', 'Sort by Online Ready to Ship stock descending.')+' Add sales from 1 January 2026 through yesterday, Europe/London. Show units sold, refunded units and net sales separately for online, Kings Cross, Shoreditch and Soho. Show other POS locations and unknown channels separately. Keep currencies separate.';
const config=filteredInventoryScope(request).inventory_report;
test('multipart stock intent preserves sales requirements in context and analytical plan',()=>{
 const context=transitionAnalysisContext(null,request).context;
 assert.equal(context.inventory_report.sales_requested,true);
 assert.deepEqual(context.inventory_report.sort,{metric:'online_available',direction:'desc'});
 assert.deepEqual(resolveAnalyticalPlan(context).metrics,['available_inventory','units_sold','refunded_units','net_sales']);
 assert.equal(transitionAnalysisContext(context,'Show online sales last month').context.inventory_report,null);
});
test('online sorting changes order without changing the qualifying fixture variant set or quantities',async()=>{
 const f=filteredInventoryFixture(),e=await readInventoryReport({...f,reportConfig:config});
 const before=structuredClone(e.products),selection=inventoryVariantSelection(e);
 assert.deepEqual(selection.qualified.map(r=>r.online_available),[2,1,0,-1,-2]);
 const asc=structuredClone(e);asc.inventory_report.sort.direction='asc';
 assert.deepEqual(inventoryVariantSelection(asc).qualified.map(r=>r.online_available),[-2,-1,0,1,2]);
 assert.deepEqual(e.products,before);
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(await inventoryReportWorkbook(e));
 assert.match(JSON.stringify(wb.getWorksheet('Coverage').getSheetValues()),/Sales incomplete/);
});
for(const durable of [false,true])test(`synthetic multipart ${durable?'durable':'interactive'} chat retains workbook and discloses unsupported sales through download and recovery`,async t=>{
 const h=await filteredInventoryServer({durable});t.after(h.close);
 const result=await h.submit(request,{fresh:true,id:`sales-partial-${durable}`});
 assert.equal(result.partial,true);
 assert.equal(result.delivery.status,'partial');
 assert.match(result.answer,/Sales incomplete/);
 for(const component of ['units sold','refunded units','net sales','other POS','unknown channels'])assert.ok(result.answer.includes(component));
 assert.equal(result.artifact.row_count,5);
 assert.equal(result.component_outcomes.filter(c=>c.status==='unsupported').length,18);
 const n=h.calls.length,download=await fetch(h.origin+result.artifact.download_url,{headers:h.headers});
 assert.equal(download.status,200);
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));
 const rows=wb.getWorksheet('Inventory').getSheetValues().slice(2);
 assert.deepEqual(rows.map(r=>r.at(-1)),[2,1,0,-1,-2]);
 const manifest=await fetch(h.origin+result.artifact.download_url+'/manifest',{headers:h.headers});
 const saved=await manifest.json();assert.equal(saved.partial,true);assert.match(saved.answer,/Sales incomplete/);
 if(durable){
  const job=h.jobs.jobs.get(result.job_id);job.status='failed';job.result_json=null;job.error_code='DELIVERY_FAILED';
  const recovered=await h.get('/jobs/'+result.job_id);
  assert.equal(recovered.recovered_persisted_export,true);assert.equal(recovered.partial,true);assert.match(recovered.answer,/Sales incomplete/);
 }
 assert.equal(h.calls.length,n,'downloads and recovery must not replay providers');
});
test('shared terminal delivery cannot lose missing-sales metadata with an inventory-only saved answer',()=>{
 const context=transitionAnalysisContext(null,request).context;
 const result=deliverOracleResult({answer:'Inventory export saved.',evidence:{kind:'inventory_report',inventory_report:config}},context);
 assert.equal(result.partial,true);assert.equal(result.delivery.status,'partial');assert.match(result.answer,/Sales incomplete/);
 assert.deepEqual(result.completeness.missing,['units_sold','refunded_units','net_sales']);
});

test('incident selection direction is distinct from the older inventory fixture',()=>{
 const text='Export active variants to Excel where Online Ready to Ship available stock > 7. Combined Kings Cross + Shoreditch + Soho available stock < 3. Include made-to-order. Exclude products tagged enquire. Exclude draft, unlisted and archived products. Exclude workshops. Sort by Online Ready to Ship stock descending. Include sales.';
 const c=transitionAnalysisContext(null,text).context.inventory_report;
 assert.equal(c.online.operator,'gt');assert.equal(c.online.threshold,7);
 assert.equal(c.pos.operator,'lt');assert.equal(c.pos.threshold,3);
 assert.equal(c.sales_requested,true);assert.deepEqual(c.sort,{metric:'online_available',direction:'desc'});
 assert.deepEqual(c.excluded_tags,['enquire']);assert.deepEqual(c.statuses,['ACTIVE']);
});
