import { evidenceNumber } from './numeric-evidence.js';

const esc=value=>String(value??'Unavailable').replaceAll('|','\\|').replaceAll('\n',' ').slice(0,240);
const display=value=>{const n=evidenceNumber(value);return n==null?'Unavailable':n.toLocaleString('en-GB',{maximumFractionDigits:2});};

/** Governed attribution evidence, never an incremental-sales estimate. */
export async function answerKlaviyoAnalysis({context,provider,onProviderStage}){
  if(context.comparison_start_date){
    const periods=[{start_date:context.start_date,end_date:context.end_date},{start_date:context.comparison_start_date,end_date:context.comparison_end_date}],results=[];
    for(const period of periods)results.push(await answerKlaviyoAnalysis({context:{...context,...period,comparison_type:null,comparison_start_date:null,comparison_end_date:null},provider,onProviderStage}));
    return {answer:results.map((r,i)=>`## ${periods[i].start_date} to ${periods[i].end_date}\n\n${r.answer}`).join('\n\n'),tools:[context.tool_route],evidence:{kind:'governed_klaviyo_email',subject:'klaviyo_email',metrics:['email_attribution'],periods,comparison_type:context.comparison_type,email_report_kind:context.email_report_kind||'all',sections:results.map(r=>r.evidence),rows:results.flatMap((r,i)=>r.evidence.rows.map(row=>({...row,requested_period:periods[i]}))),chart_datasets:[{...results[0].evidence.chart_datasets[0],shape:'comparison',compatible:true,period:periods.map(p=>`${p.start_date} to ${p.end_date}`).join(' versus '),points:results.flatMap((r,i)=>r.evidence.chart_datasets[0].points.map(p=>({...p,series:`${periods[i].start_date} to ${periods[i].end_date}`})))}]}};
  }
  if(!provider)throw Object.assign(new Error('Klaviyo binding unavailable'),{code:'KLAVIYO_BINDING_UNAVAILABLE',failed_stage:'klaviyo_binding'});
  const args={start_date:context.start_date,end_date:context.end_date};
  onProviderStage?.({stage:'klaviyo_evidence',status:'started',provider:context.tool_route,...args});
  let result;
  try{result=await provider(context.tool_route,args);}catch(error){onProviderStage?.({stage:'klaviyo_evidence',status:'failed',code:'KLAVIYO_RETRIEVAL_FAILED'});throw Object.assign(new Error('Klaviyo evidence unavailable'),{code:'KLAVIYO_RETRIEVAL_FAILED',failed_stage:'klaviyo_evidence'});}
  onProviderStage?.({stage:'klaviyo_evidence',status:'success'});
  const kind=context.email_report_kind||'all',rows=(result.rows||[]).filter(r=>kind==='all'||r.report_kind===kind);
  const lines=['# Klaviyo email attribution',`Requested dates: ${args.start_date} to ${args.end_date}. Scope: ${kind==='all'?'campaigns and flows, shown separately':kind}.`,
    'Klaviyo attributed revenue describes credited conversion value. It does not establish incremental sales caused by email and must not be added to commerce sales.',
    rows.length?'| Kind | Message / entity | Currency | Attributed revenue | Attributed conversion events | Unique clicks | Actual evidence dates |':'No matching governed attribution rows were returned. Missing coverage cannot establish zero activity.'];
  if(rows.length){lines.push('|---|---|---|---:|---:|---:|---|');for(const row of rows)lines.push(`| ${esc(row.report_kind)} | ${esc(row.entity_name||row.entity_id)} | ${esc(row.currency)} | ${display(row.attributed_conversion_value)} | ${display(row.attributed_conversion_events)} | ${display(row.unique_clicks)} | ${esc(row.actual_start_date)} to ${esc(row.actual_end_date)} |`);}
  const coverage=result.coverage||{};
  lines.push(`Coverage: ${coverage.complete?'all requested calendar months collected':'incomplete or unverified'}; missing months: ${(coverage.missing_months||[]).join(', ')||'not reported'}. Latest retrieval: ${esc(coverage.latest_retrieved_at)}.`,
    'Evidence uses complete calendar-month report windows; exact day slicing is unavailable. Current-month evidence is partial and recent attribution can be provisional. Actual dates are shown above.',
    '<details>','<summary>Attribution definitions, windows and provenance</summary>');
  for(const row of rows)lines.push(`- ${esc(row.report_kind)} / ${esc(row.entity_id)}: conversion metric ${esc(row.conversion_metric_id)}; timezone ${esc(row.reporting_timezone)}; retrieved ${esc(row.retrieved_at)}; attribution model/window settings ${esc(typeof row.attribution_settings==='object'?JSON.stringify(row.attribution_settings):row.attribution_settings)}. Stored settings do not prove historical applicability.`);
  for(const limitation of result.limitations||[])lines.push(`- ${esc(limitation)}`);
  lines.push('</details>');
  if(result.shopify_email_referrer)lines.push(`Shopify email-referrer sessions: ${display(result.shopify_email_referrer.sessions)}; completed-checkout sessions: ${display(result.shopify_email_referrer.completed_checkout_sessions)}. ${esc(result.comparison_semantics)} These are separate populations, not Klaviyo campaign-level conversions.`);
  return {answer:lines.join('\n'),tools:[context.tool_route],evidence:{kind:'governed_klaviyo_email',subject:'klaviyo_email',metrics:['email_attribution'],periods:[args],email_report_kind:kind,rows,coverage,definitions:result.definitions,limitations:result.limitations,shopify_email_referrer:result.shopify_email_referrer||null,chart_datasets:[{id:'klaviyo-attribution',shape:'ranking',title:'Klaviyo attributed revenue by message',period:`${args.start_date} to ${args.end_date}`,metric:'Attributed conversion value',unit:'money',definition:'Klaviyo attributed conversion value; not incremental sales.',source:'Governed persisted Klaviyo',bounded:true,points:rows.map(r=>({id:r.entity_id,label:r.entity_name||r.entity_id,currency:r.currency,value:r.attributed_conversion_value,population:[r.report_kind,r.conversion_metric_id,r.reporting_timezone,r.attribution_settings].join('|')}))}]}};
}
