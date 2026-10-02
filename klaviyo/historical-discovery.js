#!/usr/bin/env node
import {createKlaviyoClient,redactKlaviyo} from './client.js';
import {metricCatalogue,parseMetricIds,reportBody} from './discovery.js';
import {monthWindow,monthsBetween,nextMonth} from './months.js';

const DEFAULT_METRIC_ID='Xp9amv';
const REPORT_KINDS=['campaign','flow'];
const option=(args,name,fallback)=>args.find(x=>x.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const sourceDate=item=>item?.attributes?.send_time||item?.attributes?.scheduled_at||item?.attributes?.created||item?.attributes?.updated||null;
const completed=status=>status==='successful'||status==='zero_rows';
const taskKey=task=>`${task.month}/${task.metric_id}/${task.kind}`;

function resumeCommand({from,through,maxMonths,metricIds,task,next}){
  if(!task&&!next)return null;
  const start=task?.month||next;
  const parts=[`npm run discover:klaviyo-history -- --from=${start}`,`--through=${through}`,`--max-months=${maxMonths}`,`--metric-ids=${metricIds.join(',')}`];
  if(task)parts.push(`--resume-month=${task.month}`,`--resume-metric-id=${task.metric_id}`,`--resume-report-kind=${task.kind}`);
  return parts.join(' ');
}

export async function discoverHistory({client,timezone,currency,args=[]}){
  if(timezone!=='Europe/London')throw new Error('Historical month discovery requires the reviewed Europe/London account timezone');
  const from=option(args,'from'),through=option(args,'through'),maxMonths=Number(option(args,'max-months','6'));
  const metricIds=parseMetricIds(option(args,'metric-ids',DEFAULT_METRIC_ID));
  if(!from||!through)throw new Error('--from and --through are required; account usage start must not be guessed');
  if(!Number.isInteger(maxMonths)||maxMonths<1||maxMonths>12)throw new Error('--max-months must be between 1 and 12');
  if(!metricIds.length)throw new Error('--metric-ids must select at least one conversion metric ID');
  const [metrics,campaigns,flows]=await Promise.all([client.paginate('/api/metrics',{maxPages:8}),client.paginate("/api/campaigns?filter=equals(messages.channel,'email')&page[size]=100",{maxPages:8}),client.paginate('/api/flows',{maxPages:8})]);
  const dated=[...campaigns.data.map(x=>({kind:'campaign',id:x.id,date:sourceDate(x)})),...flows.data.map(x=>({kind:'flow',id:x.id,date:sourceDate(x)}))].filter(x=>x.date).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  const catalogue=metricCatalogue(metrics.data),known=new Set(catalogue.map(x=>x.metric_id));
  for(const id of metricIds)if(!known.has(id))throw new Error(`Selected conversion metric ID is not visible in the metric catalogue: ${id}`);
  const months=monthsBetween(from,through,maxMonths);
  const allTasks=months.flatMap(month=>metricIds.flatMap(metric_id=>REPORT_KINDS.map(kind=>({month,metric_id,kind}))));
  const resume={month:option(args,'resume-month'),metric_id:option(args,'resume-metric-id'),kind:option(args,'resume-report-kind')};
  const resumeValues=Object.values(resume).filter(Boolean);
  if(resumeValues.length!==0&&resumeValues.length!==3)throw new Error('Resume requires --resume-month, --resume-metric-id, and --resume-report-kind together');
  let tasks=allTasks;
  if(resumeValues.length){const index=allTasks.findIndex(task=>task.month===resume.month&&task.metric_id===resume.metric_id&&task.kind===resume.kind);if(index<0)throw new Error(`Resume task is not in this bounded plan: ${taskKey(resume)}`);tasks=allTasks.slice(index);}
  const evidence=[];
  let budgetExhausted=false;
  for(let index=0;index<tasks.length;index++){
    const task=tasks[index],metric=catalogue.find(x=>x.metric_id===task.metric_id);
    if(budgetExhausted){evidence.push({...task,integration:metric.integration,status:'not_attempted_limit'});continue;}
    try{
      const response=await client.request(`/api/${task.kind}-values-reports`,{method:'POST',body:reportBody(task.kind,task.metric_id,{timezone,...monthWindow(task.month)})});
      const row_count=response?.data?.attributes?.results?.length??0;
      evidence.push({...task,integration:metric.integration,status:row_count===0?'zero_rows':'successful',row_count});
    }catch(error){
      if(error.code==='CALL_BOUND'){
        budgetExhausted=true;
        evidence.push({...task,integration:metric.integration,status:'not_attempted_limit',code:'CALL_BOUND'});
      }else evidence.push({...task,integration:metric.integration,status:'request_failed',http_status:error.status||null,code:error.code||error.name});
    }
  }
  const firstUnfinished=evidence.find(item=>!completed(item.status))||null;
  const next=!firstUnfinished&&months.length&&nextMonth(months.at(-1))<=through?nextMonth(months.at(-1)):null;
  return {
    read_only:true,
    account_usage_start:null,
    account_usage_start_status:'not established by these endpoints; do not infer it from the oldest returned object',
    earliest_accessible_dated_metadata:dated[0]||null,
    successfully_collected_coverage:'not changed by discovery; historical probes never approve months for collection',
    metrics:catalogue,
    selected_conversion_metric_ids:metricIds,
    potential_woocommerce_purchase_metrics:catalogue.filter(metric=>metric.integration==='woocommerce'&&/(purchase|placed order|order placed)/i.test(metric.name||'')).map(metric=>({...metric,review_status:'candidate_only_not_selected_or_applicable'})),
    evidence,
    call_budget_exhausted:budgetExhausted,
    first_unfinished_task:firstUnfinished&&{month:firstUnfinished.month,metric_id:firstUnfinished.metric_id,kind:firstUnfinished.kind},
    retention_and_access_limitations:['Listing pagination and API calls are bounded; the oldest returned item is only the earliest accessible evidence, not account start.','A successful zero-row response is probe evidence, not persisted zero activity.','Request failures and tasks not attempted because of limits are not zeros.','Historical availability probes are read-only and do not approve a month for collection.','Current attribution settings are not asserted to have applied to historical windows.','Metric IDs are integration-specific; WooCommerce candidates require review and are never probed unless explicitly selected.'],
    resume_command:resumeCommand({from,through,maxMonths,metricIds,task:firstUnfinished,next}),currency
  };
}
export async function main({env=process.env,args=process.argv.slice(2),write=console.log}={}){const client=createKlaviyoClient({apiKey:env.KLAVIYO_PRIVATE_API_KEY,revision:env.KLAVIYO_API_REVISION,maxCalls:Number(env.KLAVIYO_MAX_API_CALLS||80),timeoutMs:Number(env.KLAVIYO_TIMEOUT_MS||15000)}),result=await discoverHistory({client,timezone:env.KLAVIYO_ACCOUNT_TIMEZONE,currency:env.KLAVIYO_ACCOUNT_CURRENCY,args});write(JSON.stringify(result,null,2));return result;}
if(import.meta.url===`file://${process.argv[1]}`)main().catch(error=>{console.error(JSON.stringify({status:'error',code:error.code||error.name,message:redactKlaviyo(error.message)}));process.exitCode=1;});
