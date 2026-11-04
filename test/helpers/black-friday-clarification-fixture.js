import {readFileSync} from 'node:fs';
import {blackFridayRoutingFixture,routingPrompts} from './black-friday-routing-fixture.js';
import {createEventTimestampProvider} from '../../oracle/event-timestamp-provider.js';
export const endpointReply=readFileSync(new URL('../fixtures/black-friday-clarification-416/reply.txt',import.meta.url),'utf8').trimEnd();
export const locationEvidence=JSON.parse(readFileSync(new URL('../fixtures/black-friday-clarification-416/square-evidence.json',import.meta.url)));
export const openingQuestion=routingPrompts.short;
export function clarificationFixture({locations=[],failOnline=false}={}){
 const f=blackFridayRoutingFixture(),reads=[],proposals=[];
 const native=createEventTimestampProvider({project:'fixture',run:async(query,params)=>{reads.push({query,params});return locations;}});
 for(const op of ['totals','products']){const original=f.saleProvider[op];f.saleProvider[op]=async w=>{
  if(w.channel==='instore')await native.bind(w);
  if(failOnline&&w.year===2024&&w.channel==='online')throw Object.assign(Error('fixture'),{code:'EVENT_WOO_SOURCE_UNAVAILABLE'});
  return original(w);
 };}
 f.generateProposals=async ({message})=>{proposals.push(message);return [];};
 return {...f,reads,proposals};
}
