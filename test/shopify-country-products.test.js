import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { SHOPIFY_COUNTRY_PRODUCTS_TOOL_DEFINITION, createShopifyCountryProductsService, shopifyCountryProductsSql, validateCountryProductInput } from '../oracle/shopify-country-products.js';
import { parseArguments, validateShopifyCountryProducts } from '../diagnostics/shopify-country-products-production.js';
import { createOracleUiRouter } from '../oracle/ui-router.js';
import { runWithShopifyThrottle } from '../oracle/shopifyql-throttle.js';
import { toolCallSignature } from '../oracle/request-tool-budget.js';

const QUESTION = 'Can you give me the top ten locations for online sales this year along with the top 10 products sold to each one?';
const NOW = Date.parse('2026-09-24T12:00:00Z');
const DANIELLE_STOCK_CLEARANCE = `Danielle has asked us to look at clearing the following stock online:
Large Anatomical Heart Ring, Small Anatomical Heart Ring, and Anatomical Heart Pendant.
Any ideas of what we can do? Use data where possible`;
const DANIELLE_EXACT_FOLLOW_UP = 'What can we do about this? Please include data and sales info where appropriate.';
const DANIELLE_BRIEF = `Danielle has asked us to look at clearing the following stock online:
Large Anatomical Heart Ring, Small Anatomical Heart Ring, and Anatomical Heart Pendant.`;
const DANIELLE_FULL_EMAIL = `Danielle has asked us to look at clearing the following stock online:
Small Signet; Butterfly, Ankh, Eagle and Pig charms; Sun and Moon, Serpent, Dagger, Snake and Dagger, Magic Mushroom and Enchanted Castle pendants; Reaper and Pentagram; gold and silver bat earrings; Solid Heart and Smallest Evil Skull rings; and all three skull-hoop variations.
Any ideas of what we can do? Use data where possible.`;
const DANIELLE_FULL_ITEMS = [
  'Small Signet','Butterfly charm','Ankh charm','Eagle charm','Pig charm',
  'Sun and Moon pendant','Serpent pendant','Dagger pendant','Snake and Dagger pendant',
  'Magic Mushroom pendant','Enchanted Castle pendant','Reaper','Pentagram',
  'Gold bat earrings','Silver bat earrings','Solid Heart ring','Smallest Evil Skull ring',
  'Skull hoop variation 1','Skull hoop variation 2','Skull hoop variation 3'
];

async function oracleConversation({ legacyFirstClarification = false } = {}) {
  const aggregateCalls=[];
  let chatCalls=0;
  const chat=async(_message,{analysisContext})=>{
    chatCalls++;
    if(legacyFirstClarification&&chatCalls===1)return {answer:'What date range would you like? I’ll use GBP unless you specify another currency.',tools:[]};
    assert.equal(analysisContext.tool_route,'get_shopify_online_country_products');
    const args=validateCountryProductInput({start_date:analysisContext.start_date,end_date:analysisContext.end_date,currency:analysisContext.currencies[0]||null});
    aggregateCalls.push(args);
    return {answer:'Separate GBP and USD rankings for 2026 year to date.',tools:['get_shopify_online_country_products']};
  };
  const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012'};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat,generateProposals:async()=>[],env,now:()=>NOW}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
  const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),auth=await login.json();
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const send=async message=>(await fetch(`${base}/chat`,{method:'POST',headers,body:JSON.stringify({message})})).json();
  return {aggregateCalls,send,close:()=>server.close()};
}

test('query ranks ten direct countries and ten country-specific products without multiplying order sales', () => {
  const sql = shopifyCountryProductsSql('p');
  assert.match(sql, /ROW_NUMBER\(\) OVER\(PARTITION BY currency ORDER BY operational_net_sales DESC,country_code\) country_rank/);
  assert.match(sql, /country_rank<=10/);
  assert.match(sql, /ROW_NUMBER\(\) OVER\(PARTITION BY currency,country_code ORDER BY product_sales DESC,source_product_id\) product_rank/);
  assert.match(sql, /rp\.product_rank<=10/);
  assert.match(sql, /country_totals[\s\S]*FROM eligible_orders WHERE country_code IS NOT NULL/);
  assert.match(sql, /product_lines[\s\S]*JOIN top_countries tc USING\(currency,country_code\)/);
  const countrySection=sql.slice(sql.indexOf('country_totals AS'),sql.indexOf('ranked_countries AS'));
  assert.doesNotMatch(countrySection,/order_line_items/);
  assert.match(countrySection,/SUM\(operational_net_sales\)/);
});

