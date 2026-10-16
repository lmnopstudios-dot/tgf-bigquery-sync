import { selectOracleCharts } from './evidence-charts.js';
import { exportCountryConversion } from './country-conversion-export.js';
import { createCountryConversionReportReader, assertCountryReport } from './country-conversion-report.js';
import { datesBetween } from '../ga4/semantic.js';
import { resolveAnalyticalPlan, stableAnalyticalJSON } from './analytical-plan.js';
import { COUNTRY_CONVERSION_LIMITATION, groupLabel } from './population-scope.js';
const mismatch=()=>{throw Object.assign(Error('Country conversion evidence does not satisfy the requested populations, definitions or coverage'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});};
const key=v=>stableAnalyticalJSON(v);
const period=c=>({start_date:c.start_date,end_date:c.end_date});
// Production reader queries Shopify reports only; it never invokes a collector.
export const createPopulationConversionProvider=createCountryConversionReportReader;
export function aggregatePopulationConversion(context,source){
  const scope=context.population_scope;
  try{assertCountryReport({...period(context),population_scope:scope,channel:context.channel,dimensions:context.dimensions},source);}catch{mismatch();}
  if(context.filters.length||context.exclusions.length||context.currencies.length||context.channel_breakdown||context.comparison_start_date||context.source_store&&context.source_store!==source.shop.id||context.platform&&!['shopify','all'].includes(context.platform))mismatch();
  if(source.shop.ianaTimezone!==(context.time_zone||'Europe/London'))mismatch();
  if(scope?.geography_role!=='visitor_country'||context.dimensions.length||!source?.partitions?.length||scope.groups.some(g=>g!=='global')&&!scope.country)mismatch();
  const output=[];const seen=new Set();
  const parts=context.grain==='month'?source.partitions.flatMap(part=>{
    const months=[...new Set(part.rows.map(r=>r.date.slice(0,7)))];
    return months.map(month=>{const rows=part.rows.filter(r=>r.date.startsWith(month)),dates=rows.map(r=>r.date).sort();return {...part,rows,month,period:{start_date:dates[0],end_date:dates.at(-1)}};});
  }):source.partitions;
  for(const part of parts){
    if(!['shopify','woo'].includes(part.platform)||!part.source_store||!part.time_zone||!part.measurement_era||part.geography_role!=='visitor_country'||part.channel!=='online'||!part.period||!/^\d{4}-\d{2}-\d{2}$/.test(part.period.start_date)||!/^\d{4}-\d{2}-\d{2}$/.test(part.period.end_date)||!Array.isArray(part.rows)||part.period.start_date<context.start_date||part.period.end_date>context.end_date||part.period.start_date>part.period.end_date)mismatch();
    try{new Intl.DateTimeFormat('en',{timeZone:part.time_zone});}catch{mismatch();}
    const definition=part.platform==='shopify'?'completed_checkout_sessions':'ecommerce_purchases';
    if(part.numerator_definition!==definition||part.denominator_definition!=='sessions'||!part.evidence_cutoff||part.evidence_cutoff<part.period.end_date)mismatch();
    const days=datesBetween(part.period.start_date,part.period.end_date);
    const rows=[];
    for(const group of scope.groups){
      const values=part.rows.filter(r=>r.group===group);
      if(values.length!==days.length||new Set(values.map(r=>r.date)).size!==days.length||values.some(r=>!days.includes(r.date)||!Number.isSafeInteger(r.sessions)||!Number.isSafeInteger(r.numerator)||r.sessions<0||r.numerator<0||part.platform==='shopify'&&r.numerator>r.sessions||r.country!==scope.country||r.geography_role!=='visitor_country'||r.numerator_definition!==definition||r.denominator_definition!=='sessions'))mismatch();
      for(const date of days){const id=key([part.platform,part.source_store,group,date]);if(seen.has(id))mismatch();seen.add(id);}
      const sessions=values.reduce((n,r)=>n+r.sessions,0),numerator=values.reduce((n,r)=>n+r.numerator,0);
      if(!Number.isSafeInteger(sessions)||!Number.isSafeInteger(numerator))mismatch();
      rows.push({group,sessions,numerator,rate:sessions?numerator/sessions:null});
    }
    if(part.rows.length!==days.length*scope.groups.length)mismatch();
    const local=rows.find(r=>r.group==='country'),global=rows.find(r=>r.group==='global');
    if(local&&global&& (local.sessions>global.sessions||local.numerator>global.numerator))mismatch();
    output.push({...(context.grain==='month'?{month:part.month,partial_month:part.period.start_date!==part.month+'-01'||part.period.end_date!==new Date(Date.UTC(Number(part.month.slice(0,4)),Number(part.month.slice(5)),0)).toISOString().slice(0,10)}:{}),platform:part.platform,source_store:part.source_store,time_zone:part.time_zone,measurement_era:part.measurement_era,numerator_definition:definition,period:part.period,evidence_cutoff:part.evidence_cutoff,rows,percentage_point_difference:rows.length===2&&rows.every(r=>r.rate!==null)?(rows[0].rate-rows[1].rate)*100:null});
  }
  if(context.grain!=='month')return output;
  const monthly=new Map();
  for(const section of output){
    const id=key([section.platform,section.source_store,section.time_zone,section.measurement_era,section.month]);
    const prior=monthly.get(id);
    if(!prior){monthly.set(id,{...section,supported_dates:datesBetween(section.period.start_date,section.period.end_date)});continue;}
    prior.supported_dates.push(...datesBetween(section.period.start_date,section.period.end_date));
    prior.period={start_date:prior.period.start_date,end_date:section.period.end_date};prior.evidence_cutoff=section.evidence_cutoff;
    for(const row of prior.rows){const extra=section.rows.find(r=>r.group===row.group);row.sessions+=extra.sessions;row.numerator+=extra.numerator;if(!Number.isSafeInteger(row.sessions)||!Number.isSafeInteger(row.numerator))mismatch();row.rate=row.sessions?row.numerator/row.sessions:null;}
    prior.percentage_point_difference=prior.rows.length===2&&prior.rows.every(r=>r.rate!==null)?(prior.rows[0].rate-prior.rows[1].rate)*100:null;
  }
  for(const s of monthly.values())s.partial_month=s.supported_dates.length!==new Date(Date.UTC(Number(s.month.slice(0,4)),Number(s.month.slice(5)),0)).getUTCDate();
  return [...monthly.values()];
}
export function assertPopulationConversionEvidence(context,e){
  if(e.kind!=='governed_population_conversion'||key(e.population_scope)!==key(context.population_scope)||key(e.periods)!==key([period(context)])||!e.analytical_plan)mismatch();
  if((e.grouping||null)!==(context.grain||null))mismatch();
  if(key(aggregatePopulationConversion(context,e.source))!==key(e.sections))mismatch();
  if(e.chart_specs&&key(e.chart_specs)!==key(selectOracleCharts({...e,chart_specs:undefined})))mismatch();
  return true;
}
export function populationConversionMarkdown(e){
  const lines=['Shopify human Online Store sessions, grouped by visitor/session geography.'];
  if(e.grouping==='month'){
    const rate=r=>r?.rate==null?'Unavailable':(r.rate*100).toFixed(2)+'%';
    const local=e.population_scope.country==='GB'?'UK':e.population_scope.country,other=e.population_scope.groups.includes('rest_of_world')?'Non-'+local:'Global (including '+local+')';
    lines.push(`| Month | ${local} sessions | ${local} completed-checkout sessions | ${local} rate | ${other} sessions | ${other} completed-checkout sessions | ${other} rate |`,'|---|---:|---:|---:|---:|---:|---:|');
    for(const s of e.sections){const a=s.rows.find(r=>r.group==='country'),b=s.rows.find(r=>r.group!=='country');lines.push(`| ${s.month}${s.partial_month?' (partial)':''} · ${s.period.start_date}–${s.period.end_date} · ${s.measurement_era} | ${a?.sessions??'—'} | ${a?.numerator??'—'} | ${rate(a)} | ${b?.sessions??'—'} | ${b?.numerator??'—'} | ${rate(b)} |`);}
  }
  for(const s of e.grouping==='month'?[]:e.sections){
    lines.push(`${s.platform} · ${s.source_store} · ${s.measurement_era}. Supported period: ${s.period.start_date} to ${s.period.end_date} (${s.time_zone}). Actual evidence cutoff: ${s.evidence_cutoff}. ${s.period.start_date!==e.periods[0].start_date||s.period.end_date!==e.periods[0].end_date?'Partial requested period.':'Full requested period.'}`,`Native numerator: ${s.numerator_definition}; denominator: sessions.`, '', '| Population | Sessions | Conversion numerator | Conversion rate | Difference (pp) |','|---|---:|---:|---:|---:|');
    for(const [i,r] of s.rows.entries())lines.push(`| ${groupLabel(e.population_scope,r.group)} | ${r.sessions.toLocaleString('en-GB')} | ${r.numerator.toLocaleString('en-GB')} | ${r.rate===null?'Unavailable':(r.rate*100).toFixed(2)+'%'} | ${i===0&&s.percentage_point_difference!==null?s.percentage_point_difference.toFixed(2):'—'} |`);
    lines.push('');
  }
  if(e.source.coverage){const c=e.source.coverage;lines.push(`Reporting coverage: ${c.compatible_report_days}/${c.requested_days} requested days have compatible native reports. Missing days: ${c.missing_days.length}; excluded days: ${c.excluded_days.length}. Upstream tracking completeness remains unverified. Query retrieved: ${c.query_retrieved_at}. Stored source collection timestamp is not exposed.`);for(const reason of [...new Set(c.excluded_days.map(d=>d.reason))]){const dates=c.excluded_days.filter(d=>d.reason===reason).map(d=>d.date);lines.push(`${reason}: ${dates.length} days: ${dates.join(', ')}.`);}if(c.missing_days.length)lines.push(`Missing native report dates: ${c.missing_days.join(', ')}.`);if(c.excluded_days.some(d=>d.reason==='documented_measurement_rollout_shop_date_unverified'))lines.push('21–23 September 2026 are excluded because the shop-specific session-measurement rollout date is unverified. Rates on either side remain separate.');}
  lines.push(e.population_scope.groups.includes('global')&&e.population_scope.groups.includes('country')?'Global includes UK/the selected country and all available visitor countries; these groups overlap.':e.population_scope.groups.includes('rest_of_world')?'Rest of world excludes the selected visitor country and unknown/blank/ZZ geography; the groups are disjoint. Unknown geography remains in global only.':'Population uses visitor/session country.');
  lines.push('Rates use summed compatible native numerators / summed sessions. Platform, measurement-era and coverage partitions remain separate.');
  return lines.join('\n');
}
export async function answerPopulationConversion({context,provider,signal,assertLease,exportStore,exportOwner,requestId,onEvidence,deadlineAt}){
  const scope=context.population_scope,labels=scope.groups.map(g=>groupLabel(scope,g)).join(' versus ');
  const limit=reason=>({answer:`${labels}.\n\n${reason}`,analysis_unavailable:true,tools:[],analysis_context:context});
  // No network reads are needed to reject a missing binding. A configured reader
  // needs calendar scope before it can execute its bounded report queries.
  if(!context.start_date||!context.end_date){if(!provider?.capability?.configured)return limit(COUNTRY_CONVERSION_LIMITATION);return {answer:'Which start and end dates should the visitor-country conversion comparison use? The read-only report needs a bounded reporting period.',clarification:{message:'Which start and end dates should the visitor-country conversion comparison use? The read-only report needs a bounded reporting period.',fields:['start_date','end_date'],reason:'required_input'},analysis_context:context,tools:[]};}
  if(scope.geography_role!=='visitor_country')return limit('Conversion requires visitor/session geography. Shipping destination, billing country, currency and storefront market do not establish that population.');
  if(context.dimensions.length||context.filters.length||context.exclusions.length||context.comparison_start_date||context.currencies.length||context.platform&&!['shopify','all'].includes(context.platform)||context.channel!=='online'||context.channel_breakdown)return limit('The requested additional breakdown, filter or period comparison has no verified country-conversion binding.');
  const resultForSource=source=>{
    const evidence={kind:'governed_population_conversion',grouping:context.grain||null,requested_subject:'population_conversion',metrics:['conversion'],population_scope:scope,periods:[period(context)],source,sections:aggregatePopulationConversion(context,source),analytical_plan:resolveAnalyticalPlan(context),read_only:true};
    assertPopulationConversionEvidence(context,evidence);
    return {answer:populationConversionMarkdown(evidence),partial:!source.coverage.full_requested_period,evidence,tools:['get_population_conversion'],analysis_context:context};
  };
  const source=await (provider||createPopulationConversionProvider({env:{}}))({ ...period(context),population_scope:structuredClone(scope),channel:'online',dimensions:[] },{signal,assertLease,deadlineAt,onChunk:async source=>onEvidence?.(resultForSource(source))});
  if(source?.supported!==true){
    const overlap=scope.groups.includes('global')&&scope.groups.includes('country')?' Global includes UK/the selected country; the groups overlap.':scope.groups.includes('rest_of_world')?' Rest of world excludes the selected country.':'';
    const failure=source?.failure;
    const safeCode=value=>/^[A-Z_]{1,60}$/.test(value||'')?value:'UNAVAILABLE';
    const details=failure?'\n\n<details><summary>Capability check</summary>\n\n'+safeCode(failure.code)+' at '+(/^[a-z_]{1,60}$/.test(failure.stage||'')?failure.stage:'provider')+'. No device or shipping-order fallback was used.\n</details>':'';
    return {...limit(COUNTRY_CONVERSION_LIMITATION+overlap+details),capability_status:{supported:false,failure:failure||null}};
  }
  const evidence={kind:'governed_population_conversion',grouping:context.grain||null,requested_subject:'population_conversion',metrics:['conversion'],population_scope:scope,periods:[period(context)],source,sections:aggregatePopulationConversion(context,source),analytical_plan:resolveAnalyticalPlan(context),read_only:true};
  assertPopulationConversionEvidence(context,evidence);
  const result={answer:populationConversionMarkdown(evidence),partial:!source.coverage.full_requested_period,evidence,tools:['get_population_conversion'],analysis_context:context};
  await onEvidence?.(result);
  return exportCountryConversion(result,{context,exportStore,exportOwner,requestId,onEvidence});
}
