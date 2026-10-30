import assert from 'node:assert/strict';
import {acceptanceServer} from './oracle-acceptance.js';
import {durableJsonWire} from './durable-json-wire.js';
import {squareChannelDeliveryFixture} from './square-channel-delivery-fixture.js';
export async function verifySquareChannelControls({browser,output}){
 const fixture=squareChannelDeliveryFixture(),h=await acceptanceServer(fixture,{durable:true,jobStore:durableJsonWire({canonicalObjectKeys:true}).store});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#journey-controls summary').click();
  assert.equal(await page.locator('#journey-scope-enabled').isChecked(),false);assert.equal(await page.locator('#journey-square').isChecked(),false);
  await page.locator('#journey-scope-enabled').check();await page.locator('#journey-square').check();
  await page.locator('#journey-entry').selectOption('instore');await page.locator('#journey-followup').selectOption('all');
  await page.locator('#message').fill('Show the most popular second-purchase products. First-observed purchase dates: 2024-01-01 through 2024-01-02. Observation cutoff: 2026-10-19.');
  await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
  const answer=await page.locator('.analytical-answer').last().innerText();assert.match(answer,/Entry-purchase channel: In-store only/);assert.match(answer,/Follow-up purchase channel: All supported/);assert.match(answer,/4 \/ 5/);assert.match(answer,/unmapped_item/);assert.match(answer,/not representative of all retail customers/);
  const reads=fixture.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
  assert.equal(await page.locator('.analytical-answer').last().innerText(),answer);assert.equal(fixture.calls.length,reads);
  await page.locator('#journey-controls summary').click();await page.locator('#journey-scope-enabled').check();await page.locator('#journey-square').check();
  await page.locator('#journey-entry').selectOption('online');await page.locator('#journey-followup').selectOption('instore');await page.locator('#journey-next').selectOption('next_matching_channel');
  fixture.state.square_next_matching=true;await page.locator('#message').fill('Show that with these channel controls.');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  const next=await page.locator('.analytical-answer').last().innerText();assert.match(next,/Entry-purchase channel: Online only/);assert.match(next,/Follow-up purchase channel: In-store only/);assert.match(next,/intervening purchases in other channels may be skipped/);assert.match(next,/1 \/ 1/);
  await page.screenshot({path:`${output}/square-channel-${width}.png`,fullPage:true});
  await page.locator('#new-question').click();assert.equal(await page.locator('#journey-scope-enabled').isChecked(),false);assert.equal(await page.locator('#journey-square').isChecked(),false);
  fixture.state.square_next_matching=false;await page.close();
 }}finally{h.close();}
}
