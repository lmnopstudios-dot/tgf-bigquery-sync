import {exportJsonWire} from './export-json-wire.js';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {sdkLoyaltyFixture} from './loyalty-sdk-fixture.js';
import {acceptanceServer} from './oracle-acceptance.js';
export async function verifyLoyaltyPerformanceBrowser(browser){
 for(const width of [390,1280]){
  const f=sdkLoyaltyFixture({failure:'cohorts'});f.exportStore=exportJsonWire().store;const h=await acceptanceServer(f,{durable:true,now:Date.parse('2026-11-13T12:00:00Z')}),page=await browser.newPage({viewport:{width,height:900}});
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   await page.locator('#message').fill('LoyaltyLion performance report for 16 November 2025 through 15 November 2026. Show monthly member versus non-member AOV and before/after enrolment mean/median time between orders. Label groups as current membership, not membership at purchase. Generate the authenticated Excel workbook.');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
   assert.match(await page.locator('.analytical-answer').last().innerText(),/LoyaltyLion performance report/);
   const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const response=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(response.status(),200);
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(await response.body());assert(wb.getWorksheet('Customer purchasing'));assert(wb.getWorksheet('Customer purchasing').getSheetValues().flat(2).includes('current_member'));assert(wb.getWorksheet('Coverage'));assert(wb.getWorksheet('Enrolment cohorts'));assert(wb.getWorksheet('Purchase changes'));assert(wb.getWorksheet('Tiers').getSheetValues().flat(2).includes('Gold'));assert(wb.getWorksheet('Programme usage').getSheetValues().flat(2).includes('Current profiles'));assert.match(JSON.stringify(wb.model),/at least two orders on both sides/);
   const cells=JSON.stringify(wb.model);assert.match(cells,/Latest certified commerce cutoff/);assert.match(cells,/Latest certified points cutoff/);assert.match(cells,/Membership snapshot collected/);
   const anonymous=await browser.newContext();try{const denied=await anonymous.request.get(h.origin+await link.getAttribute('href'));assert.notEqual(denied.status(),200);}finally{await anonymous.close();}
   const calls=f.queries.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/LoyaltyLion performance report/);assert.equal(f.queries.length,calls);
  }finally{await page.close();await h.close();}
 }
}
