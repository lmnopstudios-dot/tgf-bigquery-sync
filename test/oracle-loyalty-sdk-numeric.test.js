import test from 'node:test';
import assert from 'node:assert/strict';
import {sdkLoyaltyFixture as sdkFixture} from './helpers/loyalty-sdk-fixture.js';
import ExcelJS from 'exceljs';
import {acceptanceServer} from './helpers/oracle-acceptance.js';
const now=Date.parse('2026-11-13T18:30:00Z');
for(const durable of [false,true])test(`actual SDK monetary decoding survives ${durable?'durable':'interactive'} report and canonical workbook persistence`,async t=>{
 const f=sdkFixture(),h=await acceptanceServer(f,{durable,now});t.after(h.close);
 const r=await h.submit('LoyaltyLion performance report',{fresh:true});assert(r.artifact,JSON.stringify(r));
 const row=r.evidence.performance.tables.find(s=>s.section==='purchasing').rows[0];assert.equal(row.original_order_gross,'300');assert.equal(row.observed_aov,'100');
 const response=await fetch(h.origin+r.artifact.download_url,{headers:{cookie:h.headers.cookie}});assert.equal(response.status,200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));const s=wb.getWorksheet('Customer purchasing'),headers=s.getRow(1).values;assert.equal(s.getRow(2).getCell(headers.indexOf('observed_aov')).value,100);
});
test('high precision NUMERIC stays exact through SDK, evidence and workbook',async t=>{
 const f=sdkFixture({large:true}),h=await acceptanceServer(f,{now});t.after(h.close);const r=await h.submit('LoyaltyLion performance report',{fresh:true});assert(r.artifact);
 const amount='12345678901234567890.123456789';assert.equal(r.evidence.performance.tables.find(s=>s.section==='purchasing').rows[0].original_order_gross,amount);
 const response=await fetch(h.origin+r.artifact.download_url,{headers:{cookie:h.headers.cookie}}),wb=new ExcelJS.Workbook();await wb.xlsx.load(Buffer.from(await response.arrayBuffer()));const s=wb.getWorksheet('Customer purchasing');assert.equal(s.getRow(2).getCell(s.getRow(1).values.indexOf('original_order_gross')).value,amount);
});

test('unexpected SDK value fails only its section and logs an allowlisted field/category without values',async t=>{
 const {transitionAnalysisContext}=await import('../oracle/analysis-context.js');
 const f=sdkFixture({invalid:true}),context=transitionAnalysisContext(null,'LoyaltyLion performance report',{now}).context,stages=[];
 const e=await f.provider(context,{onProviderStage:event=>stages.push(event)});
 assert.equal(e.performance.tables.find(t=>t.section==='purchasing').status,'unavailable');assert(e.performance.tables.find(t=>t.section==='usage').rows.length>0);
 const failed=stages.find(s=>s.section==='purchasing'&&s.status==='failed');assert.equal(failed.code,'LOYALTY_PERFORMANCE_ROW_CONTRACT_INVALID');assert.equal(failed.field,'observed_aov');assert.equal(failed.category,'non_scalar');assert.doesNotMatch(JSON.stringify(stages),/unrecognized|12345678901234567890/);
 const h=await acceptanceServer(f,{now});t.after(h.close);const report=await h.submit('LoyaltyLion performance report',{fresh:true});assert(report.artifact);assert.equal(report.evidence.performance.tables.find(s=>s.section==='purchasing').status,'unavailable');

});
test('Excel numeric conversion never rounds large or precise source decimals',async()=>{
 const {excelLoyaltyDecimal}=await import('../oracle/loyalty-performance.js');
 assert.equal(excelLoyaltyDecimal('100.00'),100);assert.equal(excelLoyaltyDecimal('-12.34'),-12.34);assert.equal(excelLoyaltyDecimal('0'),0);
 for(const value of ['9007199254740993','12345678901234567890.123456789','1234567.123456789','0.000000001'])assert.equal(excelLoyaltyDecimal(value),value);
});
