import { createHash } from 'node:crypto';
import { reportWorkbook } from './report-export.js';
import { priorityArtifactId } from './product-priority-storage.js';
import { withOracleCharts } from './evidence-charts.js';
import { resolveAnalyticalPlan, assertPlanAgreement, stableAnalyticalJSON } from './analytical-plan.js';
import { DAILY_SALES_CONTRACT } from './daily-sales-provider.js';
import { relevantSalesEvent } from './sales-context.js';
import { evidenceNumber as finite } from './numeric-evidence.js';

const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const dayIndex=date=>(new Date(`${date}T00:00:00Z`).getUTCDay()+6)%7;
const scalar=value=>value?.value??value;
const esc=value=>String(value??'Unavailable').replaceAll('|','\\|').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/[\r\n]/g,' ');
const n=value=>value==null?'Unavailable':Number(value).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(value,currency)=>value==null?'Unavailable':`${currency} ${n(value)}`;
const datesIn=period=>{const dates=[];for(let d=Date.parse(`${period.start_date}T00:00:00Z`);d<=Date.parse(`${period.end_date}T00:00:00Z`);d+=86400000)dates.push(new Date(d).toISOString().slice(0,10));return dates;};

export function resolvePromotionDates(response,request,period) {
  if(!request||request.treatment==='include')return {status:'not_requested',events:[],dates:[]};
  if(request.supplied_periods?.length){const events=request.supplied_periods.map((p,i)=>({id:`user-supplied-${i}`,title:request.query,effective_from:p.start_date,effective_to:p.end_date,source_type:'human_entered',source_reference:'User-supplied confirmed sale dates'}));return {status:'confirmed',events,dates:datesIn(period).filter(d=>events.some(e=>d>=e.effective_from&&d<=e.effective_to))};}
  if(!response||response.limited||response.truncated||response.has_more||response.items?.length>=50)return {status:'unavailable',events:[],dates:[]};
  const words=request.query.toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>!['the','sale','promotion'].includes(w));
  const matching=(response.items||[]).map(e=>({...e,effective_from:scalar(e.effective_from),effective_to:scalar(e.effective_to)})).filter(e=>words.every(word=>`${e.title||''} ${e.description||''} ${(e.tags||[]).join(' ')}`.toLowerCase().includes(word)));
  // An imprecise/working matching phase prevents a claim of complete exclusions.
  if(!matching.length||matching.some(e=>!relevantSalesEvent(e,[period],{onlineOnly:true})||!['day','range'].includes(e.date_precision)))return {status:'unavailable',events:[],dates:[]};
  const events=matching.map(e=>({...e,effective_from:scalar(e.effective_from),effective_to:scalar(e.effective_to)||(e.date_precision==='day'?scalar(e.effective_from):null)}));
  if(events.some(e=>!/^\d{4}-\d{2}-\d{2}$/.test(e.effective_from)||!/^\d{4}-\d{2}-\d{2}$/.test(e.effective_to)||e.effective_to<e.effective_from))return {status:'unavailable',events:[],dates:[]};
  return {status:'confirmed',events,dates:datesIn(period).filter(d=>events.some(e=>d>=e.effective_from&&d<=e.effective_to))};
}

