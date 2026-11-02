import {createOracleBaselineDispatcher} from '../../oracle/baseline-dispatcher.js';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {inventoryFixture,inventoryRequest} from './inventory-report.js';
import {acceptanceServer} from './oracle-acceptance.js';

export async function verifyInventoryReportBrowser(browser){
  const f=inventoryFixture(),h=await acceptanceServer({baseline:createOracleBaselineDispatcher({currentStock:f.service}),exportStore:f.store},{durable:true});
  try{for(const width of [1280,390]){
    const page=await browser.newPage({viewport:{width,height:900}});
    try{
      await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
      await page.locator('#message').fill(width===390?'Show inventory at every active Shopify location for all active and draft products that do not have the `made-to-order` tag.':inventoryRequest);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
      const answer=page.locator('.analytical-answer').last();assert.match(await answer.innerText(),/26 eligible products \(ACTIVE\/DRAFT(?:\/UNLISTED)?\) at 12 active locations/);
      const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const response=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(response.status(),200);
      const wb=new ExcelJS.Workbook();await wb.xlsx.load(await response.body());assert.equal(wb.worksheets[0].rowCount,28);assert.equal(wb.worksheets[1].rowCount,325);
      const count=f.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/Inventory export/);assert.equal(f.calls.length,count);
    }finally{await page.close();}
  }}finally{await h.close();}
}
