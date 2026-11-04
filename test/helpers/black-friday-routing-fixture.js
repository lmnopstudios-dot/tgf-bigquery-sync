import {readFileSync} from 'node:fs';
import {eventSaleFixture} from './event-sale-fixture.js';
import {createOracleBaselineDispatcher} from '../../oracle/baseline-dispatcher.js';
import {createProductPriorityService} from '../../oracle/product-priority.js';
export const routingPrompts=Object.fromEntries(['long','short'].map(name=>[name,readFileSync(new URL(`../fixtures/black-friday-routing-415/${name}.txt`,import.meta.url),'utf8').trimEnd()]));
export function blackFridayRoutingFixture(options={}){
 const raw=JSON.parse(readFileSync(new URL('../fixtures/black-friday-conversation/live-knowledge.json',import.meta.url))),items=raw.map(r=>({...r,id:r.event_id,kind:'event',content:r.description,effective_from:r.start_date,effective_to:r.end_date}));
 const f=eventSaleFixture({...options,items}),attempts=[],stages=[];
 const catalogue=async()=>{attempts.push('catalogue_read');throw Error('Current catalogue must not be read');};
 const product=createProductPriorityService({graphql:catalogue,loadSources:catalogue,artifactStore:f.exportStore});
 const historical=f.baseline;
 f.baseline=createOracleBaselineDispatcher({productPriorityExport:async(...args)=>{attempts.push('export_product_priorities');return product(...args);},historicalEventComparison:async(message,options)=>{
  attempts.push('compare_historical_events');const forward=options.onProviderStage;
  return historical(message,{...options,onProviderStage:event=>{stages.push(event);forward?.(event);}});
 }});
 return {...f,attempts,stages};
}
