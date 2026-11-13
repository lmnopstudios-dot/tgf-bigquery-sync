import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {performanceFixture} from './loyalty-performance-fixture.js';
import {acceptanceServer} from './oracle-acceptance.js';
export async function verifyLoyaltyPerformanceBrowser(browser){
 for(const width of [390,1280]){
  const f=performanceFixture('cohorts'),h=await acceptanceServer(f,{durable:true,now:Date.parse('2026-11-13T12:00:00Z')}),page=await browser.newPage({viewport:{width,height:900}});
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   await page.locator('#message').fill('LoyaltyLion performance report');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
   assert.match(await page.locator('.analytical-answer').last().innerText(),/LoyaltyLion performance report/);
   const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const response=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(response.status(),200);
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(await response.body());assert(wb.getWorksheet('Customer purchasing'));assert(wb.getWorksheet('Coverage'));assert(wb.getWorksheet('Enrolment cohorts'));
   const calls=f.queries.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/LoyaltyLion performance report/);assert.equal(f.queries.length,calls);
  }finally{await page.close();await h.close();}
 }
}
