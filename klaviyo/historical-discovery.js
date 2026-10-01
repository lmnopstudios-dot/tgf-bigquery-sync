#!/usr/bin/env node
import {createKlaviyoClient,redactKlaviyo} from './client.js';
import {metricCatalogue,reportBody} from './discovery.js';
import {monthWindow,monthsBetween,nextMonth} from './months.js';

const option=(args,name,fallback)=>args.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const sourceDate=item=>item?.attributes?.send_time||item?.attributes?.scheduled_at||item?.attributes?.created||item?.attributes?.updated||null;
export async function discoverHistory({client,timezone,currency,args=[]}){
  if(timezone!=='Europe/London')throw new Error('Historical month discovery requires the reviewed Europe/London account timezone');
  const from=option(args,'from'),through=option(args,'through'),maxMonths=Number(option(args,'max-months','6'));
  if(!from||!through)throw new Error('--from and --through are required; account usage start must not be guessed');
  if(!Number.isInteger(maxMonths)||maxMonths<1||maxMonths>12)throw new Error('--max-months must be between 1 and 12');
  const [metrics,campaigns,flows]=await Promise.all([client.paginate('/api/metrics',{maxPages:8}),client.paginate("/api/campaigns?filter=equals(messages.channel,'email')&page[size]=100",{maxPages:8}),client.paginate('/api/flows',{maxPages:8})]);
  const dated=[...campaigns.data.map(x=>({kind:'campaign',id:x.id,date:sourceDate(x)})),...flows.data.map(x=>({kind:'flow',id:x.id,date:sourceDate(x)}))].filter(x=>x.date).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const catalogue=metricCatalogue(metrics.data),months=monthsBetween(from,through,maxMonths),evidence=[];
  for(const month of months)for(const metric of catalogue)for(const kind of ['campaign','flow']){try{const response=await client.request(`/api/${kind}-values-reports`,{method:'POST',body:reportBody(kind,metric.metric_id,{timezone,...monthWindow(month)})});evidence.push({month,kind,metric_id:metric.metric_id,integration:metric.integration,status:'accessible',row_count:response?.data?.attributes?.results?.length??0});}catch(error){evidence.push({month,kind,metric_id:metric.metric_id,integration:metric.integration,status:['CALL_BOUND','PAGINATION_BOUND'].includes(error.code)?'bound_reached':'unsupported_or_failed',http_status:error.status||null,code:error.code||error.name});}}
  const next=months.length&&nextMonth(months.at(-1))<=through?nextMonth(months.at(-1)):null;
  return {read_only:true,account_usage_start:null,account_usage_start_status:'not established by these endpoints; do not infer it from the oldest returned object',earliest_accessible_dated_metadata:dated[0]||null,successfully_collected_coverage:'not changed by discovery; inspect window_coverage',metrics:catalogue,evidence,retention_and_access_limitations:['Listing pagination and API calls are bounded; the oldest returned item is only the earliest accessible evidence, not account start.','An accessible zero-row report is probe evidence, not persisted zero activity.','Failures/unsupported windows are not zeros. API retention may differ by endpoint and revision.','Current attribution settings are not asserted to have applied to historical windows.','Metric IDs are integration-specific; Shopify Xp9amv is never substituted for a historical WooCommerce metric.'],resume_command:next?`npm run discover:klaviyo-history -- --from=${next} --through=${through} --max-months=${maxMonths}`:null,currency};
}
export async function main({env=process.env,args=process.argv.slice(2),write=console.log}={}){const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:Number(env.KLAVIYO_MAX_API_CALLS||80),timeoutMs:Number(env.KLAVIYO_TIMEOUT_MS||15000)}),result=await discoverHistory({client,timezone:env.KLAVIYO_ACCOUNT_TIMEZONE,currency:env.KLAVIYO_ACCOUNT_CURRENCY,args});write(JSON.stringify(result,null,2));return result;}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',code:error.code||error.name,message:redactKlaviyo(error.message)}));process.exitCode=1;});
