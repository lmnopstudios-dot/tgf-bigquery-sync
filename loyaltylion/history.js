// Explicit operator entrypoint. Importing this module never collects or provisions.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {loadLoyaltyConfig} from './runtime-config.js';
import {createLoyaltyClient} from './client.js';
import {fail,instant,normalizeCustomer,normalizeTransaction,validateConfig,rosterStagingPlan,transactionStagingPlan} from './contracts.js';
import {collectReviewedPlan,verifyVendor,provision} from './sync.js';
export function historyPlan(config,p){
 validateConfig(config,{reviewed:true});
 if(!p||p.version!==1||p.status!=='reviewed'||!p.reviewed_by||!Number.isFinite(Date.parse(p.reviewed_at)))throw fail('LOYALTY_HISTORY_NOT_REVIEWED');
 const start=instant(p.start_at),end=instant(p.end_exclusive);
 if(start>=end||Date.parse(end)>Date.now()||!Number.isInteger(p.window_days)||p.window_days<1||p.window_days>7)throw fail('LOYALTY_HISTORY_WINDOW_INVALID');
 const profiles={...config,roster_staging:p.roster_staging,transaction_staging:p.transaction_staging};
 if(!rosterStagingPlan(profiles)||!transactionStagingPlan(profiles))throw fail('LOYALTY_STAGING_PLAN_NOT_REVIEWED');
 if(p.incremental_enabled!==false&&p.incremental_enabled!==true)throw fail('LOYALTY_HISTORY_NOT_REVIEWED');
 return {...p,start_at:start,end_exclusive:end};
}
export function nextHistoryWindow(plan,coverage){
 let cursor=Date.parse(plan.start_at),end=Date.parse(plan.end_exclusive);
 const ranges=coverage.filter(r=>r.resource==='transactions'&&r.status==='complete')
  .map(r=>[Date.parse(r.start_at?.value??r.start_at),Date.parse(r.end_exclusive?.value??r.end_exclusive)])
  .filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&a<b).sort((a,b)=>a[0]-b[0]);
 for(const [a,b]of ranges){if(b<=cursor)continue;if(a>cursor)break;cursor=Math.max(cursor,b);}
 if(cursor>=end)return null;
 const next=ranges.find(([a])=>a>cursor)?.[0]??end;
 return {start_at:new Date(cursor).toISOString(),end_exclusive:new Date(Math.min(end,next,cursor+plan.window_days*86400000)).toISOString()};
}
export async function historyStatus({bigquery,project,config,plan}){
 if(!/^[\w-]+$/.test(project)||!/^\w+$/.test(config.dataset))throw fail('LOYALTY_INVALID_IDENTIFIER');
 const [meta]=await bigquery.dataset(config.dataset).getMetadata();
 const read=async(query,operation)=>(await bigquery.query({query,params:{program:config.program_id},types:{program:'STRING'},location:meta.location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000,labels:{component:'loyalty_history',operation}}))[0];
 const coverage=await read(`SELECT resource,start_at,end_exclusive,status,run_id,row_count,observed_at FROM \`${project}.${config.dataset}.coverage_windows\` WHERE program_id=@program AND status='complete' ORDER BY start_at LIMIT 5001`,'coverage');
 if(coverage.length>5000)throw fail('LOYALTY_COVERAGE_BOUND');
 const guards=await read(`SELECT COUNT(*) guard_rows,COUNTIF(holder IS NOT NULL) held_guards FROM \`${project}.${config.dataset}.sync_guard\` WHERE program_id=@program`,'guard');
 return {read_only:true,coverage,guard:guards[0],next_window:nextHistoryWindow(plan,coverage)};
}
export async function previewHistory({config,plan,resource,window,client,onProgress=()=>{}}){
 await verifyVendor(config,client);
 const bounds=resource==='customers'?plan.roster_staging:plan.transaction_staging;
 let rows=0,bytes=0,complete=false,pages=0;
 const ids=new Set(),run={program_id:config.program_id,run_id:'preview',observed_at:new Date().toISOString()};
 for await(const p of client.pages(resource,resource==='transactions'?{created_at_min:window.start_at,created_at_max:window.end_exclusive}:{},bounds)){
  const normalized=p.items.map(x=>resource==='customers'?normalizeCustomer(x,run):normalizeTransaction(x,run));
  for(const item of normalized){const row=item.transaction??item,id=row.customer_ref_id+(resource==='transactions'?':'+row.transaction_id:'');if(ids.has(id))throw fail('LOYALTY_DUPLICATE_PAGE_ID');ids.add(id);if(resource==='transactions'&&(row.created_at<window.start_at||row.created_at>=window.end_exclusive))throw fail('LOYALTY_WINDOW_MISMATCH');}
  const size=Buffer.byteLength(JSON.stringify(normalized));bytes+=size;
  if(size>bounds.page_bytes||bytes>bounds.max_bytes)throw fail('LOYALTY_PAYLOAD_BOUND');
  rows+=p.items.length;pages=p.page;complete=p.complete;onProgress({phase:resource+'_preview',rows,pages,bytes,...client.stats()});
 }
 if(!complete)throw fail('LOYALTY_PAGE_BOUND');
 return {status:'preview_complete',read_only:true,warehouse_writes:false,resource,...window,rows,pages,bytes};
}
export async function runHistory({config,plan,bigquery,project,clientFactory,mode='status',resource='transactions',apply=false,env={},onProgress=()=>{},now=()=>new Date().toISOString()}){
 plan=historyPlan(config,plan);
 if(!['status','next','incremental','roster','setup','discover'].includes(mode)||!['customers','transactions'].includes(resource))throw fail('LOYALTY_INVALID_ARGUMENT');
 if(mode==='setup'){
  if(!apply)return {status:'setup_preview',warehouse_writes:false};
  const approved={...config,initial_sync:{reviewed_by:plan.reviewed_by,reviewed_at:plan.reviewed_at,resources:['customers','transactions'],start_at:new Date(Date.parse(plan.end_exclusive)-86400000).toISOString(),end_exclusive:plan.end_exclusive}};
  await provision({config:approved,bigquery,project,env,apply:true});return {status:'setup_verified',collection_started:false};
 }
 if(mode==='discover'){
  if(apply)throw fail('LOYALTY_INVALID_ARGUMENT');
  const bounds=plan.transaction_staging,client=clientFactory({...config.limits,max_calls:bounds.max_calls,max_ms:bounds.max_ms});
  await verifyVendor(config,client);
  let rows=0,bytes=0,earliest=null,latest=null,complete=false;const cutoff=instant(now()),run={program_id:config.program_id,run_id:'preview',observed_at:cutoff};
  for await(const page of client.pages('transactions',{created_at_max:cutoff},bounds)){
   const normalized=page.items.map(item=>normalizeTransaction(item,run));const size=Buffer.byteLength(JSON.stringify(normalized));bytes+=size;
   if(size>bounds.page_bytes||bytes>bounds.max_bytes)throw fail('LOYALTY_PAYLOAD_BOUND');
   for(const {transaction:t}of normalized){earliest=earliest==null||t.created_at<earliest?t.created_at:earliest;latest=latest==null||t.created_at>latest?t.created_at:latest;}
   rows+=normalized.length;complete=page.complete;onProgress({phase:'history_discovery',pages:page.page,rows,bytes,...client.stats()});
  }
  if(!complete)throw fail('LOYALTY_PAGE_BOUND');
  return {read_only:true,warehouse_writes:false,rows,earliest_accessible_transaction:earliest,latest_accessible_transaction:latest,observed_through:cutoff,accessible_ledger_complete:true,lifetime_history_certified:false};
 }
 const status=await historyStatus({bigquery,project,config,plan});
 if(mode==='status')return status;
 if(Number(status.guard?.guard_rows)!==1||Number(status.guard?.held_guards)!==0)throw fail('LOYALTY_GUARD_BUSY_OR_UNOWNED');
 if(mode==='incremental'&&(!plan.incremental_enabled||status.next_window))throw fail('LOYALTY_HISTORY_OR_INCREMENTAL_NOT_READY');
 let window=status.next_window;
 if(mode==='incremental'){
  const current=instant(now());
  const extended=nextHistoryWindow({...plan,end_exclusive:current},status.coverage);
  window=extended;
 }
 if(mode==='roster'){resource='customers';window={start_at:plan.start_at,end_exclusive:plan.end_exclusive};}
 if(!window)return {status:'complete',read_only:true,collection_started:false};
 const bounds=resource==='customers'?plan.roster_staging:plan.transaction_staging;
 const client=clientFactory({...config.limits,max_calls:bounds.max_calls,max_ms:bounds.max_ms});
 if(!apply)return previewHistory({config,plan,resource,window,client,onProgress});
 // The reviewed history file authorizes only this derived bounded window.
 const approved={...config,roster_staging:plan.roster_staging,transaction_staging:plan.transaction_staging,
  initial_sync:{reviewed_by:plan.reviewed_by,reviewed_at:plan.reviewed_at,resources:[resource],...window}};
 // Roster observation is current; its bookkeeping window must still be bounded.
 if(resource==='customers')approved.initial_sync={...approved.initial_sync,start_at:new Date(Date.parse(window.end_exclusive)-86400000).toISOString()};
 return collectReviewedPlan({config:approved,bigquery,project,client,env,apply:true,onProgress,now});
}
async function main(){
 const args=process.argv.slice(2),mode=args[0]||'status';
 if(args.slice(1).some(a=>!['--preview','--apply'].includes(a))||args.includes('--preview')&&args.includes('--apply')||new Set(args).size!==args.length)throw fail('LOYALTY_INVALID_ARGUMENT');
 const config=loadLoyaltyConfig(),plan=JSON.parse(await readFile(process.env.LOYALTYLION_HISTORY_PLAN_PATH,'utf8'));
 const {bigquery,project}=createBigQueryClient();
 let state={phase:'startup',pages:0,rows:0};const started=Date.now();
 const emit=extra=>{state={...state,...extra};console.log(JSON.stringify({...state,elapsed_ms:Date.now()-started}));};
 const timer=setInterval(()=>emit({status:'running'}),15000);timer.unref();emit({status:'started'});
 try{const result=await runHistory({config,plan,bigquery,project,mode,apply:args.includes('--apply'),env:process.env,onProgress:emit,clientFactory:limits=>createLoyaltyClient({key:process.env.LOYALTYLION_API_KEY,limits})});console.log(JSON.stringify(result));if(result.complete===false)process.exitCode=1;}finally{clearInterval(timer);}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(JSON.stringify({status:'failed',code:/^LOYALTY_[A-Z_]+$/.test(e.code||'')?e.code:'LOYALTY_HISTORY_UNAVAILABLE'}));process.exitCode=1;});
