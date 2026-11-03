import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {filteredInventoryServer} from './filtered-inventory-server.js';
import {filteredInventoryRequest} from './filtered-inventory.js';
export async function verifyFilteredInventoryBrowser(browser){
 const h=await filteredInventoryServer();try{for(const width of [1280,390]){const page=await browser.newPage({viewport:{width,height:900}}),posts=[];page.on('request',r=>{if(r.method()==='POST'&&/\/api\/oracle\/(jobs|chat)$/.test(new URL(r.url()).pathname))posts.push(new URL(r.url()).pathname);});try{
  await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#message').fill(filteredInventoryRequest);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.deepEqual(posts,['/api/oracle/jobs']);
  const answer=await page.locator('.analytical-answer').last().innerText();assert.match(answer,/5 qualifying variants/);assert.match(answer,/Kings Cross \+ Shoreditch \+ Soho Available > 7/);assert.match(answer,/Online Ready to Ship Available < 3/);assert.match(answer,/exclude exact tags: enquire/);
  const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const dl=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(dl.status(),200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(await dl.body());assert.equal(wb.getWorksheet('Inventory').rowCount,6);assert.equal(wb.getWorksheet('Inventory').getRow(2).getCell(11).value,15);assert.doesNotMatch(JSON.stringify(wb.getWorksheet('Inventory').getRow(1).values),/Workshop/);
  const count=h.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/5 qualifying variants/);assert.equal(h.calls.length,count);
 }finally{await page.close();}}}finally{await h.close();}
}