test('query preserves governed Online, currency, refund, Matrixify, unknown, and product-grain semantics', () => {
  const sql = shopifyCountryProductsSql('p');
  assert.match(sql, /retail_location_id IS NULL/);
  assert.match(sql, /source_app_id IS NULL OR l\.source_app_id!=@matrixify_app_id/);
  assert.match(sql, /original_total_presentment-COALESCE\(f\.total_refunded_presentment,0\)/);
  assert.match(sql, /discounted_total_presentment/);
  assert.match(sql, /PARTITION BY currency/);
  assert.match(sql, /unknown_country_orders/);
  assert.match(sql, /COALESCE\(NULLIF\(li\.product_id,''\),'unknown'\)/);
  assert.match(sql, /COUNT\(DISTINCT order_id\) product_orders/);
  assert.match(sql, /SUM\(units\) units/);
});

test('service returns explicit semantics and uses bounded, typed BigQuery execution', async () => {
  let job;
  const row = { currency:'GBP',country_rank:1,country_code:'GB',product_rank:1,product_grain_status:'stable_shopify_parent_product' };
  const service = createShopifyCountryProductsService({ bigquery:{ async query(input){ job=input; return [[row]]; } }, project:'p' });
  const result = await service({ start_date:'2026-01-01',end_date:'2026-09-24',currency:null });
  assert.deepEqual(result.rows,[row]);
  assert.equal(job.params.matrixify_app_id,'gid://shopify/App/1758145');
  assert.equal(job.maximumBytesBilled,'10000000000');
  assert.match(result.semantics.unknown,/excluded/);
  assert.match(result.semantics.refunds,/not governed at product allocation grain/);
  assert.match(result.semantics.unresolved_products,/explicit/);
});

test('exact user question is routed to aggregate tool while order-example path remains', () => {
  const prompt = fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  assert.match(QUESTION,/top ten locations[\s\S]*top 10 products/);
  assert.match(prompt,/top locations\/countries for online sales plus top products sold to each/);
  assert.match(prompt,/call get_shopify_online_country_products/);
  assert.match(prompt,/Use search_orders only for bounded order examples/);
  assert.match(SHOPIFY_COUNTRY_PRODUCTS_TOOL_DEFINITION.description,/aggregate path/);
});

test('Oracle single-turn country-product request resolves YTD and calls the aggregate once without a currency filter',async t=>{
  const oracle=await oracleConversation();t.after(oracle.close);
  const response=await oracle.send(QUESTION);
  assert.deepEqual(oracle.aggregateCalls,[{start_date:'2026-01-01',end_date:'2026-09-24',currency:null}]);
  assert.doesNotMatch(response.answer,/what date range/i);
  assert.match(response.answer,/GBP and USD/);
});

test('exact production follow-up resolves retained country-product intent instead of repeating clarification',async t=>{
  const oracle=await oracleConversation({legacyFirstClarification:true});t.after(oracle.close);
  const first=await oracle.send(QUESTION);assert.match(first.answer,/What date range/);
  const second=await oracle.send('this year');
  assert.deepEqual(oracle.aggregateCalls,[{start_date:'2026-01-01',end_date:'2026-09-24',currency:null}]);
  assert.doesNotMatch(second.answer,/what date range|unless you specify/i);
});

test('Danielle stock-clearance brief gets evidence-aware initial advice without a date clarification',async t=>{
  const calls=[];
  const chat=async(_message,{analysisContext})=>{
    assert.equal(analysisContext.request_kind,'advisory');assert.deepEqual(analysisContext.currencies,[]);
    calls.push(
      {name:'search_shopify_products',arguments:{query:'Anatomical Heart',limit:10}},
      {name:'get_shopify_inventory_by_location',arguments:{query:'Anatomical Heart',location:'Online',limit:10}},
      {name:'get_shopify_product_performance',arguments:{start_date:'2026-06-26',end_date:'2026-09-24',limit:10,sort_by:'net_sales'}},
      {name:'get_shopify_inventory_efficiency',arguments:{start_date:'2026-06-26',end_date:'2026-09-24',limit:20,sort_by:'sell_through_rate',sort_direction:'desc'}}
    );
    return {answer:'Start with an online Anatomical Heart edit, product-page cross-links, segmented email and a measured bundle test. Current stock and Made-to-Order status need live catalogue evidence; prioritisation and discount depth need stock efficiency and sales evidence. I used the clearly stated recent 90-day window, 26 June–24 September 2026, and kept currencies separate.',tools:calls.map(call=>call.name)};
  };
  const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012'};
  let proposalCalls=0;
  const knowledgeService={searchKnowledge:async()=>{throw new Error('must not persist brief')},searchMemory:async()=>{throw new Error('must not persist brief')}};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService,bigquery:{},project:'test',chat,generateProposals:async()=>{proposalCalls++;return[]},env,now:()=>NOW}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
  const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),auth=await login.json();
  const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const response=await fetch(`${base}/chat`,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf},body:JSON.stringify({message:DANIELLE_STOCK_CLEARANCE})}),body=await response.json();
  assert.equal(response.status,200);assert.equal(calls.length,4);assert.equal(proposalCalls,1);assert.deepEqual(body.proposals,[]);
  assert.doesNotMatch(body.answer,/what date range/i);assert.match(body.answer,/online Anatomical Heart edit/);assert.match(body.answer,/need live catalogue evidence/);assert.match(body.answer,/kept currencies separate/);
});

