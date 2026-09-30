import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatchedInventoryByLocation,inventoryLocationSelector,inventoryLocationSelectorForRequest,listAndResolveInventoryLocations,resolveInventoryLocation} from '../shopify/inventory-by-location.js';

const product=(id,variants,more=false,cursor=null)=>({id:`gid://shopify/Product/${id}`,title:`P${id}`,handle:`p${id}`,status:'ACTIVE',tags:[],variants:{nodes:variants,pageInfo:{hasNextPage:more,endCursor:cursor}}});
const variant=i=>({id:`gid://shopify/ProductVariant/${i}`,title:`V${i}`,sku:`S${i}`,availableForSale:true,inventoryItem:{id:`gid://shopify/InventoryItem/${i}`}});

test('twenty parents are one GraphQL parent call and inventory items are batched',async()=>{
  const parents=Array.from({length:20},(_,i)=>String(i+1));
  const graphql=async(_token,query,vars)=>{
    if(query.includes('InventoryLocations'))return{locations:{nodes:[{id:'L1',name:'Online',isActive:true,fulfillsOnlineOrders:true}],pageInfo:{hasNextPage:false,endCursor:null}}};
    if(query.includes('InventoryProducts'))return{nodes:vars.ids.map((_,i)=>product(i+1,[variant(i+1)]))};
    if(query.includes('InventoryLevels'))return{nodes:vars.ids.map((id,i)=>({id,inventoryLevel:{quantities:[{name:'available',quantity:i+1}]}}))};
    throw new Error('unexpected query');
  };
  const result=await createBatchedInventoryByLocation({graphql,getToken:async()=> 'token'})(parents);
  assert.equal(result.complete,true);assert.equal(result.diagnostics.parent_batch_calls,1);assert.equal(result.diagnostics.inventory_batch_calls,1);assert.equal(result.diagnostics.network_calls,3);assert.equal(result.products[19].variants[0].locations[0].available,20);
});

test('paginates every variant and batches inventory for large products',async()=>{
  const first=Array.from({length:100},(_,i)=>variant(i+1)),second=Array.from({length:100},(_,i)=>variant(i+101)),third=Array.from({length:5},(_,i)=>variant(i+201));
  const graphql=async(_token,query,vars)=>{
    if(query.includes('InventoryLocations'))return{locations:{nodes:[{id:'L',name:'Online',isActive:true,fulfillsOnlineOrders:true}],pageInfo:{hasNextPage:false}}};
    if(query.includes('InventoryProducts'))return{nodes:[product('1',first,true,'a')]};
    if(query.includes('InventoryVariants'))return{product:product('1',vars.cursor==='a'?second:third,vars.cursor==='a','b')};
    if(query.includes('InventoryLevels'))return{nodes:vars.ids.map(id=>({id,inventoryLevel:{quantities:[{name:'available',quantity:1}]}}))};
  };
  const result=await createBatchedInventoryByLocation({graphql,getToken:async()=> 't'})(['1']);
  assert.equal(result.products[0].variants.length,205);assert.equal(result.diagnostics.variant_page_calls,2);assert.equal(result.diagnostics.inventory_batch_calls,3);assert.equal(result.diagnostics.network_calls,7);
});

test('waits once for a reported throttle within budget and reports aggregate wait',async()=>{
  let now=1_000,calls=0;const throttle=Object.assign(new Error('throttle'),{errors:[{extensions:{code:'THROTTLED',cost:{windowResetAt:new Date(1_100).toISOString()}}}]});
  const graphql=async(_token,query,vars)=>{if(query.includes('InventoryLocations')&&calls++===0)throw throttle;if(query.includes('InventoryLocations'))return{locations:{nodes:[{id:'L',name:'Online',isActive:true,fulfillsOnlineOrders:true}],pageInfo:{hasNextPage:false}}};if(query.includes('InventoryProducts'))return{nodes:[product('1',[variant(1)])]};return{nodes:[{id:vars.ids[0],inventoryLevel:{quantities:[{name:'available',quantity:2}]}}]};};
  const result=await createBatchedInventoryByLocation({graphql,getToken:async()=> 't',now:()=>now,sleep:async ms=>{now+=ms;}})(['1'],{deadlineAt:10_000});
  assert.equal(result.diagnostics.throttle_waits,1);assert.equal(result.diagnostics.throttle_wait_ms,450);assert.equal(result.diagnostics.network_calls,4);
});

test('stable configured location ID wins without guessing from names',()=>{
  const selector=inventoryLocationSelector({SHOPIFY_LOCATION_ID:'42',SHOPIFY_INVENTORY_LOCATION_NAME:'Online'});
  assert.deepEqual(selector,{type:'id',value:'gid://shopify/Location/42',configured_by:'SHOPIFY_LOCATION_ID'});
  const result=resolveInventoryLocation([
    {id:'gid://shopify/Location/41',name:'Online',isActive:true,fulfillsOnlineOrders:true},
    {id:'gid://shopify/Location/42',name:'Warehouse',isActive:true,fulfillsOnlineOrders:true}
  ],selector);
  assert.equal(result.location.id,'gid://shopify/Location/42');
});

