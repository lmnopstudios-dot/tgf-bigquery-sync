// Offline real UI/owned-artifact acceptance. No production credentials/providers.
import assert from 'node:assert/strict';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { createMemoryAnalysisJobStore } from '../oracle/analysis-jobs.js';
import { createMemoryExportStore } from '../oracle/product-priority-storage.js';
import { createOracleProviderDependencies } from '../oracle/provider-dependencies.js';
import { createShopifySalesKpiService } from '../oracle/daily-sales-provider.js';
import { createBaselineOverviewService } from '../oracle/baseline-overview.js';
import ExcelJS from 'exceljs';
const {chromium}=await import(process.env.ORACLE_BROWSER_DRIVER||'playwright-core');
const root=fileURLToPath(new URL('../',import.meta.url)),output=process.env.ORACLE_BROWSER_OUTPUT||'/tmp/oracle-weekday-browser';await mkdir(output,{recursive:true});
const now=Date.parse('2026-10-12T12:00Z'),store=createMemoryExportStore();let providerCalls=0;
const shopifySales=createShopifySalesKpiService({runReport:async()=>{providerCalls++;return [{day:'2026-05-01',net_sales:900,orders:9},{day:'2026-05-08',net_sales:100,orders:1},{day:'2026-05-15',net_sales:200,orders:2},{day:'2026-05-04',net_sales:1000,orders:10},{day:'2026-05-11',net_sales:100,orders:1}];},getShop:async()=>({id:'gid://shopify/Shop/1',currencyCode:'GBP',ianaTimezone:'Europe/London'})});
const deps=createOracleProviderDependencies({project:'fixture',bigquery:{query:async()=>{throw Error('Unexpected provider');}},shopifySales,env:{}});
const promotion={id:'ev-browser-sale',kind:'event',status:'confirmed',title:'May Bank Holiday silver jewellery sale 2026',content:'The May Bank Holiday sale offered 20% off silver jewellery, excluding collaborations and mixed-metal items. Subscribers received VIP access on 1 May 2026. The sale opened to everyone on 2 May 2026 and ended at midnight GMT on 4 May 2026. It was available online and in stores.',date_precision:'unknown',effective_from:null,effective_to:null,source_type:'human_entered',source_reference:'fixture promotion plan',tags:['retail','promotion']};
const knowledgeService={getBusinessContext:async()=>({items:[promotion]}),searchKnowledge:async args=>({items:args.knowledge_type==='event'?[promotion]:[]}),searchMemory:async()=>({items:[]})};
const baseline=createBaselineOverviewService({dailySales:deps.dailySales,knowledgeService,socialExportStore:store,now:()=>new Date(now)}),app=express();
app.use('/api/oracle',createOracleUiRouter({env:{ORACLE_UI_PASSWORD:'fixture-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012',ORACLE_ANALYSIS_JOBS_ENABLED:'true'},analysisJobStore:createMemoryAnalysisJobStore(),baselineOverview:baseline,chat:async()=>{throw Error('Unexpected model fallback');},knowledgeService,exportStore:store,generateProposals:async()=>[],now:()=>now}));
app.use('/oracle',express.static(root+'public/oracle'));
const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.on('error',reject);});
const browser=await chromium.launch({executablePath:process.env.ORACLE_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
  for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height},acceptDownloads:true}),base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(base+'/oracle/');await page.locator('#password').fill('fixture-password');await page.locator('#login-form button').click();await page.waitForSelector('#composer');
    // Submit through the real composer, durable worker, renderer and owned download.
    await page.locator('#message').fill('Show online sales by weekday this year, taking into account the May bank holiday sale. Chart that. Show the covered and expected days; keep the currency scope; preserve the year-to-date window; use only completed days; keep missing days unavailable; preserve successful evidence; put supporting definitions in Show details; keep the weekday bar chart consistent. Run a complete analysis using only the supported evidence.');await page.locator('#send').click();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message.oracle')).at(-1)?.innerText.includes('temporal interpretation is unresolved'));
    const originalJob=await page.evaluate(()=>localStorage.getItem('oracle-active-analysis-job'));assert.ok(originalJob,'The composer must use durable delivery for this complete request');
    assert.match(await page.locator('.message.oracle').last().innerText(),/temporal interpretation is unresolved/);
    await page.locator('#message').fill('Include 4 May as a sale day. Exclude 1–4 May inclusive from the comparison.');await page.locator('#send').click();
    await page.waitForFunction(()=>document.querySelectorAll('.message.oracle').length>=2&&Array.from(document.querySelectorAll('.message.oracle')).at(-1).innerText.includes('comparison excludes your selected inclusive calendar days'));
    assert.equal(await page.evaluate(()=>localStorage.getItem('oracle-active-analysis-job')),null,'Interactive clarification must retire the old completed job pointer');
    const snapshotCalls=providerCalls;await page.reload();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.message.oracle')).at(-1)?.innerText.includes('comparison excludes your selected inclusive calendar days'));assert.equal(providerCalls,snapshotCalls);
    await page.locator('#message').fill('Export that and chart it.');await page.locator('#send').click();
    const initialDownload=page.getByRole('link',{name:/Download weekday sales/}).last();await initialDownload.waitFor();
    const downloadUrl=await initialDownload.getAttribute('href'),result=await(await page.request.get(base+downloadUrl+'/manifest')).json();
    assert.equal(result.success,true);assert.deepEqual(result.evidence.applied_exclusions,['2026-05-01','2026-05-02','2026-05-03','2026-05-04']);assert.equal(result.evidence.promotion.comparison_treatment,'user_selected_calendar_days');assert.equal(result.evidence.promotion.source_events[0].id,promotion.id);assert.equal(result.evidence.retained_daily_evidence,true);
    // Remove the saved job pointer to exercise artifact-only refresh recovery too.
    await page.evaluate(()=>localStorage.removeItem('oracle-active-analysis-job'));
    const calls=providerCalls;await page.route('**/api/oracle/analysis/latest',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({success:true,analysis:null})}));await page.reload();const download=page.getByRole('link',{name:/Download weekday sales/}).last();await download.waitFor();await page.unroute('**/api/oracle/analysis/latest');assert.equal(providerCalls,calls);
    const message=page.locator('.message.oracle').last();assert.match(await message.innerText(),/highest average net sales/);assert.match(await message.innerText(),/provisional/);assert.match(await message.innerText(),/comparison excludes your selected inclusive calendar days/);assert.doesNotMatch(await message.innerText(),/Did “midnight/);
    const details=message.locator('details').first();assert.equal(await details.evaluate(e=>e.open),false);await details.locator('summary').first().focus();await page.keyboard.press('Enter');assert.equal(await details.evaluate(e=>e.open),true);await page.keyboard.press('Space');assert.equal(await details.evaluate(e=>e.open),false);
    assert.ok(await message.locator('figure .inline-bars').count());const bars=await message.locator('figure .bar-fill').evaluateAll(elements=>elements.map(e=>parseFloat(e.style.width)));assert.ok(new Set(bars).size>2,'Weekdays must share a financial scale');const scroll=message.locator('.markdown-table-scroll').first();assert.equal(await scroll.getAttribute('tabindex'),'0');assert.ok(await scroll.locator('table thead').count());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const artifact=await(await page.request.get(base+result.artifact.download_url)).body(),wb=new ExcelJS.Workbook();await wb.xlsx.load(artifact);assert.equal(wb.getWorksheet('Sales').rowCount,8);
    const pendingDownload=page.waitForEvent('download');await download.click();const saved=await pendingDownload;assert.equal(saved.suggestedFilename(),'oracle-weekday-sales.xlsx');
    await page.screenshot({path:`${output}/${name}.png`,fullPage:true});await page.reload();await page.getByRole('link',{name:/Download weekday sales/}).waitFor();assert.equal(providerCalls,calls);
    await page.evaluate(id=>localStorage.setItem('oracle-active-analysis-job',id),originalJob);await page.locator('#new-question').click();await page.waitForFunction(()=>localStorage.getItem('oracle-active-analysis-job')===null);assert.equal(await page.evaluate(()=>localStorage.getItem('oracle-active-analysis-job')),null);const clearedRecovery=page.waitForResponse(r=>r.url().endsWith('/analysis/latest'));await page.reload();await clearedRecovery;assert.equal(await page.locator('.message.oracle').count(),1);assert.equal(await page.locator('.message.oracle p').innerText(),'How can I help?');assert.equal(await page.locator('.analytical-answer').count(),0);
    console.log(`${name}: durable composer, inclusive clarification, latest non-export recovery, weekday chart, Show details keyboard controls, semantic table, viewport scrolling, XLSX and refresh recovery passed`);await page.close();
  }
}finally{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
