import {stableAnalyticalJSON} from './analytical-plan.js';
import {boundedQuery} from './bounded-query.js';
import {datasetLocation} from '../bigquery/dataset-location.js';
import {boundedEvidenceRead} from './bounded-evidence-read.js';
import {qualifyingCustomerOrderPredicate} from './customer-query.js';
export const PERFORMANCE_DEFINITIONS=[
 'Observed association, not causal impact: selection, customer tenure, seasonality and promotions can explain differences. No incremental revenue or ROI is inferred.',
 'Purchasing groups use current roster membership, explicitly not membership at purchase. Enrolled_at supports enrolment-relative observations, not a complete membership status history. Missing/deleted and ambiguous profiles stay unknown.',
 'Purchasing: unique native qualifying Shopify orders; cancelled and known Matrixify copies excluded, governed paid/partially-paid/partially-refunded eligibility and positive retained value required. Customerless orders are reported in linkage diagnostics, not customer denominators.',
 'AOV uses original discounted order gross including shipping and tax, before refunds, in presentment currency. Retained lifetime order refunds are separate; they are not refund-event-date sales. Never combine currencies.',
 'Full period distinct customers and repeat rates are calculated directly across the full period. Never sum monthly distinct customers or average monthly repeat rates. Do not sum Full period and monthly rows. Period repeat rate is customers with at least two eligible orders in the same period / customers with at least one. It is not a subsequent-purchase probability or lifetime retention rate. A customer can occur in multiple channel/currency groups.',
 'Cohorts use 30/90/180 elapsed days before/after recorded enrolment, same customer pool on both sides, including customers with zero observed purchases. Rates require mature, certified full observation windows. Missing coverage is not zero demand.',
 'Claims, points spent and negative movements do not prove voucher use. Actual use, recorded reward discounts, historical tiers and financial points liability remain unavailable until verified bindings exist.',
 'Monetary aggregates are transported as exact decimal strings. Excel uses numeric cells only when they round-trip without precision loss within 15 significant digits; larger or finer values remain exact text.',
 'Monthly activity counts distinct point participants separately from distinct claimants. Approval transfers can move pending into approved without earning new points; negative movements are not all redemptions.',
 'May Bank Holiday and Black Friday are recurring context. Only reviewed actual campaign dates are shown. No dates or campaign participation are guessed; promotions can confound comparisons.'
];
const localDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function performanceWindows(context,now){
 const out=[{label:'Requested period',start_date:context.start_date,end_date:context.end_date}];
 if(context.comparison_start_date)out.push({label:'Comparison',start_date:context.comparison_start_date,end_date:context.comparison_end_date});
 if(context.loyalty_scope.performance_mtd){const today=localDay(now),end=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10),start=today.slice(0,7)+'-01';if(start<=end)out.push({label:'Current month to yesterday',start_date:start,end_date:end});}
 return out;
}
export function performanceOrderSources(project){
 if(!/^[\w-]+$/.test(project))throw Error('LOYALTY_INVALID_IDENTIFIER');
 const s=n=>`\`${project}.shopify_data.${n}\``;
 const latest=(n,alias)=>`${alias} AS(SELECT * FROM ${s(n)} x QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC,TO_JSON_STRING(x) DESC)=1)`;
 const orders=`${latest('order_financials','f')},${latest('order_customers','c')},${latest('order_locations','l')},order_evidence AS(SELECT 'shopify' source_platform,'shopify' source_store,f.order_id source_order_id,c.customer_id source_customer_id,LOWER(c.display_financial_status) status,f.original_total_shop source_order_value,f.total_refunded_shop source_refund_value,COALESCE(l.source_app_id=@matrixify_app_id,FALSE) OR COALESCE(c.source_app_id=@matrixify_app_id,FALSE) is_migrated_order,c.cancelled_at IS NOT NULL OR f.cancelled_at IS NOT NULL cancelled,f.created_at,CASE LOWER(TRIM(l.order_source)) WHEN 'online store' THEN 'online' WHEN 'point of sale' THEN 'instore' ELSE 'unknown' END channel,COALESCE(NULLIF(UPPER(f.presentment_currency),''),'Unknown currency') currency,f.original_total_presentment gross,f.total_refunded_presentment retained_refunds FROM f LEFT JOIN c USING(order_id) LEFT JOIN l USING(order_id)),qualifying_orders AS(SELECT * FROM order_evidence WHERE ${qualifyingCustomerOrderPredicate()} AND created_at<TIMESTAMP(@as_of))`;
 return orders;
}
export function performanceQueries(project,dataset){
 if(![project,dataset].every(x=>/^[\w-]+$/.test(x)))throw Error('LOYALTY_INVALID_IDENTIFIER');
 const t=n=>`\`${project}.${dataset}.${n}\``;
 const roster=`members AS(SELECT * FROM ${t('customer_snapshots')} WHERE program_id=@program_id AND run_id=@roster_run), identities AS(SELECT shopify_customer_gid,COUNT(*) profiles FROM members WHERE shopify_customer_gid IS NOT NULL GROUP BY 1), unique_members AS(SELECT m.* FROM members m JOIN identities i USING(shopify_customer_gid) WHERE i.profiles=1)`;
 const tx=`tx AS(SELECT * FROM ${t('points_transactions')} WHERE program_id=@program_id AND run_id IN UNNEST(@transaction_runs) AND created_at<TIMESTAMP(@as_of))`;
 const windows=`windows AS(SELECT JSON_VALUE(w,'$.label') period,DATE(JSON_VALUE(w,'$.start_date')) start_date,DATE(JSON_VALUE(w,'$.end_date')) end_date FROM UNNEST(JSON_QUERY_ARRAY(@windows)) w)`;
 const orders=performanceOrderSources(project);
 const selected=`selected AS(SELECT o.*,CASE WHEN m.customer_ref_id IS NULL THEN 'unknown' WHEN m.enrolled THEN 'current_member' ELSE 'current_non_member' END membership_basis,CASE WHEN m.enrolled_at IS NULL THEN 'enrolment_unknown' WHEN o.created_at<m.enrolled_at THEN 'before_recorded_enrolment' ELSE 'on_or_after_recorded_enrolment' END enrolment_relation FROM qualifying_orders o LEFT JOIN unique_members m ON o.source_customer_id=m.shopify_customer_gid WHERE (@channel IS NULL OR o.channel=@channel) AND (COALESCE(ARRAY_LENGTH(@currencies),0)=0 OR o.currency IN UNNEST(@currencies)))`;
 const base=`WITH ${roster},${windows},${orders},${selected}`;
 return {
  usage:`WITH ${roster},${tx},${windows} SELECT w.period,CAST(DATE_TRUNC(DATE(t.created_at,'Europe/London'),MONTH) AS STRING) month,t.resource,COUNT(*) point_movements,COUNT(DISTINCT t.customer_ref_id) participants,COUNT(DISTINCT IF(m.enrolled,t.customer_ref_id,NULL)) current_enrolled_participants,SUM(GREATEST(t.approved_delta+t.pending_delta,0)) positive_net_movements,SUM(LEAST(t.approved_delta+t.pending_delta,0)) negative_net_movements,SUM(t.approved_delta) approved_delta,SUM(t.pending_delta) pending_delta,SUM(t.approved_delta+t.pending_delta) net_delta,COUNT(DISTINCT IF(t.resource='claimed_reward',t.customer_ref_id,NULL)) observed_claimants FROM tx t JOIN windows w ON DATE(t.created_at,'Europe/London') BETWEEN w.start_date AND w.end_date LEFT JOIN members m ON t.customer_ref_id=m.customer_ref_id GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT 1001`,
  enrolments:`WITH ${roster},${windows} SELECT w.period,CAST(DATE_TRUNC(DATE(m.enrolled_at,'Europe/London'),MONTH) AS STRING) month,COUNT(*) observed_enrolments FROM members m JOIN windows w ON DATE(m.enrolled_at,'Europe/London') BETWEEN w.start_date AND w.end_date GROUP BY 1,2 ORDER BY 1,2 LIMIT 1001`,
  purchasing:`${base},customer_period AS(SELECT w.period,w.start_date,w.end_date,o.membership_basis,o.channel,o.currency,month,o.source_customer_id,COUNT(DISTINCT source_order_id) orders,SUM(gross) gross,SUM(retained_refunds) retained_refunds,COUNTIF(gross IS NULL) missing_values FROM selected o JOIN windows w ON DATE(o.created_at,'Europe/London') BETWEEN w.start_date AND w.end_date CROSS JOIN UNNEST(['Full period',CAST(DATE_TRUNC(DATE(o.created_at,'Europe/London'),MONTH) AS STRING)]) month GROUP BY 1,2,3,4,5,6,7,8)
   SELECT period,CAST(start_date AS STRING) start_date,CAST(end_date AS STRING) end_date,membership_basis,channel,currency,month,COUNT(*) purchasing_customers,SUM(orders) eligible_orders,COUNTIF(orders>=2) repeat_purchasers,SAFE_DIVIDE(COUNTIF(orders>=2),COUNT(*)) observed_period_repeat_rate,SAFE_DIVIDE(SUM(orders),COUNT(*)) observed_orders_per_customer,CAST(IF(SUM(missing_values)=0,SUM(gross),NULL) AS STRING) original_order_gross,CAST(IF(SUM(missing_values)=0,SAFE_DIVIDE(SUM(gross),SUM(orders)),NULL) AS STRING) observed_aov,CAST(SUM(retained_refunds) AS STRING) retained_lifetime_refunds FROM customer_period GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,7,4,5,6 LIMIT 1001`,
  cohorts:`${base},currencies AS(SELECT DISTINCT channel,currency FROM selected),cohort AS(SELECT w.period,m.*,d window_days FROM unique_members m JOIN windows w ON DATE(m.enrolled_at,'Europe/London') BETWEEN w.start_date AND w.end_date CROSS JOIN UNNEST([30,90,180]) d WHERE m.enrolled_at IS NOT NULL),customer_windows AS(
   SELECT c.period,c.customer_ref_id,c.enrolled_at,c.window_days,CAST(DATE_TRUNC(DATE(c.enrolled_at,'Europe/London'),MONTH) AS STRING) enrolment_month,g.channel,g.currency,
    COALESCE(TIMESTAMP_ADD(c.enrolled_at,INTERVAL c.window_days DAY)<=TIMESTAMP((SELECT JSON_VALUE(v,'$.end_exclusive') FROM UNNEST(JSON_QUERY_ARRAY(@commerce_cutoffs)) v WHERE JSON_VALUE(v,'$.channel')=g.channel)),FALSE) observation_mature,
    IF(EXISTS(SELECT 1 FROM qualifying_orders p WHERE p.source_customer_id=c.shopify_customer_gid AND p.created_at<c.enrolled_at),'existing_observed_customer','prior_history_unverified') customer_history,
    COUNT(DISTINCT IF(o.created_at<c.enrolled_at,o.source_order_id,NULL)) before_orders,COUNT(DISTINCT IF(o.created_at>=c.enrolled_at,o.source_order_id,NULL)) after_orders
   FROM cohort c CROSS JOIN currencies g LEFT JOIN selected o ON o.source_customer_id=c.shopify_customer_gid AND o.channel=g.channel AND o.currency=g.currency AND o.created_at>=TIMESTAMP_SUB(c.enrolled_at,INTERVAL c.window_days DAY) AND o.created_at<TIMESTAMP_ADD(c.enrolled_at,INTERVAL c.window_days DAY)
   GROUP BY 1,2,3,4,5,6,7,8,9)
   SELECT period,enrolment_month,window_days,channel,currency,customer_history,observation_mature,COUNT(*) cohort_customers,COUNTIF(observation_mature) mature_customers,SUM(before_orders) before_orders,SUM(after_orders) after_orders,COUNTIF(before_orders=0) zero_before_customers,COUNTIF(after_orders=0) zero_after_customers,COUNTIF(after_orders>=1) customers_purchasing_after,MIN(CAST(TIMESTAMP_SUB(enrolled_at,INTERVAL window_days DAY) AS STRING)) required_start_at,MAX(CAST(TIMESTAMP_ADD(enrolled_at,INTERVAL window_days DAY) AS STRING)) required_end_exclusive FROM customer_windows GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,2,3,4,5,6 LIMIT 1001`,
  linkage:`WITH ${roster},${tx},${windows},${orders},classified AS(SELECT w.period,t.transaction_id,CASE WHEN t.shopify_order_gid IS NULL THEN 'no_order_reference' WHEN f.order_id IS NULL THEN 'order_absent' WHEN c.order_id IS NULL THEN 'customer_evidence_missing' WHEN l.order_id IS NULL THEN 'channel_evidence_missing' WHEN l.source_app_id=@matrixify_app_id OR c.source_app_id=@matrixify_app_id THEN 'known_migrated_copy' WHEN c.cancelled_at IS NOT NULL OR f.cancelled_at IS NOT NULL THEN 'cancelled' WHEN c.customer_id IS NULL OR c.customer_id IN ('','0') THEN 'order_customer_missing' WHEN t.shopify_customer_gid IS NULL THEN 'transaction_customer_missing' WHEN t.shopify_customer_gid!=c.customer_id THEN 'customer_mismatch' WHEN o.source_order_id IS NULL THEN 'other_non_qualifying' ELSE 'matched' END outcome FROM tx t JOIN windows w ON DATE(t.created_at,'Europe/London') BETWEEN w.start_date AND w.end_date LEFT JOIN f ON t.shopify_order_gid=f.order_id LEFT JOIN c ON t.shopify_order_gid=c.order_id LEFT JOIN l ON t.shopify_order_gid=l.order_id LEFT JOIN qualifying_orders o ON t.shopify_order_gid=o.source_order_id)
   SELECT period,outcome,COUNT(*) point_records,COUNT(DISTINCT transaction_id) distinct_movements FROM classified GROUP BY 1,2 ORDER BY 1,2 LIMIT 1001`
 };
}
export function commerceCertificates(config){
 const c=config.performance_coverage;
 if(!c)return [];
 if(!c.reviewed_by||!Number.isFinite(Date.parse(c.reviewed_at))||!Array.isArray(c.intervals)||c.intervals.length>100)throw Error('LOYALTY_PERFORMANCE_COVERAGE_INVALID');
 return c.intervals.map(i=>{
  if(!/^\d{4}-\d{2}-\d{2}T/.test(i.start_at||'')||!Number.isFinite(Date.parse(i.start_at))||!Number.isFinite(Date.parse(i.end_exclusive))||Date.parse(i.start_at)>=Date.parse(i.end_exclusive)||!['online','instore','unknown','all'].includes(i.channel)||!i.evidence_reference||i.source!=='shopify')throw Error('LOYALTY_PERFORMANCE_COVERAGE_INVALID');
  return i;
 });
}
export function observationCovered(intervals,start,end,channel){
 let cursor=Date.parse(start),target=Date.parse(end);
 if(!Number.isFinite(cursor)||!Number.isFinite(target)||cursor>=target)return false;
 for(const i of intervals.filter(i=>i.channel==='all'||i.channel===channel).sort((a,b)=>Date.parse(a.start_at)-Date.parse(b.start_at))){const a=Date.parse(i.start_at),b=Date.parse(i.end_exclusive);if(a>cursor)break;if(b>cursor)cursor=b;}return cursor>=target;
}
export function commerceCutoffs(intervals,now){
 return ['online','instore','unknown'].flatMap(channel=>{
  const ends=intervals.filter(i=>i.channel==='all'||i.channel===channel).map(i=>Math.min(Date.parse(i.end_exclusive),Date.parse(now)));
  return ends.length?[{channel,end_exclusive:new Date(Math.max(...ends)).toISOString()}]:[];
 });
}
export function cohortObservation(intervals,row,now){
 const cutoff=commerceCutoffs(intervals,now).find(c=>c.channel===row.channel)?.end_exclusive||null;
 const mature=cutoff?Date.parse(row.required_end_exclusive)<=Date.parse(cutoff):null;
 const certified=Boolean(mature)&&observationCovered(intervals,row.required_start_at,row.required_end_exclusive,row.channel);
 let reason=null;
 if(!cutoff)reason='No verified commerce cutoff for '+row.channel+'; full finance, customer-linkage and channel coverage is uncertified';
 else if(!mature)reason='Immature: required end '+row.required_end_exclusive+' exceeds verified commerce cutoff '+cutoff;
 else if(!certified)reason='Commerce coverage gap in required window '+row.required_start_at+' to '+row.required_end_exclusive+' for '+row.channel;
 if(Number(row.cohort_customers??row.mature_customers)<=0)reason=reason||'No eligible linked customers in cohort';
 return {cutoff,mature,certified:certified&&!reason,reason};
}
export async function readPerformance({context,evidence,bigquery,project,config,options={},now}){
 const windows=performanceWindows(context,now),result={version:1,windows,tables:[],limitations:[...PERFORMANCE_DEFINITIONS],certificates:[]};
 const events=config.performance_events;
 if(events?.reviewed_by&&Number.isFinite(Date.parse(events.reviewed_at))&&Array.isArray(events.windows)&&events.windows.length<=100){
  for(const event of events.windows){if(['May Bank Holiday','Black Friday'].includes(event.name)&&/^\d{4}-\d{2}-\d{2}$/.test(event.start_date||'')&&/^\d{4}-\d{2}-\d{2}$/.test(event.end_date||'')&&event.start_date<=event.end_date&&event.evidence_reference&&windows.some(w=>event.start_date<=w.end_date&&event.end_date>=w.start_date))result.limitations.push('Reviewed promotion context: '+event.name+' '+event.start_date+' to '+event.end_date+'; '+event.evidence_reference+'; no variant or customer participation inferred.');}
 }else result.limitations.push('Actual promotion windows have not been bound to this report; request a reviewed campaign calendar before interpreting seasonal differences.');
 let certs=[];try{certs=commerceCertificates(config).filter(c=>Date.parse(c.start_at)<Date.parse(now)).map(c=>({...c,end_exclusive:new Date(Math.min(Date.parse(c.end_exclusive),Date.parse(now))).toISOString()}));result.certificates=certs;}catch{result.limitations.push('Reviewed commerce coverage invalid; rates requiring it are withheld.');}
 const cutoffs=commerceCutoffs(certs,now);
 result.commerce_cutoffs=cutoffs;
 result.verified_windows=windows.flatMap(w=>certs.flatMap(c=>{
  const requestedStart=Date.parse(options.midnight(w.start_date)),requestedEnd=Date.parse(options.midnight(new Date(Date.parse(w.end_date+'T00:00:00Z')+86400000).toISOString().slice(0,10)));
  const start=Math.max(requestedStart,Date.parse(c.start_at)),end=Math.min(requestedEnd,Date.parse(c.end_exclusive));
  return start<end?[{period:w.label,channel:c.channel,start_at:new Date(start).toISOString(),end_exclusive:new Date(end).toISOString()}]:[];
 }));
 result.snapshot_age_days=Number.isFinite(Date.parse(evidence.snapshot_observed_at))?Math.max(0,(Date.parse(now)-Date.parse(evidence.snapshot_observed_at))/86400000):null;
 if(result.snapshot_age_days===null||result.snapshot_age_days>1)result.limitations.push('Current membership snapshot is '+(result.snapshot_age_days===null?'unavailable':result.snapshot_age_days.toFixed(1)+' days old')+'; current-roster comparisons may be stale. Refresh requires a separate reviewed roster command.');
 const params={commerce_cutoffs:JSON.stringify(cutoffs),program_id:config.program_id,roster_run:(evidence.coverage.windows||[]).find(w=>w.resource==='customers'&&w.status==='complete')?.run_id||evidence.sections.find(s=>s.roster_run)?.roster_run||null,transaction_runs:[...new Set((evidence.coverage.windows||[]).filter(w=>w.resource==='transactions'&&w.status==='complete').map(w=>w.run_id))],as_of:now,windows:JSON.stringify(windows),channel:context.channel,currencies:context.currencies,matrixify_app_id:'gid://shopify/App/1758145'};
 const types={commerce_cutoffs:'STRING',program_id:'STRING',roster_run:'STRING',transaction_runs:['STRING'],as_of:'STRING',windows:'STRING',channel:'STRING',currencies:['STRING'],matrixify_app_id:'STRING'};
 const queries=performanceQueries(project,config.dataset),hooks={signal:options.signal,deadlineAt:options.deadlineAt,maximumMs:15000,onProviderStage:options.onProviderStage,onQueryAllocated:options.onQueryAllocated};
 for(const name of Object.keys(queries)){
  try{
   if(context.loyalty_scope.tier||context.loyalty_scope.tier_basis==='historical'||context.grain&&context.grain!=='month')throw Error('LOYALTY_PERFORMANCE_FILTER_UNSUPPORTED');
   if(!params.roster_run)throw Error('LOYALTY_ROSTER_UNAVAILABLE');
   if(['usage','linkage'].includes(name)&&!params.transaction_runs.length)throw Error('LOYALTY_COVERAGE_UNAVAILABLE');
   if((context.channel||context.currencies.length||context.channel_breakdown)&&['usage','enrolments'].includes(name))throw Error('LOYALTY_SECTION_FILTER_UNSUPPORTED');
   options.onProviderStage?.({stage:'loyalty_performance',section:name,status:'started'});
   const location=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,config.dataset),hooks);
   if(['purchasing','cohorts','linkage'].includes(name)&&await boundedEvidenceRead(()=>datasetLocation(bigquery,project,'shopify_data'),hooks)!==location)throw Error('LOYALTY_REGION_MISMATCH');
   const [raw]=await boundedQuery(bigquery,{query:queries[name],params,types,location,useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000,labels:{component:'oracle_loyalty',operation:'performance_'+name}},hooks);
   if(!Array.isArray(raw)||raw.length>1000)throw Error('LOYALTY_PERFORMANCE_ROW_BOUND');
   const rows=raw.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,v&&typeof v==='object'&&'value'in v?v.value:v])));
   for(const row of rows){
    if(name==='purchasing'){
     let w=windows.find(w=>w.label===row.period);
     if(w&&row.month!=='Full period'&&/^\d{4}-\d{2}-01$/.test(row.month||'')){
      const last=new Date(Date.UTC(Number(row.month.slice(0,4)),Number(row.month.slice(5,7)),0)).toISOString().slice(0,10);
      w={start_date:w.start_date>row.month?w.start_date:row.month,end_date:w.end_date<last?w.end_date:last};
     }
     // Day bounds must account for BST; use London boundaries supplied by caller.
     const certified=w&&observationCovered(certs,options.midnight(w.start_date),options.midnight(new Date(Date.parse(w.end_date+'T00:00:00Z')+86400000).toISOString().slice(0,10)),row.channel);
     if(w){row.start_date=w.start_date;row.end_date=w.end_date;}
     row.certified_commerce_coverage=Boolean(certified);
     row.coverage=certified?'Certified full observation; current-roster grouping':'Observed retained orders; current-roster grouping; history completeness unverified';
    }
    if(name==='cohorts'){
     const assessment=cohortObservation(certs,row,now);
     const certified=assessment.certified;
     row.certified_observation=certified;
     row.cohort_customers??=row.mature_customers;
     row.mature_customers=assessment.mature===null?null:assessment.mature?row.cohort_customers:0;
     row.observation_mature=assessment.mature;
     row.verified_commerce_cutoff=assessment.cutoff;
     row.withheld_reason=assessment.reason;
     const denominator=Number(row.cohort_customers);
     row.subsequent_purchase_rate=certified&&denominator>0?Number(row.customers_purchasing_after)/denominator:null;
     row.before_orders_per_customer=certified&&denominator>0?Number(row.before_orders)/denominator:null;
     row.after_orders_per_customer=certified&&denominator>0?Number(row.after_orders)/denominator:null;
     row.status=certified?'Certified observation; association only':'Partial observed counts; rates withheld';
    }
   }
   for(const row of rows){const issue=performanceRowIssue(name,row,windows);if(issue)throw Object.assign(Error('LOYALTY_PERFORMANCE_ROW_CONTRACT_INVALID'),{code:'LOYALTY_PERFORMANCE_ROW_CONTRACT_INVALID',...issue});}
   result.tables.push({section:name,status:'partial',rows});
   options.onProviderStage?.({stage:'loyalty_performance',section:name,status:'success',aggregate_rows:rows.length});
  }catch(e){const code=/^LOYALTY_[A-Z_]+$/.test(e.code||e.message||'')?(e.code||e.message):'LOYALTY_PERFORMANCE_READ_UNAVAILABLE';result.tables.push({section:name,status:'unavailable',code,rows:[]});options.onProviderStage?.({stage:'loyalty_performance',section:name,status:'failed',code,...(e.code==='LOYALTY_PERFORMANCE_ROW_CONTRACT_INVALID'?{field:OUTPUT_FIELDS[name].includes(e.field)?e.field:'unavailable',category:['non_record','unknown_field','non_scalar','non_finite','string_bound','period_mismatch'].includes(e.category)?e.category:'invalid_contract'}:{})});}
 }
 return result;
}
const MONEY_FIELDS=new Set(['original_order_gross','observed_aov','retained_lifetime_refunds']);
export function excelLoyaltyDecimal(value){
 if(typeof value!=='string'||!/^[-+]?[0-9]+(?:\.[0-9]+)?$/.test(value))return value;
 const canonical=s=>{const negative=s.startsWith('-'),parts=s.replace(/^[-+]/,'').split('.'),whole=parts[0].replace(/^0+(?=.)/,'')||'0',fraction=(parts[1]||'').replace(/0+$/,'');return (negative&&(whole!=='0'||fraction)?'-':'')+whole+(fraction?'.'+fraction:'');};
 const exact=canonical(value),digits=exact.replace(/[-.]/g,'').replace(/^0+/,'').length;
 const number=Number(value);
 if(digits>15||!Number.isFinite(number)||!/^[-+]?[0-9]+(?:\.[0-9]+)?$/.test(String(number))||canonical(String(number))!==exact)return value;
 return number;
}
export function performanceWorkbookTables(e){
 const table=(name,rows)=>{const headers=[...new Set(rows.flatMap(Object.keys))];return {name,headers:headers.length?headers:['status'],rows:rows.length?rows.map(r=>headers.map(k=>MONEY_FIELDS.has(k)?excelLoyaltyDecimal(r[k]??null):r[k]??null)):[['Unavailable; see Coverage']]};};
 const p=e.performance,base=e.sections||[],find=s=>p.tables.find(t=>t.section===s),rows=s=>find(s)?.rows||[];
 const coverage=[{section:'Report',status:'partial',note:'Retained observations, not causal uplift. Missing evidence is never zero.'},...p.windows.map(w=>({section:w.label,status:'requested',note:w.start_date+' to '+w.end_date})),...base.map(s=>({section:s.section,status:s.status,note:s.code||s.definition||''})),...p.tables.map(s=>({section:s.section,status:s.status,note:s.code||(s.section==='cohorts'&&!s.rows.length?'No cohort rows: no uniquely linked enrolments or observed channel/currency populations for this scope; no zero rate inferred':'Observed aggregates; completeness and historical identity limits apply')})),...(e.coverage.windows||[]).map(w=>({section:w.resource,status:w.status,note:w.start_at+' to '+w.end_exclusive,observed_at:w.observed_at,rows:w.row_count})),...p.certificates.map(c=>({section:'Reviewed commerce coverage',status:'reviewed',note:c.start_at+' to '+c.end_exclusive+'; '+c.channel+'; '+c.evidence_reference})),{section:'Actual reward use',status:'unavailable',note:'No verified redemption/cancellation export binding'},{section:'Historical tiers',status:'unavailable',note:'Current tier is not tier-at-order evidence'},{section:'Legacy references',status:'unavailable',note:'WooCommerce order namespaces and governed bridge not established; no heuristic matching'}];
 for(const c of p.verified_windows||[])coverage.push({section:c.period+' actual verified commerce dates',status:'verified interval',note:c.channel+'; '+c.start_at+' to '+c.end_exclusive+' exclusive'});
 coverage.push(...(p.commerce_cutoffs||[]).map(c=>({section:'Latest certified commerce cutoff',status:'verified',note:c.channel+'; exclusive '+c.end_exclusive})));
 if(!p.commerce_cutoffs?.length)coverage.push({section:'Latest certified commerce cutoff',status:'unavailable',note:'No reviewed complete finance/customer/channel interval; observed orders do not certify coverage'});
 const completePoints=(e.coverage.windows||[]).filter(w=>w.resource==='transactions'&&w.status==='complete');
 coverage.push({section:'Latest certified points cutoff',status:completePoints.length?'partial':'unavailable',note:completePoints.map(w=>w.end_exclusive).sort().at(-1)||'No complete points windows; see individual ranges for gaps'});
 const notes=[{definition:'Snapshot age in days (stale after one day)',detail:p.snapshot_age_days??null},{definition:'Report generated',detail:e.as_of},{definition:'Membership snapshot collected',detail:e.snapshot_observed_at},...p.limitations.map(detail=>({definition:'Definition or limitation',detail}))];
 return [table('Read me',notes),table('Coverage',coverage),table('Programme usage',[...rows('usage').map(r=>({measure:'Points movements',...r})),...rows('enrolments').map(r=>({measure:'Observed enrolments in current roster',...r})),...(base.find(s=>s.section==='membership')?.rows||[]).map(r=>({measure:'Current profiles',...r}))]),table('Customer purchasing',rows('purchasing')),table('Enrolment cohorts',rows('cohorts')),table('Rewards and purchasing',(base.find(s=>s.section==='claims')?.rows||[]).map(r=>({...r,actual_use:null,reward_order_value:null,recorded_reward_discount:null,status:'Claim observations only; actual use unavailable'}))),table('Tiers',(base.find(s=>s.section==='tiers')?.rows||[]).map(r=>({...r,basis:'Current roster; historical tiers unavailable'}))),table('Linkage and limitations',rows('linkage'))];
}
const OUTPUT_FIELDS={
 usage:['period','month','resource','point_movements','participants','current_enrolled_participants','positive_net_movements','negative_net_movements','approved_delta','pending_delta','net_delta','observed_claimants'],
 enrolments:['period','month','observed_enrolments'],
 purchasing:['period','start_date','end_date','membership_basis','channel','currency','month','purchasing_customers','eligible_orders','repeat_purchasers','observed_period_repeat_rate','observed_orders_per_customer','original_order_gross','observed_aov','retained_lifetime_refunds','coverage','certified_commerce_coverage'],
 cohorts:['period','enrolment_month','window_days','channel','currency','customer_history','observation_mature','cohort_customers','verified_commerce_cutoff','withheld_reason','mature_customers','before_orders','after_orders','zero_before_customers','zero_after_customers','customers_purchasing_after','required_start_at','required_end_exclusive','certified_observation','subsequent_purchase_rate','before_orders_per_customer','after_orders_per_customer','status'],
 linkage:['period','outcome','point_records','distinct_movements']
};
function performanceRowIssue(section,row,windows){
 if(!row||typeof row!=='object'||Array.isArray(row))return {field:'unavailable',category:'non_record'};
 for(const [field,value]of Object.entries(row)){
  if(!OUTPUT_FIELDS[section].includes(field))return {field:'unavailable',category:'unknown_field'};
  if(value!=null&&typeof value==='object')return {field,category:'non_scalar'};
  if(typeof value==='number'&&!Number.isFinite(value))return {field,category:'non_finite'};
  if(typeof value==='string'&&value.length>300)return {field,category:'string_bound'};
 }
 if(!windows.some(w=>w.label===row.period))return {field:'period',category:'period_mismatch'};
 return null;
}
export function assertPerformanceEvidence(context,e){
 const fail=()=>{throw Object.assign(Error('EVIDENCE_SCOPE_MISMATCH'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});};
 const p=e.performance;
 if(context.loyalty_scope.report_kind!=='performance'||p?.version!==1||!Array.isArray(p.tables)||p.tables.length!==5||stableAnalyticalJSON(p.windows)!==stableAnalyticalJSON(performanceWindows(context,e.as_of)))fail();
 for(const section of Object.keys(OUTPUT_FIELDS)){
  const tables=p.tables.filter(t=>t.section===section);if(tables.length!==1)fail();const t=tables[0];
  if(!['partial','unavailable'].includes(t.status)||!Array.isArray(t.rows)||t.rows.length>1000||t.status==='unavailable'&&t.rows.length)fail();
  for(const row of t.rows)if(performanceRowIssue(section,row,p.windows))fail();
 }
 return true;
}
