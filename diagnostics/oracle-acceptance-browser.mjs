// Native composer and visible delivery, backed by real Oracle composition.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { acceptanceFixture, acceptanceServer } from '../test/helpers/oracle-acceptance.js';
const {chromium}=await import(process.env.ORACLE_BROWSER_DRIVER||'playwright-core');
const matrix=JSON.parse(readFileSync(new URL('../test/fixtures/oracle-acceptance-matrix.json',import.meta.url)));
const f=acceptanceFixture(),h=await acceptanceServer(f,{durable:true});
const browser=await chromium.launch({executablePath:process.env.ORACLE_CHROMIUM||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':chromium.executablePath()),headless:true,args:['--no-sandbox']});
const output=process.env.ORACLE_BROWSER_OUTPUT||'/tmp/oracle-acceptance-browser';await mkdir(output,{recursive:true});
try{
  for(const [name,width,height] of [['desktop',1280,900],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(h.origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
    for(const conversation of matrix.conversations){
      f.state.fail_start=conversation.fail_start||null;f.state.campaigns=Boolean(conversation.campaigns);f.state.country_conversion=Boolean(conversation.country_conversion);
      await page.locator('#new-question').click();
      for(const turn of conversation.turns){
        const count=await page.locator('.analytical-answer').count(),offset=f.calls.length;
        await page.locator('#message').fill(turn.question);await page.locator('#send').click();
        await page.waitForFunction(()=>!document.querySelector('#send').disabled);
        assert.equal(await page.locator('.analytical-answer').count(),count+1);
        const answer=await page.locator('.analytical-answer').last().innerText();assert.ok(answer.trim());
        if(turn.outcome==='clarification')assert.match(answer,/start and end dates/i);
        else assert.doesNotMatch(answer,/What date range/);
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
    // Force real durable submission, restore in browser after a refresh, and
    // prove polling/latest recovery doesn't retrieve provider data again.
    f.state.fail_start=null;
    const job=await page.evaluate(async()=>{
      const csrf=document.cookie.split('; ').find(v=>v.startsWith('oracle_csrf='))?.split('=')[1];
      const r=await fetch('/api/oracle/jobs',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,'x-request-id':crypto.randomUUID()},body:JSON.stringify({message:'Show online sales for the last 30 completed days.',new_question:true})});
      const data=await r.json();localStorage.setItem('oracle-active-analysis-job',data.job_id);localStorage.setItem('oracle-pending-analysis-request',data.request_id);return data;
    });assert.ok(job.job_id);
    await page.reload();await page.waitForFunction(()=>!document.querySelector('#send').disabled&&document.querySelector('.analytical-answer'));
    assert.match(await page.locator('.analytical-answer').last().innerText(),/Online Store/);
    const calls=f.calls.length;await page.reload();await page.locator('.analytical-answer').last().waitFor();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
    assert.match(await page.locator('.analytical-answer').last().innerText(),/Online Store/);assert.equal(f.calls.length,calls);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.deepEqual(errors,[]);await page.screenshot({path:`${output}/${name}.png`,fullPage:true});await page.close();
  }
  console.log(JSON.stringify({status:'passed',conversations:matrix.conversations.length,viewports:['desktop','mobile'],durable_refresh:true,output}));
}finally{await browser.close();h.close();}
