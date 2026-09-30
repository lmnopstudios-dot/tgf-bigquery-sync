import test from 'node:test';
import assert from 'node:assert/strict';
import {createBatchedInventoryByLocation} from '../shopify/inventory-by-location.js';

const product=(id,variants,more=false,cursor=null)=>({id:`gid://shopify/Product/${id}`,title:`P${id}`,handle:`p${id}`,status:'ACTIVE',tags:[],variants:{nodes:variants,pageInfo:{hasNextPage:more,endCursor:cursor}}});
const variant=i=>({id:`gid://shopify/ProductVariant/${i}`,title:`V${i}`,sku:`S${i}`,availableForSale:true,inventoryItem:{id:`gid://shopify/InventoryItem/${i}`}});

test('twenty parents are one GraphQL parent call and inventory items are batched',async()=>{
  const parents=Array.from({length:20},(_,i)=>String(i+1));
  const graphql=async(_token,query,vars)=>{
    if(query.includes('OnlineLocation'))return{locations:{nodes:[{id:'L1',name:'Online',isActive:true}],pageInfo:{hasNextPage:false,endCursor:null}}};
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
    if(query.includes('OnlineLocation'))return{locations:{nodes:[{id:'L',name:'Online',isActive:true}],pageInfo:{hasNextPage:false}}};
    if(query.includes('InventoryProducts'))return{nodes:[product('1',first,true,'a')]};
    if(query.includes('InventoryVariants'))return{product:product('1',vars.cursor==='a'?second:third,vars.cursor==='a','b')};
    if(query.includes('InventoryLevels'))return{nodes:vars.ids.map(id=>({id,inventoryLevel:{quantities:[{name:'available',quantity:1}]}}))};
  };
  const result=await createBatchedInventoryByLocation({graphql,getToken:async()=> 't'})(['1']);
  assert.equal(result.products[0].variants.length,205);assert.equal(result.diagnostics.variant_page_calls,2);assert.equal(result.diagnostics.inventory_batch_calls,3);assert.equal(result.diagnostics.network_calls,7);
});

test('waits once for a reported throttle within budget and reports aggregate wait',async()=>{
  let now=1_000,calls=0;const throttle=Object.assign(new Error('throttle'),{errors:[{extensions:{code:'THROTTLED',cost:{windowResetAt:new Date(1_100).toISOString()}}}]});
  const graphql=async(_token,query,vars)=>{if(query.includes('OnlineLocation')&&calls++===0)throw throttle;if(query.includes('OnlineLocation'))return{locations:{nodes:[{id:'L',name:'Online',isActive:true}],pageInfo:{hasNextPage:false}}};if(query.includes('InventoryProducts'))return{nodes:[product('1',[variant(1)])]};return{nodes:[{id:vars.ids[0],inventoryLevel:{quantities:[{name:'available',quantity:2}]}}]};};
  const result=await createBatchedInventoryByLocation({graphql,getToken:async()=> 't',now:()=>now,sleep:async ms=>{now+=ms;}})(['1'],{deadlineAt:10_000});
  assert.equal(result.diagnostics.throttle_waits,1);assert.equal(result.diagnostics.throttle_wait_ms,450);assert.equal(result.diagnostics.network_calls,4);
});
