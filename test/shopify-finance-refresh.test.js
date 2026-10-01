import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchUpdatedOrders, parseArgs, promotionSql, transform } from '../shopify/finance-refresh.js';

const order=(id,updatedAt,refunds=[])=>({id,name:`#${id}`,createdAt:'2026-01-01T00:00:00Z',updatedAt,app:{id:'native',name:'Online Store'},retailLocation:{id:'loc',name:'London'},totalPriceSet:{shopMoney:{amount:'12',currencyCode:'GBP'},presentmentMoney:{amount:'15',currencyCode:'USD'}},transactions:[{id:'tx-1'}],refunds});
const refund={id:'refund-old-order',createdAt:'2026-09-26T12:00:00Z',totalRefundedSet:{shopMoney:{amount:'2',currencyCode:'GBP'},presentmentMoney:{amount:'2.5',currencyCode:'USD'}},refundLineItems:{nodes:[]},refundShippingLines:{nodes:[]},orderAdjustments:{nodes:[]},transactions:{nodes:[{id:'refund-tx',kind:'REFUND',status:'SUCCESS',amountSet:{shopMoney:{amount:'2'},presentmentMoney:{amount:'2.5'}}}]}};

test('bounded pagination includes an older order updated by a new refund',async()=>{
  const calls=[];const graphql=async(_q,v)=>{calls.push(v);return {orders:calls.length===1?{nodes:[order('old','2026-09-26T13:00:00Z',[refund])],pageInfo:{hasNextPage:true,endCursor:'next'}}:{nodes:[order('new','2026-09-29T00:00:00Z')],pageInfo:{hasNextPage:false,endCursor:null}}}};
  const result=await fetchUpdatedOrders({graphql,start:'2026-09-25T00:00:00.000Z',end:'2026-10-01T00:00:00.000Z'});
  assert.equal(result.pages,2);assert.equal(result.orders[0].createdAt,'2026-01-01T00:00:00Z');assert.match(calls[0].query,/updated_at:>='2026-09-25/);assert.equal(transform(result.orders).refunds[0].refund_id,'refund-old-order');
});

test('incomplete pagination fails rather than promoting a partial result',async()=>{
  await assert.rejects(()=>fetchUpdatedOrders({graphql:async()=>({orders:{nodes:[order('1','2026-09-26T00:00:00Z')],pageInfo:{hasNextPage:true,endCursor:'again'}}}),start:'2026-09-25T00:00:00.000Z',end:'2026-10-01T00:00:00.000Z',maxPages:1}),/incomplete/);
});

test('promotion is atomic, idempotently replaces selected identities, and never truncates history',()=>{
  const sql=promotionSql('p','d',{orders:'so',financials:'sf',refunds:'sr'});
  assert.match(sql,/BEGIN TRANSACTION/);assert.match(sql,/DELETE FROM `p\.d\.order_financials` WHERE order_id IN/);assert.match(sql,/successful_watermark/);assert.doesNotMatch(sql,/TRUNCATE/i);assert.doesNotMatch(sql,/DELETE FROM `p\.d\.order_financials`\s*;/);
});

test('explicit incident window is half-open and scheduled mode needs no dates',()=>{
  const explicit=parseArgs(['--mode','collect','--start','2026-09-25T00:00:00Z','--end','2026-10-01T00:00:00Z']);assert.equal(explicit.end,'2026-10-01T00:00:00.000Z');
  assert.equal(parseArgs(['--mode','scheduled']).mode,'scheduled');
});
