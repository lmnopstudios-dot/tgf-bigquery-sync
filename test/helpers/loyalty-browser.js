import {exportJsonWire} from './export-json-wire.js';
import assert from 'node:assert/strict';
import {acceptanceServer} from './oracle-acceptance.js';
import {loyaltyFixture,LOYALTY_NOW} from './loyalty-fixture.js';
export async function verifyLoyaltyBrowser(browser){
 for(const width of [390,1280]){
  const f=loyaltyFixture({failure:'points'});f.exportStore=exportJsonWire().store;const h=await acceptanceServer(f,{durable:true,now:LOYALTY_NOW}),page=await browser.newPage({viewport:{width,height:900}});
  try{
   await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
   const send=async message=>{const count=await page.locator('.analytical-answer').count();await page.locator('#message').fill(message);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.equal(await page.locator('.analytical-answer').count(),count+1);return page.locator('.analytical-answer').last();};
   const answer=await send('Show LoyaltyLion overview for October 2026');assert.match(await answer.innerText(),/Gold/);assert.match(await answer.innerText(),/LOYALTY_SECTION_ACCESS_UNAVAILABLE/);assert.match(await answer.innerText(),/not proof of reward use/);assert((await answer.locator('table').count())>=3);
   const count=f.queries.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/Gold/);assert.equal(f.queries.length,count);
   await send('Export those results to Excel');assert.equal(f.queries.length,count);const link=page.locator('a[href*="/api/oracle/exports/"]').last();await link.waitFor();const download=await page.request.get(h.origin+await link.getAttribute('href'));assert.equal(download.status(),200);assert((await download.body()).length>1000);assert.equal(f.queries.length,count);
  }finally{await page.close();await h.close();}
 }
}
