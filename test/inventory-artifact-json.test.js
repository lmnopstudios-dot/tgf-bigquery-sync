import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {inventoryFixture} from './helpers/inventory-report.js';
import {assertInventoryArtifact,inventoryMetadataEqual} from '../oracle/inventory-report.js';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const reverse=v=>Array.isArray(v)?v.map(reverse):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reverse(v[k])])):v;
async function savedArtifact(){const f=inventoryFixture({failed:true}),r=await f.service('Stock for everything except made-to-order',{exportOwner:'owner',requestId:'json-test'});return f.store.get(r.artifact.id,'owner');}
async function rewrite(a,edit){const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(a.xlsx_base64,'base64'));edit(wb);const bytes=Buffer.from(await wb.xlsx.writeBuffer());return {...a,xlsx_base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')};}
test('native JSON object reordering after storage preserves the exact workbook bytes and passes verification',async()=>{
 const a=await savedArtifact(),b=canonical(a);await assertInventoryArtifact(b);assert.equal(a.sha256,b.sha256);assert.equal(a.xlsx_base64,b.xlsx_base64);assert.equal(b.envelope.complete,false);
});
test('legacy workbook metadata member order remains valid after BigQuery JSON roundtrip',async()=>{
 const a=await savedArtifact(),legacy=await rewrite(a,wb=>{
  const coverage=wb.getWorksheet('Coverage');coverage.eachRow((r,i)=>{if(i>1&&['Export limits','Coverage failure','Observed product tag'].includes(r.getCell(1).value))r.getCell(2).value=JSON.stringify(reverse(JSON.parse(r.getCell(2).value)));});
  const detail=wb.getWorksheet('Location quantities'),column=detail.getRow(1).values.indexOf('Coverage failures');detail.eachRow((r,i)=>{if(i>1)r.getCell(column).value=JSON.stringify(reverse(JSON.parse(r.getCell(column).value)));});
 });await assertInventoryArtifact(canonical(legacy));
});
test('changed inventory quantities still fail after a fresh checksum and native JSON roundtrip',async()=>{
 const a=await savedArtifact(),changed=await rewrite(a,wb=>{wb.getWorksheet('Location quantities').getRow(2).getCell(11).value=999;});await assert.rejects(assertInventoryArtifact(canonical(changed)),e=>e.code==='EXPORT_INTEGRITY_FAILED'&&e.integrity.reason==='cell');
});
test('real JSON metadata mutations and byte tampering still fail verification',async()=>{
 const a=await savedArtifact(),changed=await rewrite(a,wb=>{const s=wb.getWorksheet('Coverage');s.eachRow((r,i)=>{if(i>1&&r.getCell(1).value==='Export limits'){const v=JSON.parse(r.getCell(2).value);v.max_variants++;r.getCell(2).value=JSON.stringify(v);}});});await assert.rejects(assertInventoryArtifact(canonical(changed)),e=>e.integrity.reason==='cell');
 await assert.rejects(assertInventoryArtifact({...a,sha256:'0'.repeat(64)}),e=>e.integrity.reason==='sha256');
 assert.equal(inventoryMetadataEqual('[{"x":1},{"x":2}]','[{"x":2},{"x":1}]'),false);assert.equal(inventoryMetadataEqual('{"quantity":0}','{"quantity":"0"}'),false);
});
test('owner-scoped retained-artifact inspection diagnoses legacy representation differences without replay',async()=>{
 const {inspectRetainedInventoryExport}=await import('../diagnostics/inventory-retained-export.js');const a=await savedArtifact(),legacy=await rewrite(a,wb=>{const s=wb.getWorksheet('Coverage');s.eachRow((r,i)=>{if(i>1&&r.getCell(1).value==='Export limits')r.getCell(2).value=JSON.stringify(reverse(JSON.parse(r.getCell(2).value)));});});const hydrated=canonical(legacy),queries=[];
 const result=await inspectRetainedInventoryExport({bigquery:{dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async q=>{queries.push(q);return [[{artifact_json:hydrated}]];}},project:'fixture',dataset:'commerce',requestId:'5a29d1f7-b66d-4742-9006-649bf270e82e',owner:'private-owner'});
 assert.equal(queries.length,1);assert.match(queries[0].query,/^SELECT artifact_json/);assert.match(queries[0].query,/owner_key=@owner/);assert.equal(result.sha256_matches,true);assert.equal(result.repaired_workbook_validation,'verified');assert.ok(result.legacy_json_member_order_differences>0);assert.equal(result.complete,false);assert.doesNotMatch(JSON.stringify(result),/private-owner|xlsx_base64/);
});
test('pre-fix three-sheet artifacts retain the exact legacy eligibility text and validate without regenerating observations',async()=>{
 const {inventoryReportWorkbook}=await import('../oracle/inventory-report.js');const a=await savedArtifact();delete a.envelope.population;const bytes=await inventoryReportWorkbook(a.envelope);a.xlsx_base64=bytes.toString('base64');a.sha256=createHash('sha256').update(bytes).digest('hex');
 const legacy=await rewrite(a,wb=>{assert.equal(wb.worksheets.length,3);const s=wb.getWorksheet('Coverage');s.eachRow((r,i)=>{if(i>1&&r.getCell(1).value==='Eligibility')r.getCell(2).value='ACTIVE and DRAFT; exclude ARCHIVED; '+a.envelope.tag_convention.predicate;if(i>1&&r.getCell(1).value==='Export limits')r.getCell(2).value=JSON.stringify(reverse(a.envelope.limits));});});await assertInventoryArtifact(canonical(legacy));
});
