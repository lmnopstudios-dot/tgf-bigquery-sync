import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {filteredInventoryServer} from './filtered-inventory-server.js';
import {filteredInventoryRequest} from './filtered-inventory.js';
export async function verifyFilteredInventoryBrowser(browser){
 const h=await filteredInventoryServer();try{for(const width of [1280,390]){const page=await browser.newPage({viewport:{width,height:900}}),posts=[];page.on('request',r=>{if(r.method()==='POST'&&/\/api\/oracle\/(jobs|chat)$/.test(new URL(r.url()).pathname))posts.push(new URL(r.url()).pathname);});try{
  await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  const message=width===390?(await readFile(new URL('../fixtures/inventory-multiline/failed-submission.txt',import.meta.url),'utf8')).trimEnd():filteredInventoryRequest;
  await page.locator('#message').fill(message);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.deepEqual(posts,['/api/oracle/jobs']);
  const answer=await page.locator('.analytical-answer').last().innerText();assert.match(answer,/5 qualifying variants/);assert.match(answer,/Kings Cross \+ Shoreditch \+ Soho Available > 7/);assert.match(answer,/Online Ready to Ship Available < 3/);assert.match(answer,/exclude exact tags: enquire/);
  const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const dl=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(dl.status(),200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(await dl.body());assert.equal(wb.getWorksheet('Inventory').rowCount,6);assert.equal(wb.getWorksheet('Inventory').getRow(2).getCell(11).value,15);assert.doesNotMatch(JSON.stringify(wb.getWorksheet('Inventory').getRow(1).values),/Workshop/);
  const count=h.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/5 qualifying variants/);assert.equal(h.calls.length,count);
 }finally{await page.close();}}}finally{await h.close();}
}

// Synthetic multipart extension: the real incident request remains pending recovery.
export async function verifyInventorySalesBrowser(browser){
 const h=await filteredInventoryServer();
 try{
  const page=await browser.newPage();
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   const message=filteredInventoryRequest.replace('Sort total POS descending.','Sort by Online Ready to Ship stock descending.')+' Include units sold, refunded units and net sales by online and POS location.';
   await page.locator('#message').fill(message);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
   assert.match(await page.locator('.analytical-answer').last().innerText(),/Sales incomplete/);
   const count=h.calls.length;
   await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
   assert.match(await page.locator('.analytical-answer').last().innerText(),/Sales incomplete/);
   assert.equal(h.calls.length,count);
  }finally{await page.close();}
 }finally{await h.close();}
}
