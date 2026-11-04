import {readFileSync} from 'node:fs';
import {createHistoricalEventDependencies} from '../../oracle/historical-event-provider.js';
import {createOracleBaselineDispatcher} from '../../oracle/baseline-dispatcher.js';
import {createProductPriorityService} from '../../oracle/product-priority.js';
import {createMemoryExportStore} from '../../oracle/product-priority-storage.js';
export const bankPrompt=readFileSync(new URL('../fixtures/bank-holiday-9e60ad05/request.txt',import.meta.url),'utf8').trimEnd();
export const bankKnowledge=JSON.parse(readFileSync(new URL('../fixtures/bank-holiday-9e60ad05/knowledge.json',import.meta.url)));
export function bankHolidayFixture({items=bankKnowledge,fail=null}={}){
 const calls=[],queries=[],attempts=[],proposals=[],stages=[],exportStore=createMemoryExportStore();
 const knowledgeService={searchKnowledge:async q=>{calls.push({knowledge:q});if(fail==='knowledge')throw Error('fixture');return {items};}};
 const bigquery={dataset:()=>({getMetadata:async()=>[{location:'US'}]}),query:async q=>{
  queries.push(q);if(q.query.includes('governed_active'))return [[]];
  if(q.query.includes('SELECT DISTINCT retail_location_id'))return [[{retail_location_id:'gid://shopify/Location/POS-A',retail_location_name:'Soho'},{retail_location_id:'gid://shopify/Location/POS-B',retail_location_name:'East'}]];
  const channel=q.params?.sale_channel;
  calls.push({channel,kind:q.query.includes(' namespace')?'products':q.query.includes("'refund' transaction_type")?'refunds':'sales',params:q.params});
  if(fail===channel||fail==='refunds'&&q.query.includes("'refund' transaction_type")||fail==='products'&&q.query.includes(' namespace'))throw Error('fixture unavailable');
  if(q.query.includes(' namespace'))return [Array.from({length:24},(_,i)=>['GBP','USD'].map(currency=>({namespace:'shopify:shopify',product_id:String(i),title:'Fixture product '+i,currency,channel,units:25-i,sales:240-i*10,line_count:1,missing_sales:0,missing_units:0}))).flat()];
  const refund=q.query.includes("'refund' transaction_type");return [[{source:channel==='online'?'Shopify Online Store':channel==='instore'?'Shopify POS':'Shopify Unknown',channel,currency:'GBP',transaction_type:refund?'refund':'sale',amount:refund?-10:100,transaction_count:2,refund_events:refund?1:null,missing_amounts:0}]];
 }};
 const deps=createHistoricalEventDependencies({bigquery,project:'fixture',knowledgeService,now:()=>new Date('2026-11-04T12:00:00Z')});
 const product=createProductPriorityService({graphql:async()=>{throw Error('Catalogue must not be read');},loadSources:async()=>{throw Error('Catalogue must not be read');},artifactStore:exportStore});
 const baseline=createOracleBaselineDispatcher({productPriorityExport:async(...a)=>{attempts.push('current-product');return product(...a);},generalAnalytics:async()=>{attempts.push('generic');return null;},historicalEventComparison:async(m,o)=>{attempts.push('sale-window');return deps.historicalEventComparison(m,{...o,onProviderStage:s=>{stages.push(s);o.onProviderStage?.(s);}});}});
 return {baseline,calls,queries,attempts,stages,knowledgeService,exportStore,generateProposals:async ({message})=>{proposals.push(message);return [];},proposals};
}
