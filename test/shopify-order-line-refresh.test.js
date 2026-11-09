import test from 'node:test';
import assert from 'node:assert/strict';
import {collectOrderLines,promotionSql,coverageSql} from '../shopify/order-line-refresh.js';

const start='2026-11-05T00:00:00.000Z',end='2026-11-09T00:00:00.000Z';
const at='2026-11-05T10:00:00.000Z';
const set=amount=>({shopMoney:{amount,currencyCode:'GBP'},presentmentMoney:{amount,currencyCode:'GBP'}});
const item=n=>({id:'gid://shopify/LineItem/'+n,quantity:1,currentQuantity:1,
  originalUnitPriceSet:set('10'),originalTotalSet:set('10'),discountedTotalSet:set('9'),totalDiscountSet:set('1'),
  taxLines:[{priceSet:set('0.1')},{priceSet:set('0.2')}]});
const conn=(nodes,cursor)=>({nodes,pageInfo:{hasNextPage:!!cursor,endCursor:cursor}});
const order=(id,lineItems)=>({id:'gid://shopify/Order/'+id,createdAt:at,updatedAt:at,lineItems});
const opts={start,end,mode:'backfill',syncedAt:end};
test('exhausts both cursors and serializes tax without binary rounding',async()=>{
  const result=await collectOrderLines({...opts,graphql:async(q,v)=>{
    if(v.id)return {order:{id:v.id,updatedAt:at,lineItems:conn([item(2)])}};
    return {orders:v.cursor?conn([order(2,conn([item(3)]))]):conn([order(1,conn([item(1)],'line-next'))],'order-next')};
  }});
  assert.equal(result.calls,3);
  assert.deepEqual(result.rows.map(r=>r.line_item_id),[1,2,3].map(n=>'gid://shopify/LineItem/'+n));
  assert.equal(result.rows[0].tax_shop,'0.300000000');
});
test('fails closed for cursor loops, collection bounds and changed nested orders',async()=>{
  await assert.rejects(collectOrderLines({...opts,graphql:async()=>({orders:conn([order(1,conn([item(1)],'x'))],'loop')})}),/ORDER_CHANGED/);
  await assert.rejects(collectOrderLines({...opts,maxRows:1,graphql:async()=>({orders:conn([order(1,conn([item(1),item(2)]))])})}),/LINE_ROW_LIMIT/);
  let n=0;
  await assert.rejects(collectOrderLines({...opts,graphql:async()=>({orders:conn([order(++n,conn([item(n)]))],'repeat')})}),/INVALID_CURSOR/);
});
test('scheduled promotion couples watermark to merge; backfill never references it',()=>{
  const scheduled=promotionSql('lines','state',true), backfill=promotionSql('lines','state',false);
  assert.match(scheduled,/INVALID_STAGE[\s\S]*BEGIN TRANSACTION[\s\S]*WATERMARK_CHANGED[\s\S]*MERGE lines[\s\S]*INSERT INTO state[\s\S]*COMMIT TRANSACTION/);
  assert.match(backfill,/t.order_id=s.order_id AND t.line_item_id=s.line_item_id/);
  assert.doesNotMatch(backfill,/watermark|\bstate\b/);
  assert.match(coverageSql('finance','locations'),/LEFT JOIN captured a ON a.order_id=e.order_id/);
});