test('original full Danielle email reaches the UI with per-item evidence status on the observed slow and throttled path',async t=>{
  const products=DANIELLE_FULL_ITEMS;
  const query=products.map(title=>`title:"${title}"`).join(' OR ');
  const unresolvedCatalogue=new Set(['Pentagram','Skull hoop variation 3']);
  const unresolvedInventory=new Set([...unresolvedCatalogue,'Silver bat earrings']);
  const unresolvedSales=new Set([...unresolvedInventory,'Reaper']);
  const rows=(unresolved,field,value)=>products.filter(title=>!unresolved.has(title)).map((title,index)=>({title,[field]:value(index)}));
  const calls=[],signatures=new Set();
  let active=0,maxActive=0,throttleAttempts=0;
  const tracked=async(name,args,ms,value)=>{
    const signature=toolCallSignature(name,args);
    assert.equal(signatures.has(signature),false,`duplicate lookup: ${signature}`);
    signatures.add(signature);calls.push({name,args});active++;maxActive=Math.max(maxActive,active);
    try{await new Promise(resolve=>setTimeout(resolve,ms));return value}finally{active--}
  };
  const chat=async(message,{analysisContext})=>{
    assert.equal(message,DANIELLE_FULL_EMAIL);
    assert.equal(analysisContext.request_kind,'advisory');
    const [catalogue,inventory]=await Promise.all([
      tracked('search_shopify_products',{query,limit:25},1_200,rows(unresolvedCatalogue,'made_to_order',index=>index%5===0)),
      tracked('get_shopify_inventory_by_location',{query,location:'Online',limit:25},50_500,rows(unresolvedInventory,'available',index=>24-index))
    ]);
    const sales=await runWithShopifyThrottle(async()=>{
      throttleAttempts++;
      if(throttleAttempts===1){const error=new Error('throttled');error.errors=[{extensions:{code:'THROTTLED',cost:{requestedQueryCost:42,currentlyAvailable:5,windowResetAt:new Date(Date.now()+2_000).toISOString()}}}];throw error}
      return tracked('get_shopify_product_performance',{query,start_date:'2026-06-26',end_date:'2026-09-24'},4_500,rows(unresolvedSales,'units_sold',index=>20-index));
    },{deadlineAt:Date.now()+30_000,maxWaitMs:5_000,responseReserveMs:5_000,bufferMs:100});
    const efficiency=await tracked('get_shopify_inventory_efficiency',{query,start_date:'2026-06-26',end_date:'2026-09-24'},3_200,rows(unresolvedSales,'sell_through_rate',index=>.4-index*.01));
    await new Promise(resolve=>setTimeout(resolve,1_500)); // realistic final model synthesis
    const found=(values,title)=>values.some(row=>row.title===title);
    const evidence=products.map(title=>`${title}: catalogue=${found(catalogue,title)?'verified':'unresolved'}, inventory=${found(inventory,title)?'verified':'unresolved'}, sales=${found(sales,title)?'verified':'unresolved'}`).join('\n');
    return {answer:`Complete Danielle stock-clearance analysis.\n${evidence}\nVerified stock and recent sales support a grouped online edit, segmented email, cross-links and measured offer tests. Explicitly unresolved items must be matched manually before publishing.`,tools:calls.map(call=>call.name)};
  };
  const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012'};
  const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat,generateProposals:async()=>[],env,now:()=>NOW}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin;
  const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),auth=await login.json(),cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const started=Date.now(),response=await fetch(`${base}/chat`,{method:'POST',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf,'x-request-id':'danielle-full-email-e2e'},body:JSON.stringify({message:DANIELLE_FULL_EMAIL})}),body=await response.json(),elapsedMs=Date.now()-started;
  assert.equal(response.status,200);assert.equal(body.success,true);assert.equal(body.answer.startsWith('Complete Danielle'),true);
  for(const product of products)assert.match(body.answer,new RegExp(product));
  assert.match(body.answer,/catalogue=verified/);assert.match(body.answer,/inventory=verified/);assert.match(body.answer,/sales=verified/);assert.match(body.answer,/unresolved/);
  assert.equal(signatures.size,4);assert.equal(throttleAttempts,2);assert.equal(maxActive,2);assert.ok(elapsedMs>=60_000&&elapsedMs<80_000);
  console.info('# Danielle full-email E2E:',JSON.stringify({elapsed_ms:elapsedMs,distinct_requested_items:products.length,catalogue:{verified:products.length-unresolvedCatalogue.size,unresolved:[...unresolvedCatalogue]},inventory:{verified:products.length-unresolvedInventory.size,unresolved:[...unresolvedInventory]},sales:{verified:products.length-unresolvedSales.size,unresolved:[...unresolvedSales]},complete_answer_before_ui_deadline:true,shopify_throttle_attempts:throttleAttempts,max_concurrency:maxActive}));
});

