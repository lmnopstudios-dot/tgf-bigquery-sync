import { createShopifyCountryConversionReader, assertCountrySource } from './shopify-country-conversion.js';
import { datesBetween } from '../ga4/semantic.js';
import { resolveAnalyticalPlan, stableAnalyticalJSON } from './analytical-plan.js';
import { COUNTRY_CONVERSION_LIMITATION, groupLabel } from './population-scope.js';
const mismatch=()=>{throw Object.assign(Error('Country conversion evidence does not satisfy the requested populations, definitions or coverage'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});};
const key=v=>stableAnalyticalJSON(v);
const period=c=>({start_date:c.start_date,end_date:c.end_date});
// Production reader queries Shopify reports only; it never invokes a collector.
export const createPopulationConversionProvider=createShopifyCountryConversionReader;
export function aggregatePopulationConversion(context,source){
  const scope=context.population_scope;
  try{assertCountrySource({...period(context),population_scope:scope,channel:context.channel,dimensions:context.dimensions},source);}catch{mismatch();}
  if(context.filters.length||context.exclusions.length||context.currencies.length||context.channel_breakdown||context.comparison_start_date||context.source_store&&context.source_store!==source.shop.id||context.platform&&!['shopify','all'].includes(context.platform))mismatch();
  if(source.shop.ianaTimezone!==(context.time_zone||'Europe/London'))mismatch();
  if(scope?.geography_role!=='visitor_country'||context.dimensions.length||!source?.partitions?.length||scope.groups.some(g=>g!=='global')&&!scope.country)mismatch();
  const output=[];const seen=new Set();
  for(const part of source.partitions){
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
    output.push({platform:part.platform,source_store:part.source_store,time_zone:part.time_zone,measurement_era:part.measurement_era,numerator_definition:definition,period:part.period,evidence_cutoff:part.evidence_cutoff,rows,percentage_point_difference:rows.length===2&&rows.every(r=>r.rate!==null)?(rows[0].rate-rows[1].rate)*100:null});
  }
  return output;
}
export function assertPopulationConversionEvidence(context,e){
  if(e.kind!=='governed_population_conversion'||key(e.population_scope)!==key(context.population_scope)||key(e.periods)!==key([period(context)])||!e.analytical_plan)mismatch();
  if(key(aggregatePopulationConversion(context,e.source))!==key(e.sections))mismatch();
  return true;
}
export function populationConversionMarkdown(e){
  const lines=['Shopify human Online Store sessions, grouped by visitor/session geography.'];
  for(const s of e.sections){
    lines.push(`${s.platform} · ${s.source_store} · ${s.measurement_era}. Supported period: ${s.period.start_date} to ${s.period.end_date} (${s.time_zone}). Actual evidence cutoff: ${s.evidence_cutoff}. ${s.period.start_date!==e.periods[0].start_date||s.period.end_date!==e.periods[0].end_date?'Partial requested period.':'Full requested period.'}`,`Native numerator: ${s.numerator_definition}; denominator: sessions.`, '', '| Population | Sessions | Conversion numerator | Conversion rate | Difference (pp) |','|---|---:|---:|---:|---:|');
    for(const [i,r] of s.rows.entries())lines.push(`| ${groupLabel(e.population_scope,r.group)} | ${r.sessions.toLocaleString('en-GB')} | ${r.numerator.toLocaleString('en-GB')} | ${r.rate===null?'Unavailable':(r.rate*100).toFixed(2)+'%'} | ${i===0&&s.percentage_point_difference!==null?s.percentage_point_difference.toFixed(2):'—'} |`);
    lines.push('');
  }
  if(e.source.coverage){const c=e.source.coverage;lines.push(`Reporting coverage: ${c.compatible_report_days}/${c.requested_days} requested days have compatible native reports. Missing days: ${c.missing_days.length}; excluded days: ${c.excluded_days.length}. Upstream tracking completeness remains unverified. Query retrieved: ${c.query_retrieved_at}. Stored source collection timestamp is not exposed.`);if(c.excluded_days.some(d=>d.reason==='documented_measurement_rollout_shop_date_unverified'))lines.push('21–23 September 2026 are excluded because the shop-specific session-measurement rollout date is unverified. Rates on either side remain separate.');}
  lines.push(e.population_scope.groups.includes('global')&&e.population_scope.groups.includes('country')?'Global includes UK/the selected country and all available visitor countries; these groups overlap.':e.population_scope.groups.includes('rest_of_world')?'Rest of world excludes the selected visitor country; the groups are disjoint.':'Population uses visitor/session country.');
  lines.push('Rates use summed compatible native numerators / summed sessions. Platform, measurement-era and coverage partitions remain separate.');
  return lines.join('\n');
}
export async function answerPopulationConversion({context,provider}){
  const scope=context.population_scope,labels=scope.groups.map(g=>groupLabel(scope,g)).join(' versus ');
  const limit=reason=>({answer:`${labels}.\n\n${reason}`,analysis_unavailable:true,tools:[],analysis_context:context});
  // No network reads are needed to reject a missing binding. A configured reader
  // needs calendar scope before it can execute its bounded report queries.
  if(!context.start_date||!context.end_date){if(!provider?.capability?.configured)return limit(COUNTRY_CONVERSION_LIMITATION);return {answer:'Which start and end dates should the visitor-country conversion comparison use? The read-only report needs a bounded reporting period.',clarification:{message:'Which start and end dates should the visitor-country conversion comparison use? The read-only report needs a bounded reporting period.',fields:['start_date','end_date'],reason:'required_input'},analysis_context:context,tools:[]};}
  if(scope.geography_role!=='visitor_country')return limit('Conversion requires visitor/session geography. Shipping destination, billing country, currency and storefront market do not establish that population.');
  if(context.dimensions.length||context.filters.length||context.exclusions.length||context.comparison_start_date||context.currencies.length||context.platform&&!['shopify','all'].includes(context.platform)||context.channel!=='online'||context.channel_breakdown)return limit('The requested additional breakdown, filter or period comparison has no verified country-conversion binding.');
  const source=await (provider||createPopulationConversionProvider({env:{}}))({ ...period(context),population_scope:structuredClone(scope),channel:'online',dimensions:[] });
  if(source?.supported!==true){
    const overlap=scope.groups.includes('global')&&scope.groups.includes('country')?' Global includes UK/the selected country; the groups overlap.':scope.groups.includes('rest_of_world')?' Rest of world excludes the selected country.':'';
    const failure=source?.failure;
    const safeCode=value=>/^[A-Z_]{1,60}$/.test(value||'')?value:'UNAVAILABLE';
    const details=failure?'\n\n<details><summary>Capability check</summary>\n\n'+safeCode(failure.code)+' at '+(/^[a-z_]{1,60}$/.test(failure.stage||'')?failure.stage:'provider')+'. No device or shipping-order fallback was used.\n</details>':'';
    return {...limit(COUNTRY_CONVERSION_LIMITATION+overlap+details),capability_status:{supported:false,failure:failure||null}};
  }
  const evidence={kind:'governed_population_conversion',requested_subject:'population_conversion',metrics:['conversion'],population_scope:scope,periods:[period(context)],source,sections:aggregatePopulationConversion(context,source),analytical_plan:resolveAnalyticalPlan(context),read_only:true};
  assertPopulationConversionEvidence(context,evidence);
  return {answer:populationConversionMarkdown(evidence),evidence,tools:['get_population_conversion'],analysis_context:context};
}
