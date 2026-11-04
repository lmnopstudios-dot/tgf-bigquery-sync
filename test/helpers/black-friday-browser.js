import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ExcelJS from 'exceljs';
import {eventSaleFixture} from './event-sale-fixture.js';
import {acceptanceServer} from './oracle-acceptance.js';
export async function verifyBlackFridayBrowser(browser){
 const f=eventSaleFixture(),h=await acceptanceServer(f,{durable:true});
 try{for(const width of [1280,390]){const page=await browser.newPage({viewport:{width,height:900}});
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   const submit=async message=>{await page.locator('#message').fill(message);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));};
   await submit(readFileSync(new URL('../fixtures/black-friday-conversation/failed-request.txt',import.meta.url),'utf8'));
   let answer=await page.locator('.analytical-answer').last().innerText();assert.match(answer,/2025-11-27 to 2025-11-30/);assert.doesNotMatch(answer,/2025-01|2024-01|Year-on-year/);
   await submit('last year and the year before, with products sold and units');
   answer=await page.locator('.analytical-answer').last().innerText();assert.match(answer,/Ring A/);assert.match(answer,/2024-11-08 to 2024-11-10/);
   const count=f.calls.length;await submit('Can I have this as a spreadsheet');assert.equal(f.calls.length,count);
   const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const response=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(response.status(),200);const wb=new ExcelJS.Workbook();await wb.xlsx.load(await response.body());assert.match(JSON.stringify(wb.worksheets.map(s=>s.getSheetValues())),/Ring A/);
   await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.equal(f.calls.length,count);assert.match(await page.locator('.analytical-answer').last().innerText(),/No data was refreshed/);
  }finally{await page.close();}
 }}finally{await h.close();}
}
export async function verifyBlackFridaySessionsBrowser(browser){
 const raw=JSON.parse(readFileSync(new URL('../fixtures/black-friday-conversation/live-knowledge.json',import.meta.url))),items=raw.map(r=>({...r,id:r.event_id,kind:'event',content:r.description,effective_from:r.start_date,effective_to:r.end_date}));
 const f=eventSaleFixture({items}),h=await acceptanceServer(f,{durable:true}),page=await browser.newPage();
 try{
  await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  const submit=async message=>{await page.locator('#message').fill(message);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));};
  await submit('Compare 2025 and 2024 Black Friday sales and products online and instore');let text=await page.locator('.analytical-answer').last().innerText();assert.match(text,/physical-store participation/);assert.doesNotMatch(text,/conflicting confirmed 2025 instore/);
  await submit('end of november the 10th');text=await page.locator('.analytical-answer').last().innerText();assert.match(text,/2024-11-11T00:00:00Z/);assert.match(text,/2024-11-07T12:00:00Z/);assert.match(text,/2024-11-09T10:30:00Z/);
  const n=f.calls.length;await submit('Can I have this as a spreadsheet');assert.equal(f.calls.length,n);await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.equal(f.calls.length,n);
 }finally{await page.close();await h.close();}
}
