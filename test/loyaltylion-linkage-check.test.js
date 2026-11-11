import test from 'node:test';
import assert from 'node:assert/strict';
import {sampleLinks} from '../diagnostics/loyaltylion-linkage-check.mjs';
test('exact merchant IDs only; basic activities do not establish order linkage; safe integers',()=>{
 const r=sampleLinks([{merchant_id:'123'},{merchant_id:'123'},{merchant_id:'customer-email'},{merchant_id:9007199254740992}],
   [{activity:{merchant_id:'ignored'}},{activity:{order:{merchant_id:'456'}}},{activity:{order:{merchant_id:'bad'}}}]);
 assert.deepEqual(r,{customerIds:['gid://shopify/Customer/123'],orderIds:['gid://shopify/Order/456'],invalidCustomers:2,invalidOrders:1});
});
