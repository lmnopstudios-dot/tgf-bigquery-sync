import assert from 'node:assert/strict';
import {historicalFixture} from './historical-collaboration-fixture.js';
export async function verifyHistoricalCollaborationPanel({browser,origin,output}){
 for(const width of [1280,390]){
  const f=historicalFixture({count:25});for(const ref of f.mapping.sources.map(p=>p.source_product_ref))f.mapping.state.outcomes.push({source_ref:ref,outcome:'no_equivalent'});
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];let posts=0,statusReads=0;
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{assert.match(d.message(),/Woo products/);assert.match(d.message(),/woo:ww:100/);assert.match(d.message(),/woo:usd:101/);assert.match(d.message(),/historical sales are unchanged/);await d.accept();});
  await page.route('**/api/oracle/collection-classifications**',route=>route.fulfill({json:{collections:[],summary:{total:0}}}));
  await page.route('**/api/oracle/historical-collaborations**',async route=>{
   const req=route.request(),url=new URL(req.url());
   try{
    if(req.method()==='POST'){
     const input=req.postDataJSON();posts++;assert.deepEqual(new Set(input.source_refs),new Set(['woo:ww:100','woo:usd:101']));assert.ok(!('shopify_parent_ref' in input));
     const result=await f.service.save(input,'Browser reviewer');
     // The warehouse commits, then the response is lost. Refresh must recover it.
     return route.fulfill(posts===1?{status:503,json:{error:'Fixture response interruption'}}:{json:{success:true,...result}});
    }
    if(url.pathname.includes('/operations/')){statusReads++;return route.fulfill({json:{success:true,...await f.service.status(url.pathname.split('/').at(-1),'Browser reviewer')}});}
    const data=await f.service.list(Object.fromEntries(url.searchParams));return route.fulfill({json:{success:true,...data}});
   }catch(e){return route.fulfill({status:503,json:{error:e.message}});}
  });
  await page.goto(origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('[data-view="product-classifications"]').click();await page.locator('#historical-classification-tab').click();await page.locator('.historical-product').first().waitFor();
  assert.equal(await page.locator('.historical-product').count(),25);assert.ok(await page.locator('#shopify-classification-panel').isHidden());assert.match(await page.locator('#historical-products').innerText(),/No current Shopify equivalent/);
  // Use actual wheel input, not locator auto-scrolling, to reach the final card.
  const last=page.locator('.historical-product').last();
  assert.ok((await last.boundingBox()).y>900,'Last product begins below the viewport');
  await page.mouse.move(width-35,750);
  for(let i=0;i<40;i++){await page.mouse.wheel(0,700);await page.waitForTimeout(20);if(await last.evaluate(n=>n.getBoundingClientRect().bottom<=innerHeight))break;}
  assert.ok(await last.evaluate(n=>{const r=n.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;}),'Wheel scrolling exposes the full final product');
  await last.locator('input').check();assert.ok(await last.locator('input').isChecked());await last.locator('input').uncheck();
  await page.screenshot({path:output+'/historical-woo-scroll-bottom-'+width+'.png',fullPage:false});
  const view=page.locator('#product-classifications');assert.ok(await view.evaluate(n=>n.scrollTop>0));
  for(let i=0;i<40;i++){await page.mouse.wheel(0,-1000);await page.waitForTimeout(20);if(await view.evaluate(n=>n.scrollTop===0))break;}
  assert.equal(await view.evaluate(n=>n.scrollTop),0,'Wheel returns to the collaboration controls');
  assert.equal(await page.locator('#historical-collaboration option').count(),3);assert.doesNotMatch(await page.locator('#historical-collaboration').innerText(),/Collaborations/);
  for(const ref of ['woo:ww:100','woo:usd:101'])await page.getByLabel('Classify '+ref,{exact:true}).check();assert.ok(await page.locator('#historical-save').isDisabled());await page.locator('#historical-collaboration').selectOption('10');await page.locator('#historical-save').click();
  await page.waitForFunction(()=>document.querySelector('#historical-status').textContent.includes('interrupted'));assert.ok(await page.locator('#historical-recover').isVisible());assert.equal(f.state.rows.length,4);
  await page.reload();await page.locator('#app').waitFor({state:'visible'});await page.locator('[data-view="product-classifications"]').click();await page.locator('#historical-classification-tab').click();
  await page.waitForFunction(()=>document.querySelector('#historical-status').textContent.includes('complete'));
  await page.waitForFunction(()=>document.querySelectorAll('.historical-product').length===25&&document.querySelector('#historical-products').textContent.includes('Direct collaboration: Alpha'));
  assert.equal(posts,1);assert.equal(statusReads,1);assert.equal(f.state.rows.length,4);assert.equal(f.mapping.state.families.length,0);assert.equal(f.mapping.state.mappings.length,0);
  await page.screenshot({path:output+'/historical-woo-collaborations-'+width+'.png',fullPage:true});
  assert.ok(await page.locator('#historical-products').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  for(const ref of ['woo:ww:100','woo:usd:101'])await page.getByLabel('Classify '+ref,{exact:true}).check();await page.locator('#historical-collaboration').selectOption('11');await page.locator('#historical-save').click();await page.waitForFunction(()=>document.querySelector('#historical-products').textContent.includes('Direct collaboration: Beta'));
  assert.equal(posts,2);assert.equal(f.active('woo:ww:100').find(r=>r.classification_type==='collaboration_name').classification_value,'beta');
  for(const ref of ['woo:ww:100','woo:usd:101'])await page.getByLabel('Classify '+ref,{exact:true}).check();await page.locator('#historical-revoke').click();await page.waitForFunction(()=>['woo:ww:100','woo:usd:101'].every(ref=>[...document.querySelectorAll('.historical-product')].find(n=>n.dataset.sourceRef===ref)?.textContent.includes('Direct collaboration: None')));
  assert.equal(posts,3);assert.equal(f.active('woo:ww:100').length,0);assert.equal(f.active('woo:usd:101').length,0);assert.equal(f.mapping.state.outcomes.length,25);
  await page.locator('#shopify-classification-tab').click();assert.ok(await page.locator('#historical-classification-panel').isHidden());assert.ok(await page.locator('#shopify-classification-panel').isVisible());assert.deepEqual(errors,[]);await page.close();
 }
}
