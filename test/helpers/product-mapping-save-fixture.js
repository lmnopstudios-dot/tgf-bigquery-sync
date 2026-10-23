import assert from 'node:assert/strict';
import {createProductMappingService} from '../../oracle/product-mapping.js';

const product=(ref,title)=>{const [source_platform,source_store,source_product_id]=ref.split(':');return {source_product_ref:ref,source_platform,source_store,source_product_id,title,mapping_status:'source_specific',sku:null};};
export function fixture({count=8,onFamilyRead=null,createService=createProductMappingService}={}){
 const sources=Array.from({length:count},(_,i)=>product(`woo:${i%2?'usd':'ww'}:${100+i}`,'Historical listing '+i));
 const parents=[product('shopify:shopify:900','Current design'),product('shopify:shopify:901','Other design')];
 const state={products:[...sources,...parents],mappings:[],families:[],outcomes:[],operations:[],calls:[],familyReads:0,terminalFailures:0,submissionFailure:false};
 const copy=x=>structuredClone(x);
 const bigquery={dataset:()=>({exists:async()=>[true],table:()=>({exists:async()=>[true]})}),query:async q=>{
  // Distinct query completion times model warehouse round trips and preserve
  // the existing receipt ordering contract without altering production clocks.
  await new Promise(resolve=>setTimeout(resolve,1));state.calls.push(q);
  if(q.labels?.operation==='load_products')return [copy(state.products)];
  if(q.query.startsWith('SELECT')){
   if(q.query.includes('product_mapping_operations'))return [copy(state.operations.filter(x=>x.operation_id===q.params.operation_id).sort((a,b)=>a.row_index-b.row_index||a.recorded_at.localeCompare(b.recorded_at)||a.event_id.localeCompare(b.event_id)))];
   if(q.query.includes('product_family_decisions')){state.familyReads++;onFamilyRead?.(state);return [copy(state.families)];}
   if(q.query.includes('product_mapping_review_outcomes'))return [copy(state.outcomes)];
   if(q.query.includes('product_mapping_decisions'))return [copy(state.mappings)];
  }
  if(q.query.startsWith('MERGE')){
   const payload=JSON.parse(q.params.payload),rows=Array.isArray(payload)?payload:[payload];
   if(q.query.includes('product_mapping_operations')){
    if(state.submissionFailure&&rows.some(x=>x.status==='submitted'))throw Error('Submission receipt unavailable');
    if(state.terminalFailures&&rows.some(x=>x.status!=='submitted')){state.terminalFailures--;throw Error('Terminal receipt unavailable');}
    for(const row of rows)if(!state.operations.some(x=>x.event_id===row.event_id))state.operations.push(copy(row));
   }else{
    const target=q.query.includes('product_family_decisions')?state.families:q.query.includes('product_mapping_review_outcomes')?state.outcomes:state.mappings;
    for(const row of rows)if(!target.some(x=>x.event_id===row.event_id))target.push(copy(row));
   }
   return [[]];
  }
  throw Error('Unexpected test warehouse statement');
 }};
 const service=createService({project:'fixture',bigquery});
 const request=(i,action='family')=>({request_id:'row-'+i,action,source_ref:sources[i].source_product_ref,shopify_parent_ref:parents[0].source_product_ref});
 return {state,service,request,sources,parents};
}

