import assert from 'node:assert/strict';
import {acceptanceServer} from './oracle-acceptance.js';
import {bankHolidayFixture,bankPrompt} from './bank-holiday-sale-fixture.js';
export async function verifyBankHolidaySaleBrowser(browser){
 const f=bankHolidayFixture(),h=await acceptanceServer(f,{durable:true,now:Date.parse('2026-11-04T12:00:00Z')}),page=await browser.newPage({viewport:{width:390,height:900}});
 try{
  await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  const submit=async m=>{await page.locator('#message').fill(m);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));};
  await submit(bankPrompt);const text=await page.locator('.analytical-answer').last().innerText();assert.match(text,/2026-05-01 to 2026-05-04/);assert.match(text,/2026-04-30T23:00:00Z/);assert.match(text,/Online Store/);assert.match(text,/POS \(all participating/);assert.match(text,/Unknown channel/);assert.match(text,/Top 20/);assert.match(text,/GBP 90/);assert.deepEqual(f.attempts,['sale-window']);assert.equal(f.proposals.length,0);
  const n=f.calls.length;await submit('Can I have this as a spreadsheet');assert.equal(f.calls.length,n);const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const download=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(download.status(),200);
  await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.equal(f.calls.length,n);
 }finally{await page.close();await h.close();}
}
