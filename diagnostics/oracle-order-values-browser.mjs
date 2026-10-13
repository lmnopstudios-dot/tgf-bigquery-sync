// Offline browser acceptance with production factory and aggregate fixtures.
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
const {chromium}=await import(process.env.ORACLE_BROWSER_DRIVER||'playwright-core');
const exportStore=createMemoryExportStore(),jobs=createMemoryAnalysisJobStore();
const fixtureRows=[{date:'2026-08-02',amount:200,shipping_charge:8,orders:2},{date:'2026-09-01',amount:225,shipping_charge:null,orders:3},{date:'2026-09-02',amount:250,shipping_charge:8,orders:1},{date:'2026-09-03',amount:null,shipping_charge:null,orders:1}];
const bigquery={dataset:()=>({getMetadata:async()=>[{location:'EU'}]}),query:async o=>{const rows=fixtureRows.filter(r=>r.date>=o.params.start_date&&r.date<=o.params.end_date);return o.query.includes('GROUP BY 1,2,3')?[rows]:[[{eligible_orders:rows.reduce((n,r)=>n+r.orders,0),missing_financials:1}]];}};
const deps=createOracleProviderDependencies({bigquery,project:'fixture',env:{}});
const knowledgeService={searchKnowledge:async()=>({items:[{kind:'event',status:'confirmed',id:'may',title:'May online sale',content:'Online sale.',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range',source_type:'human',source_reference:'fixture',tags:['online']}]})};
const aggregateBaseline=createBaselineOverviewService({...deps,knowledgeService,socialExportStore:exportStore,productPrices:async()=>({complete:true,products:[{product_id:'7',title:'Pendant',product_type:'Pendant',destination_prices:[{variant_id:'v',price:'25.00',currency:'GBP',country:'GB'}]}]})});
const baselineOverview=createOracleBaselineDispatcher({ecommerceBaselineOverview:aggregateBaseline,currentStock:async()=>assert.fail('Unrelated inventory path'),productPriorityExport:async()=>assert.fail('Unrelated product path'),generalAnalytics:async()=>assert.fail('Unrelated sales path')});
const app=express();app.use('/oracle',express.static(fileURLToPath(new URL('../public/oracle',import.meta.url))));app.use('/api/oracle',createOracleUiRouter({project:'fixture',bigquery,knowledgeService,baselineOverview,exportStore,analysisJobStore:jobs,generateProposals:async()=>[],chat:async()=>assert.fail('Unrelated model call'),env:{ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:'fixture-secret-with-enough-bytes',ORACLE_ANALYSIS_JOBS_ENABLED:'true'}}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const output='/tmp/oracle-order-values-browser';await mkdir(output,{recursive:true});
try{
  for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/oracle/`);await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
    const send=async text=>{await page.locator('#message').fill(text);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);const answer=page.locator('.analytical-answer').last();await answer.waitFor();return answer;};
    let answer=await send('Assess UK online GBP free shipping for September 2026. Compare £250 with £200 and £225, assuming purchasing behaviour stays unchanged. Show affected order counts, recorded shipping charges and the separate hypothetical £8 calculation. State the order-value basis and any unknown values.');
    assert.match(await answer.innerText(),/shipping-rule basis is unverified/);assert.ok(await answer.locator('table').count()>=2);assert.ok(await page.locator('.inline-chart').count()>0);
    const details=answer.locator('details').filter({has:page.locator('summary', {hasText:'Show details'})}).first();assert.equal(await details.evaluate(e=>e.open),false);await details.locator('summary').click();assert.match(await details.innerText(),/Finance collector/);
    answer=await send('Try £175');assert.match(await answer.innerText(),/GBP 175/);
    answer=await send('Just August');assert.match(await answer.innerText(),/1 August 2026.*31 August 2026/);
    answer=await send('Show the bands');assert.ok(await answer.locator('table').count()>=2);
    answer=await send('Just September.');assert.match(await answer.innerText(),/1 September 2026.*30 September 2026/);
    answer=await send('Export that.');const link=page.locator('a[download]').last();await link.waitFor();const href=await link.getAttribute('href');assert.match(href,/\/api\/oracle\/exports\/[a-f0-9]{64}/);
    const download=await page.request.get(`http://127.0.0.1:${server.address().port}${href}`);assert.equal(download.status(),200);assert.match(download.headers()['content-disposition'],/oracle-order-value-scenarios/);assert.ok((await download.body()).length>1000);
    const ownerless=await browser.newContext();assert.equal((await ownerless.request.get(`http://127.0.0.1:${server.address().port}${href}`)).status(),401);await ownerless.close();
    await page.screenshot({path:`${output}/${name}.png`,fullPage:true});
    await page.reload();await page.locator('.analytical-answer').last().waitFor();assert.match(await page.locator('.analytical-answer').last().innerText(),/GBP 175/);assert.ok(await page.locator('a[download]').count()>0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page overflow');assert.deepEqual(errors,[]);await page.close();
    console.log(JSON.stringify({viewport:name,tables:true,charts:true,details:true,followups:true,owned_download:true,refresh:true,fixture_only:true}));
  }
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
