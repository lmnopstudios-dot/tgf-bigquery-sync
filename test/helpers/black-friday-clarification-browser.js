import assert from 'node:assert/strict';
import {acceptanceServer} from './oracle-acceptance.js';
import {clarificationFixture,endpointReply,openingQuestion} from './black-friday-clarification-fixture.js';
export async function verifyBlackFridayClarificationBrowser(browser){
 const f=clarificationFixture(),h=await acceptanceServer(f,{durable:true,now:Date.parse('2026-11-04T12:00:00Z')}),page=await browser.newPage();
 try{
  await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  const submit=async message=>{await page.locator('#message').fill(message);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));};
  await submit(openingQuestion);assert.match(await page.locator('.analytical-answer').last().innerText(),/midnight cutoff mean the start or end/);
  const n=f.calls.length,locations=f.reads.length;await submit(endpointReply);const text=await page.locator('.analytical-answer').last().innerText();assert.match(text,/2024-11-11T00:00:00Z/);assert.match(text,/2025 VIP/);assert.match(text,/Ring A/);assert.match(text,/EVENT_LOCATION_NOT_VERIFIED/);assert.equal(f.calls.length-n,2);assert.equal(f.reads.length,locations);assert.equal(f.proposals.length,0);assert.equal(await page.getByRole('button',{name:'Discard',exact:true}).count(),0);
  const final=f.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.equal(f.calls.length,final);assert.match(await page.locator('.analytical-answer').last().innerText(),/2024-11-11T00:00:00Z/);
 }finally{await page.close();await h.close();}
}