test('durable server path explicitly propagates the preferred configured location ID',async()=>{
  const selector=inventoryLocationSelector({SHOPIFY_INVENTORY_LOCATION_ID:'gid://shopify/Location/105063874887',SHOPIFY_INVENTORY_LOCATION_NAME:'Online'});
  assert.deepEqual(selector,{type:'id',value:'gid://shopify/Location/105063874887',configured_by:'SHOPIFY_INVENTORY_LOCATION_ID'});
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../server.js',import.meta.url),'utf8'));
  assert.match(source,/oracleInventoryLocationSelector=inventoryLocationSelector\(process\.env\)/);
  assert.match(source,/locationSelector:oracleInventoryLocationSelector/);
});

test('Oracle live and historical readers share the configured selector without all-location fallback',async()=>{
  const configured=inventoryLocationSelector({SHOPIFY_INVENTORY_LOCATION_ID:'gid://shopify/Location/105063874887'});
  assert.equal(inventoryLocationSelectorForRequest(null,configured),configured);
  assert.equal(inventoryLocationSelectorForRequest('Online',configured),configured);
  assert.deepEqual(inventoryLocationSelectorForRequest('Soho',configured),{type:'exact_name',value:'Soho',configured_by:'request',eligibility:'active'});
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../server.js',import.meta.url),'utf8'));
  assert.match(source,/getShopifyInventoryPerformance[\s\S]+resolveOracleInventoryLocation\(location\)/);
  assert.match(source,/getShopifyInventoryByLocation[\s\S]+resolveOracleInventoryLocation\(location, token\)/);
  assert.doesNotMatch(source,/normalizedLocation === null/);
});

test('Oracle inventory contract reports the resolved name and preserves MTO evidence',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../server.js',import.meta.url),'utf8'));
  assert.match(source,/resolved_location: \{ id: resolvedLocation\.id, name: resolvedLocation\.name \}/);
  assert.match(source,/inventoryPolicy: variant\.inventoryPolicy/);
  assert.match(source,/ready_to_ship:[\s\S]+made_to_order:/);
});

test('exact-name fallback is case-sensitive and never substitutes a similar location',()=>{
  const selector=inventoryLocationSelector({});
  const result=resolveInventoryLocation([{id:'L1',name:'Online Warehouse',isActive:true,fulfillsOnlineOrders:true},{id:'L2',name:'online',isActive:true,fulfillsOnlineOrders:true}],selector);
  assert.equal(result.location,null);assert.equal(result.reason,'no location has the configured exact name');
});

test('inactive and online-ineligible exact identities are rejected with a reason',()=>{
  const selector={type:'id',value:'L1',configured_by:'test'};
  assert.equal(resolveInventoryLocation([{id:'L1',name:'Online',isActive:false,fulfillsOnlineOrders:true}],selector).reason,'the exact configured location is inactive');
  assert.equal(resolveInventoryLocation([{id:'L1',name:'Online',isActive:true,fulfillsOnlineOrders:false}],selector).reason,'the exact configured location is not eligible to fulfil online orders');
});

test('an explicit active retail location remains readable without being an online fallback',()=>{
  const selector=inventoryLocationSelectorForRequest('Soho',{type:'id',value:'configured-online'});
  const result=resolveInventoryLocation([{id:'retail',name:'Soho',isActive:true,fulfillsOnlineOrders:false}],selector);
  assert.equal(result.location.name,'Soho');
});

test('location diagnostic listing is bounded and contains only location metadata',async()=>{
  let calls=0;const result=await listAndResolveInventoryLocations({selector:{type:'id',value:'missing',configured_by:'test'},maxPages:2,call:async()=>{calls++;return{locations:{nodes:[{id:`L${calls}`,name:`Location ${calls}`,isActive:true,fulfillsOnlineOrders:calls===1}],pageInfo:{hasNextPage:true,endCursor:`c${calls}`}}};}});
  assert.equal(calls,2);assert.equal(result.truncated,true);assert.equal(result.locations.length,2);assert.deepEqual(Object.keys(result.locations[0]),['id','name','isActive','fulfillsOnlineOrders']);assert.match(result.reason,/configured ID/);
});

test('failure exposes selector and safe location evidence before product retrieval',async()=>{
  const logs=[];const load=createBatchedInventoryByLocation({locationSelector:{type:'id',value:'L9',configured_by:'SHOPIFY_LOCATION_ID'},getToken:async()=> 'secret',log:value=>logs.push(value),graphql:async(_token,query)=>{if(query.includes('InventoryLocations'))return{locations:{nodes:[{id:'L1',name:'Not Online',isActive:true,fulfillsOnlineOrders:true}],pageInfo:{hasNextPage:false,endCursor:null}}};throw new Error('product query must not run');}});
  await assert.rejects(load(['1']),error=>error.code==='ONLINE_LOCATION_NOT_FOUND'&&error.diagnostic.selector.value==='L9'&&/no location/.test(error.diagnostic.reason));
  assert.equal(logs.length,1);assert.doesNotMatch(JSON.stringify(logs),/secret/);
});
