// Native composer and visible delivery, backed by real Oracle composition.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {durableJsonWire} from '../test/helpers/durable-json-wire.js';
import { acceptanceFixture, acceptanceServer } from '../test/helpers/oracle-acceptance.js';
const {chromium}=await import(process.env.ORACLE_BROWSER_DRIVER||'playwright-core');
const multipart=JSON.parse(readFileSync(new URL('../test/fixtures/oracle-multipart-questions.json',import.meta.url)));
const matrix=JSON.parse(readFileSync(new URL('../test/fixtures/oracle-acceptance-matrix.json',import.meta.url)));
const f=acceptanceFixture(),h=await acceptanceServer(f,{durable:true});
const browser=await chromium.launch({executablePath:process.env.ORACLE_CHROMIUM||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),headless:true,args:['--no-sandbox']});
const output=process.env.ORACLE_BROWSER_OUTPUT||'/tmp/oracle-acceptance-browser';await mkdir(output,{recursive:true});
try{
  for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
    for(const conversation of matrix.conversations){
      f.state.named_events=Boolean(conversation.named_events);f.state.retention=Boolean(conversation.retention);f.state.retention_events=Boolean(conversation.retention_events);f.state.fail_start=conversation.fail_start||null;f.state.campaigns=Boolean(conversation.campaigns);f.state.country_conversion=Boolean(conversation.country_conversion);
      await page.locator('#new-question').click();
      for(const turn of conversation.turns){
        const count=await page.locator('.analytical-answer').count(),offset=f.calls.length;
        await page.locator('#message').fill(turn.question);await page.locator('#send').click();
        await page.waitForFunction(()=>!document.querySelector('#send').disabled);
        assert.equal(await page.locator('.analytical-answer').count(),count+1);
        const answer=await page.locator('.analytical-answer').last().innerText();assert.ok(answer.trim());
        if(turn.outcome==='clarification')assert.match(answer,/start and end dates/i);
        else assert.doesNotMatch(answer,/What date range/);
        if(turn.check==='named-events'){
          assert.match(answer,/Black Friday/);assert.match(answer,/150/);assert.match(answer,/100/);
          const last=page.locator('.analytical-answer').last();assert.ok(await last.locator('table').count());
          assert.equal(await last.locator('details').count(),1);assert.equal(await last.locator('summary').innerText(),'Show details');
          await last.locator('summary').click();assert.match(await last.innerText(),/VIP|vip_early_access/);assert.match(await last.innerText(),/coverage|completeness/);
          const count=f.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
          assert.match(await page.locator('.analytical-answer').last().innerText(),/150/);assert.equal(f.calls.length,count);
        }
        if(turn.check==='visitor-monthly'){if(turn.grain==='month'){assert.match(answer,/Month/);assert.match(answer,/completed-checkout sessions/);}if(turn.groups.includes('rest_of_world'))assert.match(answer,/unknown\/blank\/ZZ/);}
        if(turn.check==='retention-incident'){
          assert.match(answer,/Beta has the highest observed repeat purchase rate at 90 days/);assert.match(answer,/Pieces within Alpha/);assert.match(answer,/33.33%/);assert.equal(f.calls.length,offset+6);
          const last=page.locator('.analytical-answer').last();assert.equal(await last.locator('details').count(),1);assert.equal(await last.locator('summary').innerText(),'Show details');
          assert.doesNotMatch(answer,/<details>|<summary>|woo:ww:|UTC order dates/);
          await last.locator('summary').click();assert.match(await last.innerText(),/8 eligible identified first-observed/);assert.match(await last.innerText(),/1 generic-only/);
          const count=f.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));assert.match(await page.locator('.analytical-answer').last().innerText(),/Pieces within Alpha/);assert.equal(f.calls.length,count);
          await page.locator('#message').fill('Export that to Excel and show a chart.');await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
          const optional=page.locator('.analytical-answer').last();assert.match(await optional.innerText(),/supported table is retained/);assert.match(await optional.innerText(),/33.33%/);assert.match(await optional.innerText(),/XLSX: unsupported/);assert.match(await optional.innerText(),/CHART: unsupported/);assert.equal(f.calls.length,count);
        }
        if(turn.check==='retention'){assert.match(answer,/75\.00%/);assert.match(answer,/50\.00%/);assert.match(answer,/Mature 90-day customers/i);assert.equal(f.calls.length,offset+(turn.provider_count||1));}
        if(turn.check==='campaigns-available'){
          assert.match(answer,/Campaign 1/);assert.match(answer,/Campaign 2/);assert.match(answer,/Campaign 3/);assert.match(answer,/30\.00 GBP/);
          assert.equal(f.calls.filter(c=>c.discovery).length,2*(name==='desktop'?1:2));
          const details=page.locator('.analytical-answer').last().locator('details').first();await details.locator('summary').click();assert.match(await details.innerText(),/not incremental sales/);
        }
        if(turn.check==='visitor-conversion-supported'){assert.match(answer,/1\.90%|2\.40%/);assert.doesNotMatch(answer,/Mobile|Desktop/);assert.match(answer,/Sessions/);assert.match(answer,/Conversion numerator/);if(turn.groups.includes('rest_of_world')){assert.match(answer,/2\.90%/);assert.match(answer,/excluding GB/);}if(turn.groups.includes('global')&&turn.groups.includes('country'))assert.match(answer,/overlap/);}
        if(turn.check==='visitor-conversion-unavailable'){assert.match(answer,/Visitor-country conversion is unavailable/);assert.match(answer,/cutoff: unavailable/);assert.doesNotMatch(answer,/Mobile.*Desktop/);assert.equal(f.calls.length,offset);}
        if(turn.check==='basket'){
          assert.match(answer,/Additional items required/);assert.doesNotMatch(answer,/Losing eligibility|Product 1/);
          const details=page.locator('.analytical-answer').last().locator('details').first();await details.locator('summary').click();
          assert.match(await details.innerText(),/Product 1/);assert.match(await details.innerText(),/GBP 240\.00/);assert.match(await details.innerText(),/VAT|Tax inclusion/i);
        }
        if(turn.check==='checkout'){assert.match(answer,/Checkout identities/);assert.match(answer,/Completed orders cannot/);assert.equal(f.calls.length,offset);if(turn.dates)assert.match(answer,new RegExp(turn.dates.join(' to ')));}
        if(turn.check==='sales'||turn.check==='partial-sales'){assert.match(answer,/Online Store/);assert.ok(f.calls.slice(offset).every(c=>c.provider==='sales'));}
        if(turn.check==='countries'){assert.match(answer,/GBP 200/);const details=page.locator('.analytical-answer').last().locator('details').first();await details.locator('summary').click();assert.match(await details.innerText(),/GBP 50/);}
        if(turn.check==='customers'){assert.match(answer,/Customer figures/);assert.match(answer,/10/);assert.match(answer,/monthly counts cannot be added/);assert.match(answer,/1 September 2026/);}
      }
    }
    // The unchanged provider incident must survive visible durable delivery and refresh.
    f.state.retention_events=true;f.state.retention=true;
    await page.locator('#new-question').click();
    const incidentQuestion=readFileSync(new URL('../test/fixtures/oracle-cohort-provider-question.txt',import.meta.url),'utf8').trim(),incidentOffset=f.calls.length;
    await page.locator('#message').fill(incidentQuestion);await page.locator('#send').click();
    await page.waitForFunction(()=>!document.querySelector('#send').disabled);
    const incidentAnswer=page.locator('.analytical-answer').last();
    assert.match(await incidentAnswer.innerText(),/Beta has the highest observed repeat purchase rate at 90/);
    assert.match(await incidentAnswer.innerText(),/33.33%/);assert.match(await incidentAnswer.innerText(),/Small/);
    assert.equal(await incidentAnswer.locator('details').count(),1);assert.equal(f.calls.length,incidentOffset+3);
    assert.ok(f.calls.slice(incidentOffset).every(c=>c.args.observation_end==='2026-10-13'&&c.args.entry_channel===null));
    const incidentCount=f.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
    assert.match(await page.locator('.analytical-answer').last().innerText(),/33.33%/);assert.equal(f.calls.length,incidentCount);
    f.state.retention_events=false;
    await page.locator('#new-question').click();
    for(const [kind,question] of Object.entries(multipart)){
      await page.locator('#message').fill(question);await page.locator('#send').click();
      await page.waitForFunction(()=>!document.querySelector('#send').disabled);
      const last=page.locator('.analytical-answer').last(),answer=await last.innerText();
      if(kind==='INITIAL'){assert.match(answer,/denominators differ/);assert.match(answer,/median/);}
      if(kind==='DETAIL'){assert.match(answer,/4 reconciled baskets/);assert.match(answer,/259.99|260.00/);assert.match(answer,/Product 4/);assert.doesNotMatch(answer.split('Show details')[0],/Additional items required/);}
      if(kind==='UNDERLYING')assert.match(answer,/anonymous/i);
      const download=page.locator('a[href*="/api/oracle/exports/"]').last();await download.waitFor();
      const response=await page.request.get(new URL(await download.getAttribute('href'),h.origin).href);assert.equal(response.status(),200);assert.ok((await response.body()).length>1000);
    }
    for(const question of JSON.parse(readFileSync(new URL('../test/fixtures/oracle-basket-incidents.json',import.meta.url)))){
      await page.locator('#new-question').click();
      await page.locator('#message').fill(question);await page.locator('#send').click();
      await page.waitForFunction(()=>!document.querySelector('#send').disabled);
      const last=page.locator('.analytical-answer').last();
      assert.match(await last.innerText(),/4 reconciled baskets/);
      assert.match(await last.innerText(),/Product 4/);
      const links=last.locator('a[href*="/api/oracle/exports/"]');assert.equal(await links.count(),1);
      const response=await page.request.get(new URL(await links.first().getAttribute('href'),h.origin).href);
      assert.equal(response.status(),200);const book=new ExcelJS.Workbook();await book.xlsx.load(await response.body());
      assert.equal(book.getWorksheet('Basket bands').rowCount,5);
      const count=f.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
      assert.match(await page.locator('.analytical-answer').last().innerText(),/4 reconciled baskets/);assert.equal(f.calls.length,count);
    }
    const multipartCalls=f.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
    assert.match(await page.locator('.analytical-answer').last().innerText(),/4 reconciled baskets/);assert.equal(f.calls.length,multipartCalls);
    // Force real durable submission, restore in browser after a refresh, and
    // prove polling/latest recovery doesn't retrieve provider data again.
    f.state.fail_start=null;f.state.retention_events=false;
    const job=await page.evaluate(async()=>{
      const csrf=document.cookie.split('; ').find(v=>v.startsWith('oracle_csrf='))?.split('=')[1];
      const r=await fetch('/api/oracle/jobs',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,'x-request-id':crypto.randomUUID()},body:JSON.stringify({message:'Show online sales for the last 30 completed days.',new_question:true})});
      const data=await r.json();localStorage.setItem('oracle-active-analysis-job',data.job_id);localStorage.setItem('oracle-pending-analysis-request',data.request_id);return data;
    });assert.ok(job.job_id);
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
    assert.match(await page.locator('.analytical-answer').last().innerText(),/Online Store/);
    const calls=f.calls.length;await page.reload();await page.locator('.analytical-answer').last().waitFor();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
    assert.match(await page.locator('.analytical-answer').last().innerText(),/Online Store/);assert.equal(f.calls.length,calls);
    // Exhaust the bounded GET retries, then reconnect to the same completed job.
    // This is a browser transport failure; no POST or provider replay is allowed.
    await page.evaluate(job=>{localStorage.setItem('oracle-active-analysis-job',job.job_id);localStorage.setItem('oracle-pending-analysis-request',job.request_id);},job);
    const beforeReconnect=f.calls.length;
    const statusPattern='**/api/oracle/jobs/*';
    await page.route(statusPattern,route=>route.request().method()==='GET'?route.abort('failed'):route.continue());
    await page.reload();await page.getByRole('button',{name:'Reconnect',exact:true}).waitFor();
    const disconnected=await page.locator('.message.oracle').last().innerText();
    assert.match(disconnected,/status could not be checked/);assert.doesNotMatch(disconnected,/Analysis failed/);
    assert.equal(await page.evaluate(()=>localStorage.getItem('oracle-active-analysis-job')),job.job_id);
    await page.unroute(statusPattern);await page.getByRole('button',{name:'Reconnect',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
    assert.match(await page.locator('.analytical-answer').last().innerText(),/Online Store/);assert.equal(f.calls.length,beforeReconnect);
    // A terminal failed job remains recoverable after refresh, with a clear
    // unsupported-replay explanation and no new submission or provider work.
    const ownedJob=h.jobs.jobs.get(job.job_id);
    const failed=await h.jobs.create({owner_key:ownedJob.owner_key,request_id:`browser-failed-${name}`,payload_json:ownedJob.payload_json});
    Object.assign(h.jobs.jobs.get(failed.job_id),{status:'failed',error_code:'WORKER_LEASE_EXPIRED'});
    await page.evaluate(failed=>{localStorage.setItem('oracle-active-analysis-job',failed.job_id);localStorage.setItem('oracle-pending-analysis-request',failed.request_id);},failed);
    for(let refresh=0;refresh<2;refresh++){
      await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.message.oracle'));
      const failure=await page.locator('.message.oracle').last().innerText();assert.match(failure,/Analysis failed/);assert.match(failure,/Automatic provider replay is unsupported/);
      assert.equal(await page.evaluate(()=>localStorage.getItem('oracle-active-analysis-job')),failed.job_id);assert.equal(f.calls.length,beforeReconnect);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.deepEqual(errors,[]);await page.screenshot({path:`${output}/${name}.png`,fullPage:true});await page.close();
  }
  // The default deployment has no certified continuous follow-up interval.
  // Verify its honest partial answer in the browser and after durable recovery.
  const uncertainFixture=acceptanceFixture({retention:true,retention_events:true,observationCertificates:[]});
  uncertainFixture.state.fail_retention_stores=['usd'];
  const uncertainServer=await acceptanceServer(uncertainFixture,{durable:true});
  try{
    const {RETENTION_ANSWER_QUESTION}=await import('./oracle-retention-answer.js');
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.goto(uncertainServer.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
      await page.locator('#message').fill(RETENTION_ANSWER_QUESTION);await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
      const last=page.locator('.analytical-answer').last(),answer=await last.innerText();
      assert.match(answer,/coverage is unverified/);assert.match(answer,/observed \(coverage unverified\)/);assert.doesNotMatch(answer,/highest observed repeat purchase rate|\d+\.\d+%|<details>|<summary>/);
      assert.equal(await last.locator('details').count(),1);assert.equal(await last.locator('table').count(),2);
      const count=uncertainFixture.calls.length;await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
      assert.match(await page.locator('.analytical-answer').last().innerText(),/coverage is unverified/);assert.equal(uncertainFixture.calls.length,count);await page.close();
    }
  }finally{uncertainServer.close();}
  for(const identityMode of ['email_candidate_v1','email_candidate_v2']){
  const activatedFixture=acceptanceFixture({retention_events:true,observationCertificates:[],identityEnv:{ORACLE_CUSTOMER_IDENTITY_MODE:identityMode,ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'email-20261020-v1'}});
  const activatedServer=await acceptanceServer(activatedFixture,{durable:true});
  try{
    for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.goto(activatedServer.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
      await page.locator('#message').fill('Rank named collaborations by 90-day repeat purchase rate online over the last three years through yesterday, including linked Woo and Shopify history.');
      await page.locator('#send').click();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
      const answer=await page.locator('.analytical-answer').last().innerText();
      assert.match(answer,/email candidate snapshot/i);assert.match(answer,/coverage is unverified/);
      assert.doesNotMatch(answer,/customer linkage has not been verified/);
      if(identityMode==='email_candidate_v2'){assert.match(answer,/email-linked records/);assert.match(answer,/3 matched, 2 unmatched, 1 ambiguous, 2 unavailable/);}
      const reads=activatedFixture.wireQueries.length;
      await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
      assert.match(await page.locator('.analytical-answer').last().innerText(),/email candidate snapshot/i);
      assert.equal(activatedFixture.wireQueries.length,reads);await page.close();
    }
  }finally{activatedServer.close();}
  }
  // Retained 2026-10-22 incident scope, including the components absent from the old report.
  const collaborationQuestion=readFileSync(new URL('../test/fixtures/collaboration-retention-20261022.txt',import.meta.url),'utf8');
  for(const partial of [false,true]){
    const fullFixture=acceptanceFixture({retention_events:true,observationCertificates:[],now:Date.parse('2026-10-22T12:00:00Z'),identityEnv:{ORACLE_CUSTOMER_IDENTITY_MODE:'email_candidate_v2',ORACLE_CUSTOMER_IDENTITY_DATASET:'customer_identity',ORACLE_CUSTOMER_IDENTITY_SNAPSHOT:'fixture-order-email-v2'}});
    if(partial)fullFixture.state.fail_retention_stores=['usd'];
    const fullServer=await acceptanceServer(fullFixture,{durable:true,now:Date.parse('2026-10-22T12:00:00Z'),jobStore:durableJsonWire().store});
    try{for(const width of [1280,390]){
      const page=await browser.newPage({viewport:{width,height:900}});
      await page.goto(fullServer.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
      await page.locator('#message').fill(collaborationQuestion);await page.locator('#send').click();
      await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
      const answer=await page.locator('.analytical-answer').last().innerText();
      assert.match(answer,/360-day rate/);assert.match(answer,/Comparable sitewide/);assert.match(answer,/Second-order products/);assert.match(answer,/email-linked records/);
      assert.match(answer,/coverage is unverified/);assert.doesNotMatch(answer,/customer linkage has not been verified|highest observed repeat purchase rate|<details>|<summary>/);
      if(partial)assert.match(answer,/Woo USD[\s\S]*Read failed/);
      assert.equal(await page.locator('.analytical-answer').last().locator('details').count(),1);
      const reads=fullFixture.wireQueries.length;
      await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
      assert.equal(await page.locator('.analytical-answer').last().innerText(),answer);assert.equal(fullFixture.wireQueries.length,reads);
      await page.screenshot({path:output+'/collaboration-retention-'+width+'-'+partial+'.png',fullPage:true});await page.close();
    }}finally{fullServer.close();}
  }
  console.log(JSON.stringify({status:'passed',conversations:matrix.conversations.length,viewports:['desktop','mobile'],durable_refresh:true,activated_identity_refresh:true,output}));
}finally{await browser.close();h.close();}
