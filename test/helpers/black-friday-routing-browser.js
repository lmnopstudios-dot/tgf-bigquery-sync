import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {acceptanceServer} from './oracle-acceptance.js';
import {blackFridayRoutingFixture,routingPrompts} from './black-friday-routing-fixture.js';
// Keep the competing current-product producer installed: a historical-only
// fixture would hide the fallback that produced the second live failure.
export async function verifyBlackFridayRoutingBrowser(browser){
 for(const [name,message]of Object.entries(routingPrompts)){
  const f=blackFridayRoutingFixture(),h=await acceptanceServer(f,{durable:true,now:Date.parse('2026-11-04T12:00:00Z')}),page=await browser.newPage({viewport:{width:name==='short'?390:1280,height:900}});
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   const submit=async text=>{await page.locator('#message').fill(text);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));};
   await submit(message);
   let answer=await page.locator('.analytical-answer').last().innerText();
   assert.match(answer,/2025 VIP early access/);assert.match(answer,/2025 public campaign/);assert.match(answer,/2024-11-07T12:00:00Z/);assert.match(answer,/2024-11-09T10:30:00Z/);assert.match(answer,/Ring A/);assert.match(answer,/midnight cutoff/);
   assert.doesNotMatch(answer,/Product attribution is unavailable|current Online Store published|2025-01-01/);assert.deepEqual(f.attempts,['compare_historical_events']);
   await submit('End of 10 November — 11 November 00:00 GMT');answer=await page.locator('.analytical-answer').last().innerText();assert.match(answer,/2024-11-11T00:00:00Z/);
   const reads=f.calls.length;await submit('Can I have this as a spreadsheet');assert.equal(f.calls.length,reads);
   const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const download=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(download.status(),200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(await download.body());assert.match(JSON.stringify(wb.worksheets.map(s=>s.getSheetValues())),/Ring A/);
   await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.equal(f.calls.length,reads);assert.ok(!f.attempts.includes('export_product_priorities'));
  }finally{await page.close();await h.close();}
 }
}
