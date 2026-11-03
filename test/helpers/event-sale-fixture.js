import {createHistoricalEventDependencies} from '../../oracle/historical-event-provider.js';
import {createOracleBaselineDispatcher} from '../../oracle/baseline-dispatcher.js';
import {createMemoryExportStore} from '../../oracle/product-priority-storage.js';
export const eventItems=[
 {id:'ev_2523cea3-5058-481e-9ac0-f6d4520603d6',title:'Black Friday VIP 2025',effective_from:'2025-11-27',effective_to:'2025-11-27'},
 {id:'ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd',title:'Black Friday Public 2025',effective_from:'2025-11-28',effective_to:'2025-11-30'},
 {id:'ev_d62be9ed-527e-403a-a661-cb2d11095ca5',title:'Online Black Friday Sale 2024',effective_from:'2024-11-08',effective_to:'2024-11-10'},
 // Synthetic channel dates establish separation; not claimed as live knowledge.
 {id:'fixture-store-2025',title:'In-store Black Friday 2025',effective_from:'2025-11-28',effective_to:'2025-11-29'},
 {id:'fixture-store-2024',title:'In-store Black Friday 2024',effective_from:'2024-11-07',effective_to:'2024-11-09'}
].map(r=>({...r,kind:'event',status:'confirmed',timezone:'Europe/London',date_precision:'day',source_type:'fixture',source_reference:'fixture://event/'+r.id,recorded_at:'2026-01-01T12:00:00Z'}));
export function eventSaleFixture({items=eventItems,failProducts=false,failTotals=false,failKnowledge=false}={}){
 const calls=[];
 const knowledgeService={searchKnowledge:async args=>{calls.push({provider:'knowledge',args});if(failKnowledge)throw Error('private');return{items};}};
 const saleProvider={
  totals:async w=>{calls.push({provider:'finance',args:w});if(failTotals)throw Object.assign(Error('private body'),{code:'EVENT_FINANCE_FAILED'});return {period:w,definition:'canonical_net_gross',coverage:{complete:true},rows:[{source:w.channel==='online'?'Woo':'Square',channel:w.channel==='online'?'Online':'In-store',currency:'GBP',transaction_type:'sale',amount:w.year===2025?200:100},{source:w.channel==='online'?'Woo':'Square',channel:w.channel==='online'?'Online':'In-store',currency:'GBP',transaction_type:'refund',amount:-10,refund_events:1}]};},
  products:async w=>{calls.push({provider:'products',args:w});if(failProducts)throw Object.assign(Error('private body'),{code:'EVENT_PRODUCTS_FAILED'});return {period:w,definition:'source_native_product_line_sales',coverage:{complete:false},mapping_status:'available',components:[],limitations:['Product refund measures unavailable.'],rows:[{namespace:'woo:ww',channel:w.channel,currency:'GBP',product_ref:'approved:family-a',title:'Ring A',units:3,sales:120},{namespace:'woo:ww',channel:w.channel,currency:'GBP',product_ref:'source:woo:ww:2',title:'Ring B (unmapped)',units:1,sales:20}]};}
 };
 const deps=createHistoricalEventDependencies({bigquery:{query:async()=>{throw Error('Unexpected legacy query');}},project:'fixture',knowledgeService,saleProvider,now:()=>new Date('2026-11-03T12:00:00Z')});
 return {calls,knowledgeService,saleProvider,exportStore:createMemoryExportStore(),baseline:createOracleBaselineDispatcher({historicalEventComparison:deps.historicalEventComparison})};
}
