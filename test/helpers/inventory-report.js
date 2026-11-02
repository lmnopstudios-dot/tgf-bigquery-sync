import assert from 'node:assert/strict';
import {createMemoryExportStore} from '../../oracle/product-priority-storage.js';
import {createCurrentStockService} from '../../oracle/current-stock.js';
export const inventoryRequest='Show inventory at every active Shopify location for all products that do not have the `made-to-order` tag.';
const page=(nodes,more=false,cursor='next')=>({nodes,pageInfo:{hasNextPage:more,endCursor:more?cursor:null}});
export function inventoryFixture({failed=false,missing=false}={}){
  const calls=[],store=createMemoryExportStore();
  const graphql=async(token,q,a,signal)=>{calls.push({q,a});assert.ok(signal instanceof AbortSignal);assert.equal(token,'token');assert.doesNotMatch(q,/mutation|title:/);
    if(q.includes('InventoryCatalogue'))return {products:page(a.cursor?[{id:'excluded',title:'Ordinary title',status:'ACTIVE',tags:['made-to-order']},{id:'archived',title:'Archived',status:'ARCHIVED',tags:[]}]:Array.from({length:26},(_,i)=>({id:`p${i}`,title:i===0?'Made-to-order in title only':`P${i}`,status:i%2?'DRAFT':'ACTIVE',tags:['ready-to-ship']})),!a.cursor)};
    if(q.includes('InventoryReportLocations'))return{locations:page(a.cursor?[{id:'inactive',name:'Closed',isActive:false},{id:'l11',name:'Same name',isActive:true}]:Array.from({length:11},(_,i)=>({id:`l${i}`,name:i===0?'Same name':`L${i}`,isActive:true})),!a.cursor)};
    if(q.includes('InventoryReportVariants'))return{product:{variants:page([{id:`v${a.id}${a.cursor?'b':'a'}`,title:'Size',sku:'sku',selectedOptions:[{name:'Size',value:'L'}],inventoryItem:{id:`i${a.id}${a.cursor?'b':'a'}`,tracked:a.id!=='p1'}}],!a.cursor&&a.id==='p0')}};
    if(q.includes('InventoryReportLevels')){
      if(failed&&a.location==='l1')throw Object.assign(new Error('secret'),{code:'ACCESS_DENIED'});
      return{nodes:a.ids.filter(id=>!missing||id!=='ip0a').map(id=>({id,inventoryLevel:a.location==='l2'?null:{quantities:[{name:'available',quantity:a.location==='l0'?0:-2},{name:'on_hand',quantity:3},{name:'committed',quantity:5}]}}))};
    }
    assert.fail(q);
  };
  const deps={graphql,getToken:async()=> 'token',artifactStore:store};return{calls,store,deps,service:createCurrentStockService(deps)};
}
