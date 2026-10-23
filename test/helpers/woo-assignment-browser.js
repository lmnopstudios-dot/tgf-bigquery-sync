import assert from 'node:assert/strict';
export async function verifyWooAssignmentPanel({browser,origin,output}){
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),writes=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',async d=>{assert.match(d.message(),/Save 2 reporting-family assignments/);assert.match(d.message(),/woo:ww:11737/);assert.match(d.message(),/woo:usd:106660/);await d.accept();});
  const product=(ref,title)=>{const [source_platform,source_store,source_product_id]=ref.split(':');return{source_platform,source_store,source_product_id,source_product_ref:ref,title,mapping_status:'resolved',line_items:12};};
  const target=product('shopify:shopify:10434361590087',"Iron Maiden 'Powerslave Eddie' Ring");
  const products=[product('woo:ww:11737','Powerslave Eddie — old WW listing'),product('woo:usd:106660','Powerslave Eddie — old USD listing'),product('square:square:never','Not a Woo product')];
  let pendingReads=0;
  await page.route('**/api/oracle/product-mappings**',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.method()==='POST'){
    assert.equal(url.pathname,'/api/oracle/product-mappings/bulk-review');const body=req.postDataJSON();writes.push(body);
    assert.equal(body.decisions.length,2);assert.deepEqual(body.decisions.map(x=>x.source_ref),['woo:ww:11737','woo:usd:106660']);assert.ok(body.decisions.every(x=>x.action==='family'&&x.shopify_parent_ref===target.source_product_ref));
    return route.fulfill({status:207,json:{operation_id:body.operation_id,status:'complete',succeeded:1,blocked:1,failed:0,pending:0,results:body.decisions.map((x,index)=>({index,source_ref:x.source_ref,status:index?'blocked':'saved',...(index?{error:'Current family changed; inspect history'}:{})}))}});
   }
   if(url.pathname.includes('/bulk-review/')){pendingReads++;return route.fulfill({json:{operation_id:url.pathname.split('/').at(-1),status:'complete',succeeded:1,blocked:0,failed:0,pending:0,results:[{index:0,source_ref:'woo:ww:11737',status:'already_applied'}]}});}
   if(url.pathname.endsWith('/search')){assert.equal(url.searchParams.get('sources'),'shopify');return route.fulfill({json:{items:[target,product('square:square:wrong','Wrong source'),product('shopify:shopify:gid://shopify/ProductVariant/1','Wrong variant')]}});}
   if(url.pathname.endsWith('/choice-preview')){assert.ok(['woo:ww:11737','woo:usd:106660'].includes(url.searchParams.get('source_ref')));return route.fulfill({json:{selected_product:target,family_preview:{allowed:true},identity_preview:{allowed:false,reason:'Identity conflict — family may remain distinct'}}});}
   const woo=url.searchParams.get('view')==='woo_assignment';if(woo)assert.ok(['unassigned','automatic_matches'].includes(url.searchParams.get('assignment_status')));
   const items=woo?products.map((p,i)=>({historical_product:p,resolution_status:'needs_review',shopify_suggestions:[],candidate:{candidate_id:'a'.repeat(24)},...(url.searchParams.get('assignment_status')==='automatic_matches'?{automatic_shopify_match:{source_product_ref:target.source_product_ref,mapping_method:'exact_unique_sku'}}:{})})):[];
   return route.fulfill({json:{items,summary:'Fixture mapping queue',coverage:{by_source:{}},pagination:{page:1,total_pages:1,total_items:items.length,page_size:25}}});
  });
  await page.goto(origin+'/oracle/');await page.locator('#password').fill('fixture');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('[data-view="product-mappings"]').click();await page.locator('#woo-assignment-tab').click();await page.locator('.woo-assignment-row').first().waitFor();
  assert.equal(await page.locator('.woo-assignment-row').count(),2);assert.doesNotMatch(await page.locator('#woo-products').innerText(),/square:square/);assert.match(await page.locator('#woo-products').innerText(),/Title\/SKU suggestion only/);
  assert.equal(await page.locator('#woo-status').inputValue(),'unassigned');
  await page.locator('#woo-status').selectOption('automatic_matches');await page.waitForFunction(()=>document.querySelector('#woo-products').textContent.includes('Automatic Shopify match — review and save to approve'));
  await page.locator('#woo-status').selectOption('unassigned');await page.waitForFunction(()=>document.querySelector('#woo-products').textContent.includes('Title/SKU suggestion only'));
  await page.getByLabel('Select unassigned products on this page').check();assert.equal(await page.locator('#woo-selection-count').innerText(),'2 selected');
  await page.locator('#woo-shared-target').click();await page.locator('#woo-target-query').fill('Powerslave');await page.locator('#woo-target-form button[type="submit"]').click();await page.locator('#woo-target-results button').first().waitFor();assert.equal(await page.locator('#woo-target-results button').count(),1);await page.locator('#woo-target-results button').first().click();
  await page.waitForFunction(()=>!document.querySelector('#woo-save').disabled);
  await page.locator('#woo-action').selectOption('identity');assert.ok(await page.locator('#woo-save').isDisabled());assert.match(await page.locator('#woo-products').innerText(),/Identity conflict/);
  await page.locator('#woo-action').selectOption('family');await page.locator('#woo-save').click();await page.waitForFunction(()=>document.querySelector('#woo-batch-status').textContent.includes('1 saved/already applied'));
  assert.equal(writes.length,1);assert.match(await page.locator('#woo-batch-status').innerText(),/1 blocked/);assert.match(await page.locator('#woo-batch-status').innerText(),/woo:usd:106660/);
  assert.equal(await page.locator('.woo-assignment-row[data-source-ref="woo:ww:11737"]').count(),0);
  assert.ok(await page.getByLabel('Select woo:usd:106660',{exact:true}).isEnabled());
  assert.ok(await page.getByLabel('Shopify target for woo:usd:106660',{exact:true}).isEnabled());
  await page.screenshot({path:output+'/woo-bulk-assignment-'+width+'.png',fullPage:true});
  assert.ok(await page.locator('#woo-products').evaluate(n=>n.scrollWidth<=n.clientWidth+1),'Woo product cards fit narrow viewports');
  // Recovery reads the same operation after browser refresh; it never posts again.
  await page.evaluate(()=>localStorage.setItem('oracle-woo-assignment-batch-v1',JSON.stringify({operation_id:'fixture-pending',decisions:[{source_ref:'woo:ww:11737',request_id:'stable',action:'family',shopify_parent_ref:'shopify:shopify:10434361590087'}]})));
  await page.reload();await page.locator('#app').waitFor({state:'visible'});await page.locator('[data-view="product-mappings"]').click();await page.locator('#woo-assignment-tab').click();await page.waitForFunction(()=>document.querySelector('#woo-batch-status').textContent.includes('already applied'));
  assert.equal(pendingReads,1);assert.equal(writes.length,1);assert.deepEqual(errors,[]);await page.close();
 }
}
