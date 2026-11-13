import {loyaltyMarkdown} from './loyalty-presentation.js';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
import {validateConfig} from '../loyaltylion/contracts.js';
import {resolveAnalyticalPlan} from './analytical-plan.js';
import {shopifyRecordedChannel} from './shopify-sale-binding.js';
import {qualifyingCustomerOrderPredicate,MATRIXIFY_APP_ID} from './customer-query.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
import {boundedQuery} from './bounded-query.js';
import {boundedEvidenceRead} from './bounded-evidence-read.js';
const defaultConfig=loadLoyaltyConfig();
const fail=code=>Object.assign(Error(code),{code});
const clean=v=>v&&typeof v==='object'&&'value'in v?v.value:v;
const rowFields={membership:['enrolled','guest','blocked','profiles','approved_points','pending_points','unlinked_customer_profiles'],tiers:['tier','enrolled_members','approved_points','pending_points'],points:['date','resource','point_movements','approved_delta','pending_delta','net_points_delta'],claims:['date','reward_kind','reward_claims','claimed_points'],linkage:['order_date','linkage_state','channel','currency','point_records','linked_qualifying_orders']};
function validateRows(section,rows,context){
 const labels=new Set(['enrolled','guest','blocked','tier','date','resource','reward_kind','order_date','linkage_state','channel','currency']);
 for(const row of rows){
  if(!row||Object.keys(row).some(k=>!rowFields[section].includes(k))||rowFields[section].some(k=>!Object.hasOwn(row,k)))throw fail('LOYALTY_ROW_CONTRACT_INVALID');
  for(const [k,v]of Object.entries(row))if(!labels.has(k)&&v!==null&&!Number.isSafeInteger(v))throw fail('LOYALTY_ROW_CONTRACT_INVALID');
  if(section==='points'&&row.net_points_delta!==row.approved_delta+row.pending_delta)throw fail('LOYALTY_ROW_CONTRACT_INVALID');
  if(['points','claims'].includes(section)&&(!/^\d{4}-\d{2}-\d{2}$/.test(row.date||'')||row.date<(context.grain==='month'?context.start_date.slice(0,7)+'-01':context.start_date)||row.date>context.end_date))throw fail('LOYALTY_ROW_DATE_INVALID');
  if(section==='tiers'&&context.loyalty_scope.tier&&row.tier?.toLowerCase()!==context.loyalty_scope.tier)throw fail('LOYALTY_ROW_TIER_INVALID');
 }
}
export const LOYALTY_LIMITATIONS=['Current tiers are snapshot state, not historical tiers.','Reward claims consume points; they are not proof of reward use or an order discount.','Points are unitless. No currency conversion or financial points liability is inferred.','Purchasing uses governed native Shopify qualifying orders, excluding Matrixify; linked orders are counted once. Unknown links and channels remain separate.','Source windows and certified collection coverage are distinct. No source collection or automatic replay is triggered by this report.'];
export const LOYALTY_TOOL_DEFINITION={type:'function',name:'get_loyalty_report',description:'Read retained LoyaltyLion membership/current tiers, dated point deltas, reward claims and exact native Shopify linkage. Historical tiers and actual reward usage are unavailable. Never collects source data.',strict:true,parameters:{type:'object',additionalProperties:false,properties:{section:{type:'string',enum:['membership','tiers','points','claims','linkage']},start_date:{type:['string','null']},end_date:{type:['string','null']}},required:['section','start_date','end_date']}};
export function londonMidnight(day){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')||new Date(day+'T00:00:00Z').toISOString().slice(0,10)!==day)throw fail('LOYALTY_INVALID_PERIOD');
 const utc=Date.parse(day+'T00:00:00Z'),label=new Intl.DateTimeFormat('en',{timeZone:'Europe/London',timeZoneName:'longOffset'}).formatToParts(new Date(utc)).find(p=>p.type==='timeZoneName').value;
 const offset=label.match(/GMT([+-])(\d{2}):(\d{2})/),minutes=offset?(Number(offset[2])*60+Number(offset[3]))*(offset[1]==='+'?1:-1):0;
 return new Date(utc-minutes*60000).toISOString();
}
export function coverageComplete(rows,start,end){
 let cursor=Date.parse(start);for(const r of rows.filter(r=>r.status==='complete').sort((a,b)=>String(a.start_at).localeCompare(String(b.start_at)))){const a=Date.parse(clean(r.start_at)),b=Date.parse(clean(r.end_exclusive));if(a>cursor)break;if(b>cursor)cursor=b;}return cursor>=Date.parse(end);
}
const fq=(p,d,t)=>{if(![p,d,t].every(x=>/^[A-Za-z0-9_-]+$/.test(x)))throw fail('LOYALTY_INVALID_IDENTIFIER');return `\`${p}.${d}.${t}\``;};
export function loyaltyQueries(project,dataset,{grain=null}={}){
 const t=n=>fq(project,dataset,n),date=col=>`DATE(${col},'Europe/London')`,bucket=col=>grain==='month'?`DATE_TRUNC(${date(col)},MONTH)`:date(col);
 const roster=`members AS(SELECT * FROM ${t('customer_snapshots')} WHERE program_id=@program_id AND run_id=@roster_run),selected_members AS(SELECT * FROM members WHERE (@tier IS NULL OR LOWER(tier_name)=@tier))`;
 const tx=`tx AS(SELECT * FROM ${t('points_transactions')} WHERE program_id=@program_id AND run_id IN UNNEST(@transaction_runs) AND created_at>=TIMESTAMP(@start_date,'Europe/London') AND created_at<TIMESTAMP(DATE_ADD(DATE(@end_date),INTERVAL 1 DAY),'Europe/London') AND (@tier IS NULL OR customer_ref_id IN(SELECT customer_ref_id FROM selected_members)))`;
 const latest=(tableName,alias)=>`${alias} AS(SELECT * FROM ${fq(project,'shopify_data',tableName)} QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1)`;
 const orders=`${latest('order_customers','c')},${latest('order_financials','f')},${latest('order_locations','l')},order_evidence AS(SELECT 'shopify' source_platform,'shopify' source_store,l.order_id source_order_id,c.customer_id source_customer_id,LOWER(c.display_financial_status) status,f.original_total_shop source_order_value,f.total_refunded_shop source_refund_value,COALESCE(l.source_app_id=@matrixify_app_id,FALSE) is_migrated_order,c.cancelled_at IS NOT NULL OR f.cancelled_at IS NOT NULL cancelled,l.created_at,${shopifyRecordedChannel} channel,UPPER(f.presentment_currency) currency FROM l JOIN c USING(order_id) JOIN f USING(order_id)),qualifying_orders AS(SELECT * FROM order_evidence WHERE ${qualifyingCustomerOrderPredicate()})`;
 return {
  coverage:`SELECT resource,start_at,end_exclusive,observed_at,run_id,row_count,status FROM ${t('coverage_windows')} WHERE program_id=@program_id AND observed_at<=TIMESTAMP(@as_of) ORDER BY observed_at DESC LIMIT 501`,
  membership:`WITH ${roster} SELECT enrolled,guest,blocked,COUNT(*) profiles,SUM(approved) approved_points,SUM(pending) pending_points,COUNTIF(shopify_customer_gid IS NULL) unlinked_customer_profiles FROM selected_members GROUP BY enrolled,guest,blocked`,
  tier_presence:`WITH ${roster} SELECT COUNT(*) profiles FROM selected_members`,
  tiers:`WITH ${roster} SELECT COALESCE(tier_name,'Unknown tier') tier,COUNT(*) enrolled_members,SUM(approved) approved_points,SUM(pending) pending_points FROM selected_members WHERE enrolled GROUP BY tier ORDER BY tier LIMIT 501`,
  points:`WITH ${roster},${tx} SELECT ${bucket('created_at')} date,resource,COUNT(*) point_movements,SUM(approved_delta) approved_delta,SUM(pending_delta) pending_delta,SUM(approved_delta+pending_delta) net_points_delta FROM tx GROUP BY date,resource ORDER BY date,resource LIMIT 501`,
  claims:`WITH ${roster},claims AS(SELECT * FROM ${t('reward_claim_observations')} WHERE program_id=@program_id AND run_id IN UNNEST(@transaction_runs) AND claimed_at>=TIMESTAMP(@start_date,'Europe/London') AND claimed_at<TIMESTAMP(DATE_ADD(DATE(@end_date),INTERVAL 1 DAY),'Europe/London') AND (@tier IS NULL OR customer_ref_id IN(SELECT customer_ref_id FROM selected_members)) QUALIFY ROW_NUMBER() OVER(PARTITION BY program_id,claim_id ORDER BY observed_at DESC)=1) SELECT ${bucket('claimed_at')} date,reward_kind,COUNT(*) reward_claims,SUM(point_cost) claimed_points FROM claims GROUP BY date,reward_kind ORDER BY date,reward_kind LIMIT 501`,
  linkage:`WITH ${roster},${tx},${orders},links AS(SELECT t.transaction_id,t.shopify_order_gid,t.shopify_customer_gid,CASE WHEN t.shopify_order_gid IS NULL THEN 'no_order_reference' WHEN o.source_order_id IS NULL THEN 'unmatched_or_ineligible_order' WHEN t.shopify_customer_gid IS NULL THEN 'customer_unavailable' WHEN t.shopify_customer_gid!=o.source_customer_id THEN 'ambiguous_customer' ELSE 'matched' END linkage_state,o.created_at,o.channel,o.currency,o.source_order_id FROM tx t LEFT JOIN qualifying_orders o ON t.shopify_order_gid=o.source_order_id),selected_links AS(SELECT * FROM links WHERE (@channel IS NULL OR channel=@channel) AND (COALESCE(ARRAY_LENGTH(@currencies),0)=0 OR currency IN UNNEST(@currencies))) SELECT ${bucket('created_at')} order_date,linkage_state,COALESCE(channel,'unknown') channel,COALESCE(currency,'Unknown currency') currency,COUNT(*) point_records,COUNT(DISTINCT IF(linkage_state='matched',source_order_id,NULL)) linked_qualifying_orders FROM selected_links GROUP BY order_date,linkage_state,channel,currency ORDER BY order_date,linkage_state,channel,currency LIMIT 501`,
  linkage_coverage:`WITH ${roster},${tx},${orders} SELECT COUNT(*) point_records,COUNTIF(t.shopify_order_gid IS NULL) no_order_reference,COUNTIF(t.shopify_order_gid IS NOT NULL AND o.source_order_id IS NULL) unmatched_or_ineligible_order,COUNTIF(o.source_order_id IS NOT NULL AND t.shopify_customer_gid IS NULL) customer_unavailable,COUNTIF(o.source_order_id IS NOT NULL AND t.shopify_customer_gid IS NOT NULL AND t.shopify_customer_gid!=o.source_customer_id) ambiguous_customer,COUNTIF(o.source_order_id IS NOT NULL AND t.shopify_customer_gid=o.source_customer_id) matched FROM tx t LEFT JOIN qualifying_orders o ON t.shopify_order_gid=o.source_order_id`
 };
}
export function createLoyaltyReportService({bigquery,project,env={},config=defaultConfig,now=()=>new Date().toISOString()}={}){
 validateConfig(config);
 return async(context,{signal,deadlineAt=Date.now()+45000,onProviderStage,onQueryAllocated}={})=>{
  const scope=context.loyalty_scope,as_of=now(),sections=[];
  const evidence={kind:'governed_loyalty',requested_subject:'loyalty',metrics:['loyalty'],analytical_plan:resolveAnalyticalPlan(context),loyalty_scope:scope,program_id:config.program_id,as_of,periods:context.start_date?[{start_date:context.start_date,end_date:context.end_date},...(context.comparison_start_date?[{start_date:context.comparison_start_date,end_date:context.comparison_end_date}]:[])]:[],sections,coverage:{complete:false},limitations:LOYALTY_LIMITATIONS,read_only:true};
  if(context.comparison_start_date)evidence.comparison={status:'unavailable',code:'LOYALTY_PERIOD_COMPARISON_UNAVAILABLE',start_date:context.comparison_start_date,end_date:context.comparison_end_date};
  let disabled=null;try{validateConfig(config,{reviewed:true});}catch{disabled='LOYALTY_ACCESS_NOT_REVIEWED';}if(env.LOYALTYLION_REPORTING_ENABLED!=='true')disabled='LOYALTY_REPORTING_DISABLED';if(scope.program_id!=null&&scope.program_id!==config.program_id)disabled='LOYALTY_PROGRAM_UNAVAILABLE';
  if(!disabled&&context.start_date&&(context.start_date>context.end_date||Date.parse(context.end_date)-Date.parse(context.start_date)>366*86400000))disabled='LOYALTY_REPORT_WINDOW_UNSUPPORTED';
  if(disabled){scope.sections.forEach(section=>sections.push({section,status:'unavailable',code:disabled,rows:[]}));return evidence;}
  const q=loyaltyQueries(project,config.dataset,{grain:context.grain}),params={program_id:config.program_id,start_date:context.start_date,end_date:context.end_date,as_of,tier:scope.tier,roster_run:null,transaction_runs:[],channel:context.channel,currencies:context.currencies,matrixify_app_id:MATRIXIFY_APP_ID},types={program_id:'STRING',start_date:'STRING',end_date:'STRING',as_of:'STRING',tier:'STRING',roster_run:'STRING',transaction_runs:['STRING'],channel:'STRING',currencies:['STRING'],matrixify_app_id:'STRING'};
  let location,coverage=[],tierObserved=true;
  const hooks=()=>({signal,deadlineAt,maximumMs:15000,onProviderStage,onQueryAllocated});
  const read=async name=>{signal?.throwIfAborted();const [rows]=await boundedQuery(bigquery,{query:q[name],params,types,location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000,labels:{component:'oracle_loyalty',operation:name}},hooks());return rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,clean(v)])));};
  try{location=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,config.dataset),hooks());coverage=await read('coverage');evidence.coverage.windows=coverage.slice(0,500);evidence.coverage.truncated=coverage.length>500;const roster=coverage.find(r=>r.resource==='customers'&&r.status==='complete');params.roster_run=roster?.run_id||null;evidence.snapshot_observed_at=roster?.observed_at||null;params.transaction_runs=[...new Set(coverage.filter(r=>r.resource==='transactions'&&r.status==='complete').map(r=>r.run_id))];}catch{evidence.coverage.status='unavailable';}
  if(scope.tier&&params.roster_run){try{tierObserved=Number((await read('tier_presence'))[0]?.profiles)>0;}catch{tierObserved=false;}}
  for(const section of scope.sections){
   let unavailable=null;
   if(context.grain&&!['day','month'].includes(context.grain))unavailable='LOYALTY_GRAIN_UNSUPPORTED';
   else if(scope.tier_basis==='historical')unavailable='LOYALTY_HISTORICAL_TIERS_UNAVAILABLE';
   else if(scope.purchase_values&&section==='linkage')unavailable='LOYALTY_PURCHASING_VALUES_UNAVAILABLE';
   else if(scope.tier&&!tierObserved)unavailable='LOYALTY_TIER_NOT_OBSERVED';
   else if(scope.reward_use&&section==='claims')unavailable='LOYALTY_REWARD_USE_UNAVAILABLE';
   else if(!location||!evidence.coverage.windows)unavailable='LOYALTY_COVERAGE_UNAVAILABLE';
   else if(['membership','tiers'].includes(section)&&!params.roster_run||scope.tier&&!params.roster_run)unavailable='LOYALTY_ROSTER_UNAVAILABLE';
   else if(!['membership','tiers'].includes(section)&&(!context.start_date||!context.end_date))unavailable='LOYALTY_PERIOD_REQUIRED';
   else if(['membership','tiers','points','claims'].includes(section)&&(context.channel||context.channel_breakdown||context.currencies.length))unavailable='LOYALTY_SECTION_FILTER_UNSUPPORTED';
   else if(['membership','tiers'].includes(section)&&context.grain)unavailable='LOYALTY_SNAPSHOT_NOT_TIME_SERIES';
   if(unavailable){sections.push({section,status:'unavailable',code:unavailable,rows:[]});continue;}
   try{
    if(section==='linkage'){const shopLocation=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,'shopify_data'),hooks());if(shopLocation!==location)throw fail('LOYALTY_REGION_MISMATCH');}
    const rows=await read(section),truncated=rows.length>500;validateRows(section,rows.slice(0,500),context);
    const required=coverage.filter(r=>r.resource==='transactions');
    const eventCoverage=['membership','tiers'].includes(section)?true:coverageComplete(required,londonMidnight(context.start_date),londonMidnight(new Date(Date.parse(context.end_date+'T00:00:00Z')+86400000).toISOString().slice(0,10)));
    const complete=eventCoverage&&!truncated&&!evidence.coverage.truncated&&!['claims','linkage'].includes(section);
    let linkCoverage=null;if(section==='linkage'){linkCoverage=(await read('linkage_coverage'))[0]||null;if(!linkCoverage||['no_order_reference','unmatched_or_ineligible_order','customer_unavailable','ambiguous_customer','matched'].reduce((n,k)=>n+linkCoverage[k],0)!==linkCoverage.point_records)throw fail('LOYALTY_LINKAGE_COVERAGE_INVALID');
      if(!context.channel&&!context.currencies.length&&!truncated&&rows.reduce((n,r)=>n+r.point_records,0)!==linkCoverage.point_records)
        throw fail('LOYALTY_LINKAGE_ROWS_MISMATCH');
    }
    sections.push({section,status:complete?'fulfilled':'partial',rows:rows.slice(0,500),truncated,coverage_complete:complete,transaction_window_complete:eventCoverage,...(linkCoverage?{linkage_coverage:linkCoverage}:{}),...(params.roster_run?{roster_run:params.roster_run}:{}),...(section==='claims'?{definition:'Distinct claims by claimed_at; actual use unavailable. Coverage concerns accessible transaction history, not proof of all claims including claims without point movements.'}:{}),...(section==='linkage'?{commerce_coverage:'unverified',definition:'Observed orders linked from point transactions in the requested London transaction-date window; order_date is the original order date, not a second period filter.'}:{})});
   }catch(e){sections.push({section,status:'unavailable',code:/^LOYALTY_[A-Z_]+$/.test(e.code||'')?e.code:'LOYALTY_SECTION_ACCESS_UNAVAILABLE',rows:[]});}
  }
  evidence.coverage.complete=!evidence.comparison&&sections.every(s=>s.status==='fulfilled'&&s.coverage_complete)&&!evidence.coverage.truncated;return evidence;
 };
}
export function assertLoyaltyEvidence(context,e){
 if(e?.kind!=='governed_loyalty'||JSON.stringify(context.loyalty_scope)!==JSON.stringify(e.loyalty_scope)||!Array.isArray(e.sections)||e.sections.length!==context.loyalty_scope.sections.length||context.loyalty_scope.sections.some(name=>e.sections.filter(s=>s.section===name).length!==1)||e.sections.some(s=>!['fulfilled','partial','unavailable'].includes(s.status)||!Array.isArray(s.rows)||s.rows.length>500||s.status==='unavailable'&&s.rows.length))throw fail('EVIDENCE_SCOPE_MISMATCH');
 if(context.loyalty_scope.program_id!=null&&context.loyalty_scope.program_id!==e.program_id)throw fail('EVIDENCE_SCOPE_MISMATCH');
 for(const s of e.sections)if(s.status!=='unavailable')validateRows(s.section,s.rows,context);
 if((context.loyalty_scope.tier_basis==='historical'||context.loyalty_scope.reward_use)&&e.sections.some(s=>(context.loyalty_scope.tier_basis==='historical'||s.section==='claims')&&s.status!=='unavailable'))throw fail('EVIDENCE_SCOPE_MISMATCH');
 return true;
}
export async function answerLoyaltyReport({context,provider,...options}){
 const evidence=await provider(context,options);assertLoyaltyEvidence(context,evidence);
 const lines=loyaltyMarkdown(evidence);
 const result={answer:lines.join('\n'),analysis_context:context,evidence,partial:!evidence.coverage.complete,tools:['get_loyalty_report']};
 if(context.output_preference==='xlsx'){
  const {exportRetainedSpreadsheet}=await import('./retained-spreadsheet.js'),{assertEvidenceAgreement}=await import('./analysis-route-dispatcher.js');
  const timestamp=typeof options.now==='number'?options.now:Date.now();
  return exportRetainedSpreadsheet({recent:{...result,retained_at:new Date(timestamp).toISOString()},context,store:options.exportStore,owner:options.exportOwner,requestId:options.requestId,downloadBase:options.downloadBase,assertAgreement:assertEvidenceAgreement,now:timestamp});
 }
 return result;
}

export async function executeLoyaltyToolCall(provider,name,args){
 if(name!=='get_loyalty_report')return {handled:false};
 if(!args||!['membership','tiers','points','claims','linkage'].includes(args.section))throw fail('LOYALTY_INVALID_SECTION');
 for(const key of ['start_date','end_date'])if(args[key]!=null&&(!/^\d{4}-\d{2}-\d{2}$/.test(args[key])||new Date(args[key]+'T00:00:00Z').toISOString().slice(0,10)!==args[key]))throw fail('LOYALTY_INVALID_PERIOD');
 if(Boolean(args.start_date)!==Boolean(args.end_date)||args.start_date>args.end_date)throw fail('LOYALTY_INVALID_PERIOD');
 const c={requested_subject:'loyalty',analysis_type:'ecommerce',metrics:['loyalty'],tool_route:'get_loyalty_report',loyalty_scope:{program_id:defaultConfig.program_id,sections:[args.section],tier_basis:'current',tier:null,reward_use:false,purchase_values:false},start_date:args.start_date,end_date:args.end_date,time_zone:'Europe/London',grain:null,currencies:[],channel:null,channel_breakdown:false};
 return {handled:true,result:await provider(c)};
}
