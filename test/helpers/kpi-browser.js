import assert from 'node:assert/strict';
import {kpiFixture,KPI_NOW} from './kpi-fixture.js';
import {acceptanceServer} from './oracle-acceptance.js';
import ExcelJS from 'exceljs';
export async function verifyKpiBrowser(browser){
 for(const width of [390,1280]){
  const f=kpiFixture(),h=await acceptanceServer(f,{durable:true,now:KPI_NOW}),page=await browser.newPage({viewport:{width,height:900}});
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   await page.locator('[data-view="kpi-dashboard"]').click();
   await page.locator('#kpi-controls [name="start"]').fill('2026-10-01');await page.locator('#kpi-controls [name="end"]').fill('2026-10-31');await page.locator('#kpi-controls button').click();
   await page.waitForFunction(()=>document.querySelector('#kpi-results .kpi-dashboard-card'));
   assert.match(await page.locator('#kpi-results').innerText(),/Observed gross AOV/);assert.match(await page.locator('#kpi-results').innerText(),/Unavailable/);assert.match(await page.locator('#kpi-results').innerText(),/Current month-to-date/);
   assert.equal(await page.locator('#kpi-results svg').count(),3);
   assert(await page.locator('#kpi-results svg circle').first().getAttribute('aria-label'));
   const link=page.locator('#kpi-results a');const response=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(response.status(),200);
   const wb=new ExcelJS.Workbook();await wb.xlsx.load(await response.body());assert(wb.getWorksheet('KPI summary'));assert(wb.getWorksheet('Monthly trends'));assert(wb.getWorksheet('Definitions and coverage'));
   const anonymous=await browser.newContext();try{assert.notEqual((await anonymous.request.get(h.origin+await link.getAttribute('href'))).status(),200);}finally{await anonymous.close();}
   const count=f.calls.length;await page.reload();await page.locator('#app').waitFor({state:'visible'});await page.locator('[data-view="kpi-dashboard"]').click();await page.locator('#kpi-results .kpi-dashboard-card').first().waitFor();assert.equal(f.calls.length,count);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2);assert.equal(overflow,false,'KPI panel causes horizontal page overflow');
   // Short command also uses the existing durable composer delivery.
   await page.locator('[data-view="chat"]').click();await page.locator('#message').fill('KPI dashboard for October 2026');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/KPI dashboard/);
  }finally{await page.close();await h.close();}
 }
}
