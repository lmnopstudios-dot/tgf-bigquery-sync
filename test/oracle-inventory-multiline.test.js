import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ExcelJS from 'exceljs';
import {filteredInventoryRequest} from './helpers/filtered-inventory.js';
import {filteredInventoryServer} from './helpers/filtered-inventory-server.js';
import {filteredInventoryScope,inventoryReportConfigKey} from '../oracle/inventory-report-config.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveExecutionPlan} from '../oracle/analytical-capabilities.js';
import {inventoryCatalogueExportIntent,assertLegacyInventoryAllowed} from '../oracle/inventory-export-intent.js';
const failed=(await readFile(new URL('./fixtures/inventory-multiline/failed-submission.txt',import.meta.url),'utf8')).trimEnd();
const expected=filteredInventoryScope(filteredInventoryRequest).inventory_report;
const variants=[failed,
`Export all active variants to Excel.\n- POS locations: Kings Cross, Shoreditch and Soho\n- Combined POS available stock: greater than 7\n- Online Ready to Ship available stock: less than 3\n- Include made-to-order products\n- Exclude products tagged enquire (case-insensitive)\n- Exclude draft, unlisted and archived products\n- Exclude workshops`,
`Show all active variants in an Excel export:\n• Kings Cross + Shoreditch + Soho available stock > 7\n• Online Ready to Ship available stock < 3\n• Include made-to-order products\n• Exclude exact enquire tags\n• Exclude workshops`,
`Create an Excel export of active product variants where:\nKings Cross + Shoreditch + Soho available stock\n> 7\nand Online Ready to Ship available stock\n< 3\nInclude made-to-order. Exclude products tagged enquire. Exclude workshops.`];
for(const [i,message] of variants.entries())test(`multiline/word-order equivalence ${i} preserves the exact inventory predicate`,()=>{
 const c=transitionAnalysisContext(null,message).context;assert.equal(c.tool_route,'get_shopify_inventory_by_location');assert.equal(resolveExecutionPlan(c).delivery,'job');assert.equal(inventoryReportConfigKey(c.inventory_report),inventoryReportConfigKey(expected));assert.equal(c.request_kind,null);
});
test('recognised catalogue-wide requests never escape to the capped reader when unsupported or misrouted',async t=>{
 const h=await filteredInventoryServer();t.after(h.close);
 const unsupported='Export the complete inventory catalogue to Excel for all active variants; include made-to-order products and exclude products tagged enquire.';
 assert.equal(inventoryCatalogueExportIntent(unsupported),true);assert.throws(()=>transitionAnalysisContext(null,unsupported),e=>e.code==='INVALID_INVENTORY_REPORT');
 const response=await fetch(h.base+'/analysis/route',{method:'POST',headers:h.headers,body:JSON.stringify({message:unsupported,new_question:true})});assert.equal(response.status,422);assert.equal((await response.json()).failure_stage,'inventory_scope_resolution');assert.equal(h.calls.length,0);
 assert.throws(()=>assertLegacyInventoryAllowed({message:failed}),e=>e.code==='INVENTORY_EXPORT_REQUIRES_REPORT');assert.doesNotThrow(()=>assertLegacyInventoryAllowed({message:'What is the current stock for eye rings?'}));
 assert.equal(inventoryCatalogueExportIntent('Rewrite the following email: Export all active variants with available inventory to Excel.'),false);
});
for(const durable of [false,true])test(`verbatim failed submission through real ${durable?'job dispatch':'chat entrypoint'}, download and recovery`,async t=>{
 const h=await filteredInventoryServer({durable});t.after(h.close);
 const route=await fetch(h.base+'/analysis/route',{method:'POST',headers:h.headers,body:JSON.stringify({message:failed,new_question:true})}),preflight=await route.json();assert.equal(preflight.route,'job');assert.equal(preflight.tool_route,'get_shopify_inventory_by_location');assert.equal(preflight.resolved_subject,'current_stock');assert.deepEqual(preflight.inventory_report,expected);assert.equal(h.calls.length,0);
 const r=await h.submit(failed,{fresh:true,id:`multiline-${durable}`});assert.equal(r.evidence.kind,'inventory_report');assert.equal(r.artifact.row_count,5);assert.deepEqual(r.analysis_context.inventory_report,expected);assert.doesNotMatch(r.answer,/no.*(?:file|capability)|INVENTORY_PRODUCT_LIMIT/i);
 const n=h.calls.length,download=await fetch(h.origin+r.artifact.download_url,{headers:h.headers});assert.equal(download.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await download.arrayBuffer()));assert.equal(wb.getWorksheet('Inventory').rowCount,6);assert.equal(wb.getWorksheet('Inventory').getRow(2).getCell(11).value,15);
 if(durable){const job=h.jobs.jobs.get(r.job_id);assert.equal(job.payload_json.original_message,failed);assert.deepEqual(job.payload_json.analysis_context.inventory_report,expected);job.status='failed';job.result_json=null;const recovered=await h.get('/jobs/'+r.job_id);assert.equal(recovered.recovered_persisted_export,true);assert.equal(recovered.artifact.row_count,5);assert.deepEqual(recovered.evidence.inventory_report,expected);}
 assert.equal(h.calls.length,n);
});
const {validateInventoryChatDelivery}=await import('../diagnostics/oracle-inventory-chat-delivery.js');
test('deployment/planning probe cannot claim chat delivery or run Shopify when the route metadata is missing',async t=>{
 const h=await filteredInventoryServer();t.after(h.close);const posts=[];const fetchImpl=async(url,options)=>{posts.push({url,method:options?.method||'GET'});if(url===h.origin+'/')return Response.json({revision:'93a6822769069aca6a572a4bf7c84a7ba179e7bf'});if(url.endsWith('/analysis/route'))return Response.json({success:true,route:'job'});return fetch(url,options);};
 const r=await validateInventoryChatDelivery({message:failed,origin:h.origin,password:'fixture',execute:true,fetchImpl,contains405:()=>true});assert.equal(r.code,'INVENTORY_EXPORT_ROUTE_NOT_VERIFIED');assert.equal(h.calls.length,0);assert.ok(!posts.some(p=>p.url.endsWith('/jobs')&&p.method==='POST'));
});
test('live diagnostic validates actual chat/job/download endpoints separately from deployment provenance',async t=>{
 const h=await filteredInventoryServer();t.after(h.close);let bytes;const root=async(url,options)=>url===h.origin+'/'?Response.json({revision:'93a6822769069aca6a572a4bf7c84a7ba179e7bf'}):fetch(url,options);
 const r=await validateInventoryChatDelivery({message:failed,origin:h.origin,password:'fixture',execute:true,fetchImpl:root,contains405:()=>true,pause:()=>new Promise(r=>setTimeout(r,10)),write:async(_,b)=>{bytes=b;}});assert.equal(r.live_chat_delivery,'verified');assert.equal(r.rows,5);assert.ok(bytes.length>1000);assert.match(r.download_path,/^\/api\/oracle\/exports\/[a-f0-9]{64}$/);
});
test('unrelated product comparisons and document edits do not become inventory exports',()=>{
 for(const text of ['Show products where price > 7 and weight < 3. Do not modify inventory.','Rewrite the following inventory email:\nFrom: customer\nCreate an Excel export of active variants with available stock.'])assert.equal(inventoryCatalogueExportIntent(text),false);
});
