// Offline acceptance of actual worker, authenticated API, polling and full UI.
// ORACLE_BROWSER_DRIVER=/path/to/playwright-core/index.mjs node diagnostics/oracle-result-delivery-browser.mjs
import assert from 'node:assert/strict';
import express from 'express';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {createOracleUiRouter} from '../oracle/ui-router.js';
import {createMemoryAnalysisJobStore,ownerKey} from '../oracle/analysis-jobs.js';
const {chromium}=await import(process.env.ORACLE_BROWSER_DRIVER||'playwright-core');
const root=fileURLToPath(new URL('../',import.meta.url)),store=createMemoryAnalysisJobStore();
const artifact={id:'a'.repeat(64),download_url:'/api/oracle/exports/'+'a'.repeat(64),filename:'fixture.xlsx',row_count:2};
const cases=[
  {name:'empty',input:{},visible:/finished without a usable answer/},
  {name:'model-evidence',input:{answer:'',evidence:{kind:'governed_tool_results',results:[{name:'get_shopify_sales_kpis',result:{orders:12,net_sales:2400}}]}},visible:/2,400/},
  {name:'presentation',input:{presentation:{version:1,summary_markdown:'Campaign attribution available.'}},visible:/Campaign attribution/},
  {name:'clarification',input:{clarification:{message:'Which product do you mean?'}},visible:/Which product/},
  {name:'artifact',input:{artifact},visible:/download is ready/},
  {name:'expired',input:{artifact:{...artifact,status:'expired'}},visible:/finished without a usable answer/},
  {name:'comparison',input:{answer:'Available sales comparison\n\n<details>\n<summary>Show details</summary>\n\nGBP 1234\n\n</details>'},visible:/Available sales comparison/},
  {name:'multi-section',input:{answer:'Available scenario sections\n\n| Scenario | Effect |\n|---|---|\n| £175 | Unavailable |\n\nPromotion context is unavailable.',partial:true},visible:/Available scenario sections/},
  {name:'render-exception',input:{answer:'The validated answer survives a renderer failure.'},visible:/validated answer survives/},
];
let executions=0;
const app=express();app.use('/oracle',express.static(root+'public/oracle'));
const secret='fixture-session-secret-with-enough-bytes';
app.use('/api/oracle',createOracleUiRouter({knowledgeService:{searchKnowledge:async()=>({items:[{kind:'event',status:'confirmed',id:'may-sale',title:'May online sale',content:'Online sale.',effective_from:'2026-05-01',effective_to:'2026-05-04',date_precision:'range',source_type:'human',source_reference:'confirmed-fixture',tags:['online']}]})},project:'p',bigquery:{},analysisJobStore:store,generateProposals:async()=>[],chat:async message=>{executions++;const item=cases[Number(message.match(/case (\d+)/)?.[1])];return item?.input||{};},env:{ORACLE_UI_PASSWORD:'fixture',ORACLE_UI_SESSION_SECRET:secret,ORACLE_ANALYSIS_JOBS_ENABLED:'true'}}));
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
const browser=await chromium.launch({executablePath:process.env.ORACLE_CHROMIUM||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const output=process.env.ORACLE_BROWSER_OUTPUT||'/tmp/oracle-result-delivery-browser';await mkdir(output,{recursive:true});
try{
 for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]){
  const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/oracle/`);await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  // Direct response follows the same blank-result contract.
  await page.locator('#message').fill('Review this evidence.');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.match(await page.locator('.analytical-answer').last().innerText(),/finished without a usable answer/);
  for(const [index,item] of cases.entries()){
   if(item.name==='render-exception')await page.addInitScript(()=>{const original=Element.prototype.append;Element.prototype.append=function(...nodes){if(this.classList?.contains('analytical-answer')&&nodes.some(n=>n.classList?.contains('markdown'))){throw Error('fixture rendering failure');}return original.apply(this,nodes);};});
   const submission=await page.evaluate(async index=>{const csrf=document.cookie.split('; ').find(x=>x.startsWith('oracle_csrf='))?.split('=')[1],id=crypto.randomUUID();const options={method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,'x-request-id':id},body:JSON.stringify({message:`Review case ${index}.`,new_question:true})};const data=await(await fetch('/api/oracle/jobs',options)).json();const again=await(await fetch('/api/oracle/jobs',options)).json();localStorage.setItem('oracle-active-analysis-job',data.job_id);localStorage.setItem('oracle-pending-analysis-request',id);return {data,again};},index);
   assert.equal(submission.data.job_id,submission.again.job_id);
   let interruptions=0;
   if(item.name==='model-evidence')await page.route('**/api/oracle/jobs/'+submission.data.job_id,async route=>{if(interruptions++===0)return route.abort('failed');return route.continue();});
   await page.reload();await page.locator('.analytical-answer').last().waitFor();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.match(await page.locator('.analytical-answer').last().innerText(),item.visible,item.name);
   if(item.name==='expired')assert.equal(await page.locator('a[download]').count(),0);
   if(item.name==='artifact')assert.equal(await page.locator('a[download]').count(),1);
   if(item.name==='comparison'){const details=page.locator('.analytical-answer details').first();assert.equal(await details.evaluate(e=>e.open),false);await details.locator('summary').click();assert.match(await details.innerText(),/GBP 1234/);}
   if(item.name==='multi-section')assert.equal(await page.locator('.markdown-table-scroll').count(),1);
   if(item.name==='model-evidence'){await page.reload();await page.locator('.analytical-answer').last().waitFor();assert.match(await page.locator('.analytical-answer').last().innerText(),/2,400/);await page.unroute('**/api/oracle/jobs/'+submission.data.job_id);}
  }
  await page.locator('#new-question').click();
  await page.locator('#message').fill('Analyse UK online GBP order-value bands this year through the latest completed day. Current free shipping threshold £250; delivery £8 below. Compare thresholds £175, £200, £225, £275 and £300 under unchanged purchasing behaviour. Include add-on products and May sale context. No collection or mutation.');
  await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  const shipping=await page.locator('.analytical-answer').last().innerText();assert.match(shipping,/order-value analysis is unavailable/);assert.match(shipping,/Confirmed promotion context/);assert.match(shipping,/Add-on suggestions are unavailable/);
  await page.screenshot({path:`${output}/${name}-shipping.png`,fullPage:true});
  // A terminal persistence failure must deliver checkpoint evidence, stop busy
  // state, and retain the authoritative failed status.
  const session=(await page.context().cookies()).find(c=>c.name==='oracle_session').value;
  const failed=await store.create({owner_key:ownerKey(session,secret),request_id:crypto.randomUUID(),payload_json:{}});const saved=store.jobs.get(failed.job_id);saved.status='failed';saved.result_json={evidence:{orders:31}};
  await page.evaluate(id=>{localStorage.setItem('oracle-active-analysis-job',id);localStorage.setItem('oracle-pending-analysis-request','recover-failure');},failed.job_id);
  await page.reload();await page.locator('.analytical-answer').last().waitFor();await page.waitForFunction(()=>!document.querySelector('#send').disabled);assert.match(await page.locator('.analytical-answer').last().innerText(),/31/);
  assert.equal(errors.length,0,errors.join('\n'));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`${output}/${name}.png`,fullPage:true});console.log(`${name}: full UI, direct/worker/poll/recovery, empty/evidence/presentation/artifact/clarification, interruption, renderer failure, failed checkpoint, details and same-ID submission passed`);await page.close();
 }
 assert.equal(executions,2*(cases.length+1));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