test('exact Danielle wording in a fresh chat remains useful when optional sales evidence is unavailable',async t=>{
  const messages=[];
  const chat=async(message,{analysisContext})=>{messages.push(message);assert.equal(analysisContext.request_kind,'advisory');assert.deepEqual(analysisContext.currencies,[]);return {answer:'Proposed tactics: create a focused online edit, cross-link the products, and test segmented email. Verified evidence: the catalogue should be checked live; optional recent sales evidence was unavailable. Comparison period selected: the most recent 90 days. Currency results will remain separate.',tools:['search_shopify_products']}};
  const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012'};
  let proposalCalls=0;const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat,generateProposals:async()=>{proposalCalls++;return[]},env,now:()=>NOW}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,login=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),auth=await login.json(),cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf};
  const response=await fetch(`${base}/chat`,{method:'POST',headers,body:JSON.stringify({message:`${DANIELLE_BRIEF}\n${DANIELLE_EXACT_FOLLOW_UP}`})}),body=await response.json();
  assert.equal(response.status,200);assert.equal(messages.length,1);assert.equal(proposalCalls,1);assert.deepEqual(body.proposals,[]);
  assert.doesNotMatch(body.answer,/what date range|GBP unless|specify another currency/i);assert.match(body.answer,/Proposed tactics/);assert.match(body.answer,/most recent 90 days/);assert.match(body.answer,/unavailable/);
});

test('exact Danielle follow-up reuses stock-clearance context in an existing chat',async t=>{
  const contexts=[];
  const chat=async(message,{analysisContext})=>{contexts.push({message,analysisContext});return {answer:contexts.length===1?'I have the temporary stock-clearance brief.':'Initial recommendations: build an online edit and test audience segments. Verified sales evidence is optional and currently unavailable. I selected the most recent 90 days and will keep currencies separate.',tools:[]}};
  const env={ORACLE_UI_PASSWORD:'test-password',ORACLE_UI_SESSION_SECRET:'12345678901234567890123456789012'};
  let proposalCalls=0;const app=express();app.use('/api/oracle',createOracleUiRouter({knowledgeService:{},bigquery:{},project:'test',chat,generateProposals:async()=>{proposalCalls++;return[]},env,now:()=>NOW}));
  const server=await new Promise(resolve=>{const value=app.listen(0,()=>resolve(value))});t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}/api/oracle`,origin=new URL(base).origin,login=await fetch(`${base}/auth/login`,{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"password":"test-password"}'}),auth=await login.json(),cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),headers={cookie,origin,'content-type':'application/json','x-csrf-token':auth.csrf},send=message=>fetch(`${base}/chat`,{method:'POST',headers,body:JSON.stringify({message})});
  assert.equal((await send(DANIELLE_BRIEF)).status,200);const response=await send(DANIELLE_EXACT_FOLLOW_UP),body=await response.json();
  assert.equal(response.status,200);assert.equal(contexts[1].analysisContext.request_kind,'advisory');assert.deepEqual(contexts[1].analysisContext.currencies,[]);assert.equal(proposalCalls,2);
  assert.doesNotMatch(body.answer,/what date range|GBP unless|specify another currency/i);assert.match(body.answer,/Initial recommendations/);assert.match(body.answer,/most recent 90 days/);
});

test('production validator is bounded, aggregate-only and reports unknown coverage', async () => {
  const row={currency:'GBP',country_rank:1,country_code:'GB',product_rank:1,eligible_orders:100,unknown_country_orders:4,unknown_order_share:.04,eligible_sales:900,unknown_country_sales:20};
  const report=await validateShopifyCountryProducts({bigquery:{async query(){return [[row]];}},project:'p',input:{start_date:'2026-01-01',end_date:'2026-09-24',currency:null}});
  assert.deepEqual(report.contract,{read_only:true,aggregate_only:true,pii_free:true,maximum_rows:1000});
  assert.equal(report.coverage[0].unknown_country_orders,4);
  assert.deepEqual(parseArguments([],new Date('2026-09-24T12:00:00Z')),{start_date:'2026-01-01',end_date:'2026-09-24',currency:null});
});
