import { createHash } from 'node:crypto';
import { reportWorkbook } from './report-export.js';
import { priorityArtifactId } from './product-priority-storage.js';
import { withOracleCharts } from './evidence-charts.js';
import { resolveAnalyticalPlan, assertPlanAgreement, stableAnalyticalJSON } from './analytical-plan.js';
import { DAILY_SALES_CONTRACT } from './daily-sales-provider.js';
import { resolvePromotionDates, retrievePromotionContext } from './promotion-context.js';
export { resolvePromotionDates } from './promotion-context.js';
import { evidenceNumber as finite } from './numeric-evidence.js';

const DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const dayIndex=date=>(new Date(`${date}T00:00:00Z`).getUTCDay()+6)%7;
const scalar=value=>value?.value??value;
const esc=value=>String(value??'Unavailable').replaceAll('|','\\|').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/[\r\n]/g,' ');
const n=value=>value==null?'Unavailable':Number(value).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(value,currency)=>value==null?'Unavailable':`${currency} ${n(value)}`;
const datesIn=period=>{const dates=[];for(let d=Date.parse(`${period.start_date}T00:00:00Z`);d<=Date.parse(`${period.end_date}T00:00:00Z`);d+=86400000)dates.push(new Date(d).toISOString().slice(0,10));return dates;};

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
  return {rows,source_rows:[...byDate.values()],coverage:{covered_days:byDate.size,expected_days:expected.length,complete:byDate.size===expected.length&&[...byDate.values()].every(r=>r.complete),missing_dates:expected.filter(d=>!byDate.has(d)),observed_days:new Set((daily.rows||[]).map(r=>scalar(r.date))).size,observed_missing_dates:expected.filter(d=>!(daily.rows||[]).some(r=>scalar(r.date)===d))}};
}
export function weekdayBusinessView(e) {
  const rows=e.rows||[],orders=e.ranking_metric==='average_orders_per_day',baseMetric=orders?'average_orders_per_day':'average_sales_per_day',metric=e.promotion.status==='confirmed'?baseMetric+'_excluding_sale':baseMetric,best=[...rows].filter(r=>r[metric]!=null).sort((a,b)=>e.ranking_direction==='asc'?a[metric]-b[metric]:b[metric]-a[metric])[0];
  const lines=[best?`${best.weekday} has the ${e.ranking_direction==='asc'?'lowest':'highest'} average ${orders?'orders':'net sales'} ${e.promotion.status==='confirmed'?'after sale exclusions per eligible day':'per covered day'}: ${orders?n(best[metric]):money(best[metric],e.currency)}${e.coverage?.complete?'': ' (provisional)'}.`:'Weekday sales are unavailable for this scope.',`Shopify Online Store · ${esc(e.currency)} · ${e.periods[0].start_date} to ${e.periods[0].end_date}. Completed days; runtime cutoff ${e.cutoff_date} (Europe/London).`];
  if(rows.length)lines.push(['| Weekday | Included days | Orders | Total net sales | Average net sales/day | Days excluding sale | Net sales excluding sale | Average net sales/day excluding sale |','|---|---:|---:|---:|---:|---:|---:|---:|',...rows.map(r=>`| ${r.weekday} | ${r.included_days} | ${n(r.orders)} | ${money(r.total_sales,e.currency)} | ${money(r.average_sales_per_day,e.currency)} | ${e.promotion.status==='not_requested'?'Not requested':n(r.sale_excluded_days)} | ${e.promotion.status==='not_requested'?'Not requested':money(r.sale_excluded_total_sales,e.currency)} | ${e.promotion.status==='not_requested'?'Not requested':money(r.average_sales_per_day_excluding_sale,e.currency)} |`)].join('\n'));
  if(e.ranking_metric==='average_orders_per_day'&&rows.length)lines.push(['| Weekday | Average orders/day | Average orders/day excluding sale |','|---|---:|---:|',...rows.map(r=>`| ${r.weekday} | ${n(r.average_orders_per_day)} | ${e.promotion.status==='not_requested'?'Not requested':n(r.average_orders_per_day_excluding_sale)} |`)].join('\n'));
  lines.push(`Observed daily rows: ${e.coverage.observed_days??e.coverage.covered_days}/${e.coverage.expected_days} expected dates. ${e.coverage.complete?'Verified complete eligible daily population.':(e.coverage.observed_missing_dates?.length??e.coverage.missing_dates.length)?'Some expected dates have no observed daily row; population completeness is unverified.':'All expected dates are represented; population completeness is unverified.'} Eligible days used: ${e.coverage.covered_days}. ${e.coverage.complete?'':'Weekday rankings are provisional.'}`);
  if(e.promotion.comparison_treatment==='user_selected_calendar_days')lines.push(`The comparison excludes your selected inclusive calendar days: ${e.promotion.events.map(x=>`${x.effective_from} to ${x.effective_to}`).join('; ')}. This is a request-scoped analytical instruction; the stored promotion wording and historical timestamp interpretation are unchanged. Whole affected Europe/London days are excluded from overall online sales, not discounted-item sales or causal promotional uplift.`,...e.promotion.source_events.map(x=>`Confirmed event provenance: ${esc(x.title)} · ${esc(x.id)} · source ${esc(x.source_reference)}.`));
  else if(e.promotion.status==='confirmed')lines.push(`The second average excludes confirmed sale dates${e.promotion.events.some(x=>/early access/i.test(x.title||''))?', including documented early access':''}: ${e.promotion.events.map(x=>`${esc(x.title)} (${x.effective_from} to ${x.effective_to})`).join('; ')}. The original window remains unchanged. Whole affected Europe/London days are excluded from overall online sales; this is not discounted-item sales or causal promotional uplift.`);
  if(e.promotion.knowledge_conflict)lines.push('The retained knowledge records have conflicting temporal evidence. Your calendar-day comparison is applied independently; no historical conflict has been resolved.');
  if(!['confirmed','not_requested'].includes(e.promotion.status))lines.push(({retrieval_failed:'Governed promotion knowledge retrieval failed or was incomplete.',no_matching_confirmed_record:'No matching confirmed online promotion record overlaps this period.',temporal_unresolved:'A matching confirmed promotion was retrieved, but its temporal interpretation is unresolved.',conflict:'Matching confirmed promotion records conflict; no exclusion interval was selected.'})[e.promotion.status]+' The adjusted comparison is unavailable. '+(e.promotion.clarification||'Successful unadjusted sales are retained.'));
  if(e.promotion.status==='temporal_unresolved'||e.promotion.status==='conflict')lines.push(...e.promotion.events.map(x=>`${esc(x.title)} · ${esc(x.id)} · ${x.interpretation?.phases.map(p=>`${p.phase.toUpperCase()} access ${p.start_date}`).join('; ')||'Dates require validation'} · source ${esc(x.source_reference)}.`));
  lines.push(...(e.promotion.events||[]).flatMap(x=>[x.interpretation?.disclosure].filter(Boolean)));
  lines.push(...(e.limitations||[]));
  return lines;
}
function chartDatasets(e) {
  const metric=e.ranking_metric,orders=metric==='average_orders_per_day',adjusted=orders?'average_orders_per_day_excluding_sale':'average_sales_per_day_excluding_sale';
  return [{id:'weekday-sales',shape:e.promotion.status==='confirmed'?'comparison':'ranking',compatible:true,title:orders?'Average orders by weekday':'Average net sales by weekday',metric,direction:e.ranking_direction,unit:orders?'count':'money',period:`${e.periods[0].start_date} to ${e.periods[0].end_date}`,definition:e.definitions[orders?'orders':'net_sales']+' / covered eligible days; provisional when coverage is incomplete.',source:'ShopifyQL sales',population:e.source_store,category_order:DAYS,points:e.rows.flatMap(r=>[{label:r.weekday,series:'All included days',value:r[metric],currency:e.currency},...(e.promotion.status==='confirmed'?[{label:r.weekday,series:e.promotion.comparison_treatment==='user_selected_calendar_days'?'Excluding selected sale days':'Excluding confirmed sale',value:r[adjusted],currency:e.currency}]:[])])}];
}
export function compatibleClarificationEvidence(prior,context){
  if(!prior?.analysis_context||prior.evidence?.kind!=='governed_weekday_sales'||prior.evidence.retrieval_failed||!context.promotion_context?.calendar_instruction&&!context.promotion_context?.endpoint_choice&&!context.promotion_context?.endpoint_zone)return null;
  try{
    assertPlanAgreement(prior.analysis_context,prior.evidence);assertWeekdayEvidence(prior.analysis_context,prior.evidence);
    const projection=c=>{const p=resolveAnalyticalPlan(c);delete p.promotion;delete p.presentation;delete p.pending;delete p.ranking;return p;};
    if(stableAnalyticalJSON(projection(prior.analysis_context))!==stableAnalyticalJSON(projection(context)))return null;
    return prior;
  }catch{return null;}
}
function snapshotDaily(prior){const e=prior.evidence;return {grain:e.grain,platform:e.platform,channel:e.channel,period:e.periods[0],source_store:e.source_store,currency:e.currency,reporting_timezone:e.time_zone,timezone_semantics:DAILY_SALES_CONTRACT.timezone_semantics,rows:e.retrieved_daily_rows,source_collected_at:e.source_collected_at};}
export async function answerWeekdaySales({context,provider,knowledgeService,recentEvidence,exportStore,exportOwner,requestId,onEvidence,onProviderStage,now=()=>new Date()}) {
  const period={start_date:context.start_date,end_date:context.end_date};
  if(!period.start_date||period.start_date>period.end_date)throw Object.assign(Error('No completed days in the requested range'),{code:'NO_COMPLETED_DAYS'});
  const args={...period,platform:context.platform,source_store:context.source_store,channel:context.channel,currencies:context.currencies,reporting_timezone:context.time_zone};
  const retained=compatibleClarificationEvidence(recentEvidence,context);
  const queries=[Promise.resolve().then(()=>{if(retained)return snapshotDaily(retained);if(!provider)throw Error('Daily sales unavailable');return provider(args);}),Promise.resolve().then(()=>context.promotion_context?.treatment==='compare_excluding'&&knowledgeService?retrievePromotionContext(knowledgeService,context.promotion_context,period):null)];
  const [retrieval,events]=await Promise.allSettled(queries);
  const daily=retrieval.status==='fulfilled'?retrieval.value:null,limitations=[];
  let valid=Boolean(daily);
  if(!daily)limitations.push('Daily online sales retrieval failed or is unavailable. Monthly figures cannot establish weekday sales.');
  else if(daily.grain!=='day'||daily.platform!=='shopify'||daily.channel!=='online'||daily.period?.start_date!==period.start_date||daily.period?.end_date!==period.end_date||context.source_store&&daily.source_store&&daily.source_store!==context.source_store||context.currencies.length&&daily.currency&&!context.currencies.includes(daily.currency))throw Object.assign(Error('Daily provider scope differs from plan'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  else if(!daily.source_store||!daily.currency){valid=false;limitations.push('Shop identity or currency metadata is unavailable; retrieved daily rows are retained in details without an unverifiable financial ranking.');}
  else if(daily.reporting_timezone!==context.time_zone||daily.timezone_semantics!==DAILY_SALES_CONTRACT.timezone_semantics){valid=false;limitations.push('Daily reporting timezone is unverified or differs from Europe/London. Weekday grouping in the requested timezone is unavailable; daily aggregates cannot be re-zoned.');}
  const promotionSource=events.status==='fulfilled'?events.value:retained?.evidence.promotion_source||null;
  const promotion=resolvePromotionDates(promotionSource,context.promotion_context,period),aggregation=aggregateWeekdaySales(valid?daily:{rows:[]},period,promotion);
  const resolvedContext=valid?{...context,source_store:daily.source_store,currencies:context.currencies.length?context.currencies:[daily.currency]}:context;
  const evidence={kind:'governed_weekday_sales',subject:'sales',metrics:['sales'],dimensions:['weekday'],grain:'day',analytical_plan:resolveAnalyticalPlan(resolvedContext),periods:[period],cutoff_date:context.date_cutoff,time_zone:context.time_zone,channel:'online',platform:'shopify',source_store:daily?.source_store||null,currency:daily?.currency||null,definitions:DAILY_SALES_CONTRACT.definitions,ranking_metric:context.ranking_metric,ranking_direction:context.ranking_direction,promotion,promotion_source:promotionSource,applied_exclusions:promotion.dates,...aggregation,limitations,retrieval_failed:!valid,retrieval:[{component:'daily_sales',status:retrieval.status,...(retrieval.status==='rejected'?{code:retrieval.reason?.code||'DAILY_SALES_UNAVAILABLE'}:{})},{component:'promotion',status:events.status}],...(retained?{retained_daily_evidence:true}:{}),retrieved_daily_rows:daily?.rows||[],source_collected_at:daily?.source_collected_at||null,generated_at:new Date(now()).toISOString()};
  evidence.chart_datasets=chartDatasets(evidence);
  const analysis_context=!['confirmed','not_requested'].includes(promotion.status)&&resolvedContext.promotion_context?{...resolvedContext,promotion_context:{...resolvedContext.promotion_context,pending_dates:true,pending_endpoint_date:promotion.events.find(e=>e.interpretation?.endpoint_options)?.interpretation.established_end_date||null,pending_endpoint:promotion.status==='temporal_unresolved'&&Boolean(promotion.events.some(e=>e.interpretation?.endpoint_options))}}:resolvedContext;
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
      const bytes=Buffer.from(await reportWorkbook({generated_at:evidence.generated_at,period,comparison:period,trend:evidence.rows.map(r=>({source_store:evidence.source_store,currency:evidence.currency,...r})),context:[...promotion.events,...(promotion.source_events||[])].map(e=>({id:e.id,title:e.title,start:e.effective_from,end:e.effective_to,source_reference:e.source_reference,interpretation:JSON.stringify(e.interpretation||null)})),limitations:[...limitations,JSON.stringify(evidence.coverage),JSON.stringify(evidence.definitions),JSON.stringify(promotion),'Whole affected Europe/London days are excluded from overall online sales, not discounted-item sales or causal uplift.']})),filename='oracle-weekday-sales.xlsx';
      await exportStore.put(id,exportOwner,{answer:result.answer,analysis_context,envelope:result.evidence,filename,sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')});
      result={...result,artifact:{id,filename,row_count:evidence.rows.length,download_url:`/api/oracle/exports/${id}`}};
      await onEvidence?.(result);
    }catch(error){if(error.code==='EVIDENCE_SCOPE_MISMATCH')throw error;result.answer+='\n\nThe spreadsheet could not be saved. Retrieved figures are retained; retry the export explicitly.';}
  }
  return result;
}

export function assertWeekdayEvidence(context,e) {
  if(e.kind!=='governed_weekday_sales'||e.channel!=='online'||e.platform!=='shopify'||e.grain!=='day'||stableAnalyticalJSON(e.dimensions)!==stableAnalyticalJSON(context.dimensions)||e.time_zone!==context.time_zone||e.ranking_metric!==context.ranking_metric||e.ranking_direction!==context.ranking_direction||e.periods?.length!==1||e.periods[0].start_date!==context.start_date||e.periods[0].end_date!==context.end_date)throw Object.assign(Error('Weekday evidence scope differs from plan'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  const legacy=!Object.hasOwn(e,'promotion_source')&&!e.promotion?.events?.some(x=>x.interpretation);
  const promotion=resolvePromotionDates(legacy?{items:e.promotion?.events||[]}:e.promotion_source,context.promotion_context,e.periods[0]);
  const promotionAgrees=legacy?(e.promotion?.status==='confirmed'?promotion.status==='confirmed'&&stableAnalyticalJSON(promotion.dates)===stableAnalyticalJSON(e.promotion.dates):(e.promotion?.status==='not_requested'?promotion.status==='not_requested':e.promotion?.status==='unavailable'&&context.promotion_context?.treatment==='compare_excluding')&&!e.promotion.dates?.length):stableAnalyticalJSON(promotion)===stableAnalyticalJSON(e.promotion);
  if(!promotionAgrees||stableAnalyticalJSON(legacy?e.promotion.dates:promotion.dates)!==stableAnalyticalJSON(e.applied_exclusions))throw Object.assign(Error('Recovered promotion exclusions disagree'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(!e.retrieval_failed&&(!e.source_store||!e.currency||context.source_store&&e.source_store!==context.source_store||context.currencies.length&&!context.currencies.includes(e.currency)))throw Object.assign(Error('Recovered daily source or currency differs'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(stableAnalyticalJSON(e.definitions)!==stableAnalyticalJSON(DAILY_SALES_CONTRACT.definitions))throw Object.assign(Error('Recovered metric definitions differ'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  const charts=withOracleCharts({answer:'',evidence:{...e,chart_specs:undefined,chart_datasets:chartDatasets(e)}}).charts;
  if(e.chart_specs&&stableAnalyticalJSON(charts)!==stableAnalyticalJSON(e.chart_specs))throw Object.assign(Error('Recovered chart differs from validated facts'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  if(!e.retrieval_failed&&stableAnalyticalJSON(aggregateWeekdaySales({rows:e.retrieved_daily_rows||[]},e.periods[0],e.promotion).source_rows)!==stableAnalyticalJSON(e.source_rows))throw Object.assign(Error('Recovered eligible population differs from retrieved daily rows'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  const aggregation=aggregateWeekdaySales({rows:e.retrieval_failed?[]:e.retrieved_daily_rows||[]},e.periods[0],e.promotion);
  const coverage=legacy?Object.fromEntries(Object.keys(e.coverage).map(k=>[k,aggregation.coverage[k]])):aggregation.coverage;
  if(stableAnalyticalJSON(aggregation.rows)!==stableAnalyticalJSON(e.rows)||stableAnalyticalJSON(coverage)!==stableAnalyticalJSON(e.coverage))throw Object.assign(Error('Recovered weekday figures disagree with daily evidence'),{code:'EVIDENCE_SCOPE_MISMATCH'});
  return true;
}
