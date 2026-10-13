/** Aggregate-only read diagnostic. Imports no collector, server or inventory API. */
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { createOrderValueProvider, ORDER_VALUE_DEFINITIONS } from '../oracle/order-value-provider.js';
import { numericDistribution } from '../oracle/numeric-distribution.js';

export function validateOrderValueDiagnostic(input){
  if(Object.keys(input).some(k=>!['start','end'].includes(k)))throw Error('Only --start and --end read bounds are permitted');
  for(const d of [input.start,input.end])if(!/^\d{4}-\d{2}-\d{2}$/.test(d||'')||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)throw Error('Valid start/end required');
  const days=(Date.parse(input.end)-Date.parse(input.start))/86400000+1;if(days<1||days>366)throw Error('Read bound: 1–366 days');
  return input;
}
export async function diagnoseOrderValues(input,{bigquery,project}){
  validateOrderValueDiagnostic(input);
  const location=await datasetLocation(bigquery,project,'shopify_data');
  const [schemas]=await bigquery.query({query:`SELECT table_name,column_name,data_type,is_nullable FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN ('order_locations','order_financials','order_customers','order_shipping_geography') ORDER BY table_name,ordinal_position LIMIT 200`,location,maximumBytesBilled:'10000000',jobTimeoutMs:30000,useLegacySql:false});
  const data=await createOrderValueProvider({bigquery,project})({start_date:input.start,end_date:input.end,platform:'shopify',source_store:null,channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal',assumed_charge:8});
  const summary=numericDistribution(data.rows,{});
  return {read_only:true,aggregate_only:true,location,period:{start_date:input.start,end_date:input.end},schemas,coverage:data.coverage,definitions:ORDER_VALUE_DEFINITIONS,shipping_rule_basis:'unverified; observed subtotal alternative explicitly named',...summary,gaps:undefined,live_acceptance:'Only these executed stored-evidence reads; no complete collection or shipping-rule validation implied'};
}
async function main(){const input={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!key?.startsWith('--')||!process.argv[i+1])throw Error('Use --start YYYY-MM-DD --end YYYY-MM-DD');input[key.slice(2)]=process.argv[i+1];}validateOrderValueDiagnostic(input);console.log(JSON.stringify(await diagnoseOrderValues(input,createBigQueryClient()),null,2));}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({status:'failed',code:error.code||'READ_UNAVAILABLE',reason:/domain forbidden|egress/i.test(String(error.message))?'EGRESS_FORBIDDEN':null,message:'Bounded order-value read failed. Check configured BigQuery credentials, access and dataset schemas; no writes were attempted.'}));process.exitCode=1;});
