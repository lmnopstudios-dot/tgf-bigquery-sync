// Offline UI acceptance: ORACLE_BROWSER_DRIVER=/path/to/playwright-core/index.mjs
// node diagnostics/oracle-presentation-browser.mjs. No production providers run.
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createGeneralAnalyticsService } from '../oracle/general-analytics.js';
import { dispatchAnalysisRequest } from '../oracle/analysis-route-dispatcher.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';

const {chromium}=await import(process.env.ORACLE_BROWSER_DRIVER || 'playwright-core');
const root=fileURLToPath(new URL('../',import.meta.url));
const output=process.env.ORACLE_BROWSER_OUTPUT || '/tmp/oracle-presentation-browser';
await mkdir(output,{recursive:true});
const message='Show online sales for Gold Hoop this year.';
const service=createGeneralAnalyticsService({loadReport:async()=>({rows:[
  {period:'2026-08',canonical_title:'Gold Hoop',product_ref:'family:gold',source_platform:'shopify',source_store:'UK',source_product_id:'123',channel:'Online',currency:'GBP',product_sales:1234.567,units:12,orders_containing_product:8},
  {period:'2026-09',canonical_title:'Gold Hoop',product_ref:'family:gold',source_platform:'shopify',source_store:'UK',source_product_id:'123',channel:'Online',currency:'GBP',product_sales:2345.678,units:20,orders_containing_product:14}
],comparison_rows:[],coverage:{complete:false},retrieval:[{status:'fulfilled'}]})});
const result=await dispatchAnalysisRequest({message,analysisContext:transitionAnalysisContext(null,message,{now:Date.parse('2026-10-06T12:00:00Z')}).context,baselineOverview:service});
const app=express();
app.use('/oracle',express.static(root+'public/oracle'));
app.get('/fixture',(_req,res)=>res.json(result));
app.get('/',(_req,res)=>res.type('html').send(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oracle presentation acceptance</title><link rel="stylesheet" href="/oracle/app.css"><style>body{height:auto;overflow:auto}main{max-width:900px;margin:auto;padding:16px}.message{max-width:100%}</style><main><article class="message oracle"><div id="answer"></div></article></main><script type="module">import {renderAnalyticalAnswer} from '/oracle/answer.js';const result=await(await fetch('/fixture')).json();const answer=document.querySelector('#answer');result.answer=result.answer+'\\n\\n<script>window.untrustedExecuted=true<'+ '/script>';result.charts.unshift({version:1,kind:'line',table:{}});renderAnalyticalAnswer(answer,answer.parentElement,result);window.ready=true;</script></html>`));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const browser=await chromium.launch({executablePath:process.env.ORACLE_CHROMIUM || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try {
  for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]) {
    const page=await browser.newPage({viewport:{width,height}});
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);
    const details=page.locator('#answer details').first(),summary=details.locator('summary').first();
    assert.equal(await details.evaluate(el=>el.open),false);
    assert.equal(await summary.innerText(),'Show details');
    assert.ok(await page.locator('figure svg').count());
    assert.equal(await page.locator('figure details').evaluate(el=>el.open),false);
    assert.equal(await page.locator('script').count(),1);
    assert.equal(await page.evaluate(()=>Boolean(window.untrustedExecuted)),false);
    assert.match(await page.locator('#answer').innerText(),/Available sales/);
    await summary.focus();await page.keyboard.press('Enter');assert.equal(await details.evaluate(el=>el.open),true);
    await page.keyboard.press('Space');assert.equal(await details.evaluate(el=>el.open),false);
    await page.locator('figure summary').focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('figure details').evaluate(el=>el.open),true);
    const scroll=page.locator('.markdown-table-scroll').first();assert.equal(await scroll.getAttribute('tabindex'),'0');
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);
    assert.equal(overflow,false,`${name}: page must fit viewport`);
    await page.screenshot({path:`${output}/${name}-collapsed.png`,fullPage:true});
    await summary.click();await page.screenshot({path:`${output}/${name}-expanded.png`,fullPage:true});
    await page.reload();await page.waitForFunction(()=>window.ready);assert.equal(await page.locator('#answer details').first().evaluate(el=>el.open),false);
    assert.match(await page.locator('#answer').innerText(),/GBP 1,234.57/);
    console.log(`${name}: collapsed/expanded, Enter/Space, safe markup, chart failure fallback, scroll region and refresh passed`);
    await page.close();
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
