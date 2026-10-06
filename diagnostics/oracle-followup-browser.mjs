// Offline acceptance of the actual Oracle UI and shared HTTP execution.
// ORACLE_BROWSER_DRIVER=/path/to/playwright-core/index.mjs node diagnostics/oracle-followup-browser.mjs
import assert from 'node:assert/strict';
import express from 'express';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createBaselineOverviewService} from '../oracle/baseline-overview.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
const {chromium}=await import(process.env.ORACLE_BROWSER_DRIVER||'playwright-core');
const calls=[],now=Date.parse('2026-10-06T12:00:00Z');
const deps=createOracleProviderDependencies({project:'fixture',env:{},bigquery:{dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async args=>{calls.push(args);const start=args.params.start_date.value,end=args.params.end_date.value,days=(Date.parse(end)-Date.parse(start))/86400000+1;return [['mobile','desktop'].map((device,i)=>({device_type:device,referrer_source:'direct',sessions:100,numerator:start==='2026-09-01'?8+i:5+i,covered_days:days}))];}}});
const baseline=createBaselineOverviewService({now:()=>new Date(now),shopifyDevice:deps.deviceConversion,wooConversion:deps.deviceConversion});
const app=express(),root=fileURLToPath(new URL('../',import.meta.url));
app.use('/oracle',express.static(root+'public/oracle'));
app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},baselineOverview:baseline,chat:async()=>({answer:'Which analysis do you mean?',tools:[]}),now:()=>now,env:{ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012'}}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const browser=await chromium.launch({executablePath:process.env.ORACLE_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const output=process.env.ORACLE_BROWSER_OUTPUT||'/tmp/oracle-followup-browser';await mkdir(output,{recursive:true});
try{
  for(const [name,width,height]of [['desktop',1280,900],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height}});await page.goto(`http://127.0.0.1:${server.address().port}/oracle/`);
    await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
    assert.equal(await page.locator('#new-question').isVisible(),true);
    const ask=async text=>{await page.locator('#message').fill(text);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);return page.locator('#messages .analytical-answer').last();};
    let answer=await ask('How are mobile and desktop conversion rates this year?');
    const annual=await answer.innerText();assert.match(annual,/2026-10/);assert.doesNotMatch(annual,/Showing 12/);
    for(let i=0;i<2;i++){
      answer=await ask('What changed between August and September?');const visible=await answer.innerText();assert.match(visible,/2026-08/);assert.match(visible,/2026-09/);assert.match(visible,/3.00 percentage points/);assert.doesNotMatch(visible,/2026-01|Today’s data/);
      const details=answer.locator('details').first();assert.equal(await details.evaluate(el=>el.open),false);await details.locator('summary').focus();await page.keyboard.press('Enter');assert.equal(await details.evaluate(el=>el.open),true);await page.keyboard.press('Space');assert.equal(await details.evaluate(el=>el.open),false);
      assert.match(await page.locator('#analysis-indicator').innerText(),/2026-09.*vs 2026-08/);
    }
    const history=await page.locator('#messages .message').count();await page.locator('#new-question').click();await page.waitForFunction(()=>document.querySelector('#analysis-indicator').hidden);
    assert.equal(await page.locator('#messages .message').count(),history);
    const before=calls.length;answer=await ask('What changed between August and September?');assert.match(await answer.innerText(),/Which analysis/);assert.equal(calls.length,before);
    await ask('How are mobile and desktop conversion rates this year?');assert.equal(calls.length,before+10);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
    await page.screenshot({path:`${output}/${name}.png`,fullPage:true});console.log(`${name}: actual UI sequence, repeat, scope indicator, keyboard details, reset, visible history and provider periods passed`);await page.close();
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