/** Every displayed figure is derived once from validated daily rows and exact exclusions. */
export function aggregateWeekdaySales(daily,period,promotion) {
  const expected=datesIn(period),excluded=new Set(promotion.dates),byDate=new Map();
  for(const row of daily.rows||[]){
    const date=scalar(row.date),sales=finite(row.net_sales),orders=finite(row.orders);
    if(!expected.includes(date)||byDate.has(date))throw Object.assign(Error('Daily identity outside plan or duplicated'),{code:'EVIDENCE_SCOPE_MISMATCH'});
    // Explicit zeros still require complete daily evidence. Never manufacture missing days.
    if(sales==null&&orders==null||orders!=null&&(orders<0||!Number.isInteger(orders))||(sales===0||sales==null)&&(orders===0||orders==null)&&row.complete!==true)continue;
    byDate.set(date,{date,net_sales:sales,orders,complete:row.complete===true&&sales!=null&&orders!=null});
  }
  const rows=DAYS.map((weekday,index)=>{
    const included=[...byDate.values()].filter(r=>dayIndex(r.date)===index),adjusted=promotion.status==='confirmed'?included.filter(r=>!excluded.has(r.date)):promotion.status==='not_requested'?included:null;
    const sum=(a,key)=>a?.length&&!a.some(r=>r[key]==null)?a.reduce((total,r)=>total+r[key],0):null;
    const sales=sum(included,'net_sales'),orders=sum(included,'orders'),adjustedSales=sum(adjusted,'net_sales'),adjustedOrders=sum(adjusted,'orders');
    return {weekday,included_days:included.length,expected_days:expected.filter(d=>dayIndex(d)===index).length,orders,total_sales:sales,average_sales_per_day:included.length&&sales!=null?sales/included.length:null,average_orders_per_day:included.length&&orders!=null?orders/included.length:null,sale_excluded_days:adjusted?.length??null,sale_excluded_orders:adjustedOrders,sale_excluded_total_sales:adjustedSales,average_sales_per_day_excluding_sale:adjusted?.length&&adjustedSales!=null?adjustedSales/adjusted.length:null,average_orders_per_day_excluding_sale:adjusted?.length&&adjustedOrders!=null?adjustedOrders/adjusted.length:null};
  });
  return {rows,source_rows:[...byDate.values()],coverage:{covered_days:byDate.size,expected_days:expected.length,complete:byDate.size===expected.length&&[...byDate.values()].every(r=>r.complete),missing_dates:expected.filter(d=>!byDate.has(d))}};
}
export function weekdayBusinessView(e) {
  const rows=e.rows||[],metric=e.ranking_metric==='average_orders_per_day'?'average_orders_per_day':'average_sales_per_day',best=[...rows].filter(r=>r[metric]!=null).sort((a,b)=>e.ranking_direction==='asc'?a[metric]-b[metric]:b[metric]-a[metric])[0];
  const lines=[best?`${best.weekday} has the ${e.ranking_direction==='asc'?'lowest':'highest'} average ${metric==='average_orders_per_day'?'orders':'net sales'} per covered day: ${metric==='average_orders_per_day'?n(best[metric]):money(best[metric],e.currency)}${e.coverage?.complete?'': ' (provisional)'}.`:'Weekday sales are unavailable for this scope.',`Shopify Online Store · ${esc(e.currency)} · ${e.periods[0].start_date} to ${e.periods[0].end_date}. Completed days; runtime cutoff ${e.cutoff_date} (Europe/London).`];
  if(rows.length)lines.push(['| Weekday | Included days | Orders | Total net sales | Average net sales/day | Average net sales/day excluding sale |','|---|---:|---:|---:|---:|---:|',...rows.map(r=>`| ${r.weekday} | ${r.included_days} | ${n(r.orders)} | ${money(r.total_sales,e.currency)} | ${money(r.average_sales_per_day,e.currency)} | ${e.promotion.status==='not_requested'?'Not requested':money(r.average_sales_per_day_excluding_sale,e.currency)} |`)].join('\n'));
  if(e.ranking_metric==='average_orders_per_day'&&rows.length)lines.push(['| Weekday | Average orders/day | Average orders/day excluding sale |','|---|---:|---:|',...rows.map(r=>`| ${r.weekday} | ${n(r.average_orders_per_day)} | ${e.promotion.status==='not_requested'?'Not requested':n(r.average_orders_per_day_excluding_sale)} |`)].join('\n'));
  lines.push(`Covered ${e.coverage.covered_days}/${e.coverage.expected_days} expected days. ${e.coverage.complete?'Complete eligible daily evidence.':'Incomplete or unverified coverage; missing days are excluded from the averages, so weekday rankings are provisional.'}`);
  if(e.promotion.status==='confirmed')lines.push(`The second average excludes confirmed sale dates${e.promotion.events.some(x=>/early access/i.test(x.title||''))?', including documented early access':''}: ${e.promotion.events.map(x=>`${esc(x.title)} (${x.effective_from} to ${x.effective_to})`).join('; ')}. The original window remains unchanged. This comparison does not establish promotion-caused uplift.`);
  if(e.promotion.status==='unavailable')lines.push('Confirmed sale dates could not be established; the adjusted comparison is unavailable. Supply the confirmed dates to enable that comparison.');
  lines.push(...(e.limitations||[]));
  return lines;
}
function chartDatasets(e) {
  const metric=e.ranking_metric,orders=metric==='average_orders_per_day',adjusted=orders?'average_orders_per_day_excluding_sale':'average_sales_per_day_excluding_sale';
  return [{id:'weekday-sales',shape:e.promotion.status==='confirmed'?'comparison':'ranking',compatible:true,title:orders?'Average orders by weekday':'Average net sales by weekday',metric,direction:e.ranking_direction,unit:orders?'count':'money',period:`${e.periods[0].start_date} to ${e.periods[0].end_date}`,definition:e.definitions[orders?'orders':'net_sales']+' / covered eligible days; provisional when coverage is incomplete.',source:'ShopifyQL sales',population:e.source_store,category_order:DAYS,points:e.rows.flatMap(r=>[{label:r.weekday,series:'All included days',value:r[metric],currency:e.currency},...(e.promotion.status==='confirmed'?[{label:r.weekday,series:'Excluding confirmed sale',value:r[adjusted],currency:e.currency}]:[])])}];
}
export async function answerWeekdaySales({context,provider,knowledgeService,exportStore,exportOwner,requestId,onEvidence,onProviderStage,now=()=>new Date()}) {
  const period={start_date:context.start_date,end_date:context.end_date};
  if(!period.start_date||period.start_date>period.end_date)throw Object.assign(Error('No completed days in the requested range'),{code:'NO_COMPLETED_DAYS'});
  const args={...period,platform:context.platform,source_store:context.source_store,channel:context.channel,currencies:context.currencies,reporting_timezone:context.time_zone};
  const queries=[Promise.resolve().then(()=>{if(!provider)throw Error('Daily sales unavailable');return provider(args);}),Promise.resolve().then(()=>context.promotion_context?.treatment==='compare_excluding'&&knowledgeService?knowledgeService.getBusinessContext({...period,topics:['online','sales','promotion','campaign']}):null)];
  const [retrieval,events]=await Promise.allSettled(queries);
  const daily=retrieval.status==='fulfilled'?retrieval.value:null,limitations=[];
  let valid=Boolean(daily);
  if(!daily)limitations.push('Daily online sales retrieval failed or is unavailable. Monthly figures cannot establish weekday sales.');
  else if(daily.grain!=='day'||daily.platform!=='shopify'||daily.channel!=='online'||daily.period?.start_date!==period.start_date||daily.period?.end_date!==period.end_date||context.source_store&&daily.source_store&&daily.source_store!==context.source_store||context.currencies.length&&daily.currency&&!context.currencies.includes(daily.currency))throw Object.assign(Error('Daily provider scope differs from plan'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  else if(!daily.source_store||!daily.currency){valid=false;limitations.push('Shop identity or currency metadata is unavailable; retrieved daily rows are retained in details without an unverifiable financial ranking.');}
  else if(daily.reporting_timezone!==context.time_zone||daily.timezone_semantics!==DAILY_SALES_CONTRACT.timezone_semantics){valid=false;limitations.push('Daily reporting timezone is unverified or differs from Europe/London. Weekday grouping in the requested timezone is unavailable; daily aggregates cannot be re-zoned.');}
  const promotion=resolvePromotionDates(events.status==='fulfilled'?events.value:null,context.promotion_context,period),aggregation=aggregateWeekdaySales(valid?daily:{rows:[]},period,promotion);
  const resolvedContext=valid?{...context,source_store:daily.source_store,currencies:context.currencies.length?context.currencies:[daily.currency]}:context;
  const evidence={kind:'governed_weekday_sales',subject:'sales',metrics:['sales'],dimensions:['weekday'],grain:'day',analytical_plan:resolveAnalyticalPlan(resolvedContext),periods:[period],cutoff_date:context.date_cutoff,time_zone:context.time_zone,channel:'online',platform:'shopify',source_store:daily?.source_store||null,currency:daily?.currency||null,definitions:DAILY_SALES_CONTRACT.definitions,ranking_metric:context.ranking_metric,ranking_direction:context.ranking_direction,promotion,applied_exclusions:promotion.dates,...aggregation,limitations,retrieval_failed:!valid,retrieval:[{component:'daily_sales',status:retrieval.status,...(retrieval.status==='rejected'?{code:retrieval.reason?.code||'DAILY_SALES_UNAVAILABLE'}:{})},{component:'promotion',status:events.status}],retrieved_daily_rows:daily?.rows||[],source_collected_at:daily?.source_collected_at||null,generated_at:new Date(now()).toISOString()};
  evidence.chart_datasets=chartDatasets(evidence);
  const analysis_context=promotion.status==='unavailable'&&resolvedContext.promotion_context?{...resolvedContext,promotion_context:{...resolvedContext.promotion_context,pending_dates:true}}:resolvedContext;
  let result=withOracleCharts({analysis_context,answer:weekdayBusinessView(evidence).join('\n\n'),tools:['get_shopify_sales_kpis',...(context.promotion_context?['get_business_context']:[])],evidence});
  // Successful retrieval survives optional XLSX/final-delivery failures.
  onProviderStage?.({stage:'daily_sales_validation',status:valid?'success':'unavailable'});
  await onEvidence?.(result);
  if(context.output_preference==='xlsx'){
    if(!exportStore||!exportOwner||!requestId){result.answer+='\n\nExport storage is unavailable; retrieved figures are retained.';return result;}
    const id=priorityArtifactId(exportOwner,requestId);
    try{
    const saved=await exportStore.get(id,exportOwner);
    if(saved){assertPlanAgreement(analysis_context,saved.envelope);assertWeekdayEvidence(analysis_context,saved.envelope);return {...result,answer:saved.answer,evidence:saved.envelope,artifact:{id,filename:saved.filename,row_count:saved.envelope.rows.length,download_url:`/api/oracle/exports/${id}`}};}
      const bytes=Buffer.from(await reportWorkbook({generated_at:evidence.generated_at,period,comparison:period,trend:evidence.rows.map(r=>({source_store:evidence.source_store,currency:evidence.currency,...r})),context:promotion.events.map(e=>({id:e.id,title:e.title,start:e.effective_from,end:e.effective_to,source_reference:e.source_reference})),limitations:[...limitations,JSON.stringify(evidence.coverage),JSON.stringify(evidence.definitions)]})),filename='oracle-weekday-sales.xlsx';
      await exportStore.put(id,exportOwner,{answer:result.answer,analysis_context,envelope:result.evidence,filename,sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')});
      result={...result,artifact:{id,filename,row_count:evidence.rows.length,download_url:`/api/oracle/exports/${id}`}};
      await onEvidence?.(result);
    }catch(error){if(error.code==='EVIDENCE_SCOPE_MISMATCH')throw error;result.answer+='\n\nThe spreadsheet could not be saved. Retrieved figures are retained; retry the export explicitly.';}
  }
  return result;
}

export function assertWeekdayEvidence(context,e) {
  if(e.kind!=='governed_weekday_sales'||e.channel!=='online'||e.platform!=='shopify'||e.grain!=='day'||stableAnalyticalJSON(e.dimensions)!==stableAnalyticalJSON(context.dimensions)||e.time_zone!==context.time_zone||e.ranking_metric!==context.ranking_metric||e.ranking_direction!==context.ranking_direction||e.periods?.length!==1||e.periods[0].start_date!==context.start_date||e.periods[0].end_date!==context.end_date)throw Object.assign(Error('Weekday evidence scope differs from plan'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  const promotion=resolvePromotionDates({items:e.promotion?.events||[]},context.promotion_context,e.periods[0]);
  if(e.promotion?.status==='confirmed'&&(stableAnalyticalJSON(promotion.dates)!==stableAnalyticalJSON(e.applied_exclusions)||stableAnalyticalJSON(promotion.dates)!==stableAnalyticalJSON(e.promotion.dates)))throw Object.assign(Error('Recovered promotion exclusions disagree'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(!e.retrieval_failed&&(!e.source_store||!e.currency||context.source_store&&e.source_store!==context.source_store||context.currencies.length&&!context.currencies.includes(e.currency)))throw Object.assign(Error('Recovered daily source or currency differs'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(stableAnalyticalJSON(e.definitions)!==stableAnalyticalJSON(DAILY_SALES_CONTRACT.definitions))throw Object.assign(Error('Recovered metric definitions differ'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  const charts=withOracleCharts({answer:'',evidence:{...e,chart_specs:undefined,chart_datasets:chartDatasets(e)}}).charts;
  if(e.chart_specs&&stableAnalyticalJSON(charts)!==stableAnalyticalJSON(e.chart_specs))throw Object.assign(Error('Recovered chart differs from validated facts'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(!e.retrieval_failed&&stableAnalyticalJSON(aggregateWeekdaySales({rows:e.retrieved_daily_rows||[]},e.periods[0],e.promotion).source_rows)!==stableAnalyticalJSON(e.source_rows))throw Object.assign(Error('Recovered eligible population differs from retrieved daily rows'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  const aggregation=aggregateWeekdaySales({rows:e.source_rows||[]},e.periods[0],e.promotion);
  if(stableAnalyticalJSON(aggregation.rows)!==stableAnalyticalJSON(e.rows)||stableAnalyticalJSON(aggregation.coverage)!==stableAnalyticalJSON(e.coverage))throw Object.assign(Error('Recovered weekday figures disagree with daily evidence'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  return true;
}
