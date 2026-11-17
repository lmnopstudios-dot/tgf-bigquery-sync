import {createCountryConversionReportReader,assertCountryReport,COUNTRY_REPORT_BOUNDS} from './country-conversion-report.js';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql,missingShopifyConfig} from '../shopify/admin-client.js';
import {stableAnalyticalJSON} from './analytical-plan.js';
import {datesBetween} from '../ga4/semantic.js';
import {dayAdd,londonDay} from '../public/oracle/kpi-intent.js';
export const KPI_CONVERSION_BOUNDS=Object.freeze({max_days:1464,max_graphql_calls:20,max_evidence_bytes:4_000_000,timeout_ms:60000});
export const KPI_CONVERSION_DEFINITION='Shopify human Online Store sessions that completed at least one checkout / human sessions; visitor/session country, all presentment currencies. Not GA4 purchases per session.';
const groups={combined:['global'],uk:['global','country'],international:['global','country','rest_of_world']};
const sourceGroup={combined:'global',uk:'country',international:'rest_of_world'};
const mismatch=()=>{throw Object.assign(Error('KPI conversion evidence mismatch'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'kpi_conversion_validation'});};
const same=(a,b)=>stableAnalyticalJSON(a)===stableAnalyticalJSON(b);
export function kpiConversionRange(periods,now){
 const start=periods.map(p=>p.start_date).sort()[0],end=periods.map(p=>p.end_date).sort().at(-1),cutoff=dayAdd(londonDay(now),-1);
 const range={start_date:start<'2025-11-20'?'2025-11-20':start,end_date:end>cutoff?cutoff:end};
 if(range.start_date>range.end_date)return null;
 if(datesBetween(range.start_date,range.end_date).length>KPI_CONVERSION_BOUNDS.max_days)throw Object.assign(Error('Conversion range bound'),{code:'KPI_CONVERSION_BOUND'});
 return range;
}
export function kpiConversionRequest(range,geography){return {...range,population_scope:{geography_role:'visitor_country',country:'GB',groups:groups[geography]},channel:'online',dimensions:[]};}
const safeCode=error=>['KPI_CONVERSION_BOUND','COUNTRY_SCOPE_UNAVAILABLE','COUNTRY_SQL_REJECTED','COUNTRY_EVIDENCE_INVALID','SHOPIFY_PERMISSION_DENIED','SHOPIFY_AUTH_FAILED','THROTTLED','ACCESS_DENIED','TIMEOUT','REQUEST_CANCELLED'].includes(error?.code)?error.code:'KPI_CONVERSION_UNAVAILABLE';
/** Reuse the governed reader. Query promises are shared across the three scopes
 * so identical metadata/global/local reads are not paid for three times. The
 * actual transport, including failed attempts, owns one bounded request budget. */
export function createKpiConversionReader({env=process.env,graphql=null,fetchImpl=fetch,now=()=>new Date()}={}){
 return async({periods,scope,signal,deadlineAt=Infinity,assertLease=async()=>{},onProviderStage,now:reportNow=Date.now()})=>{
  const result={version:1,definition:KPI_CONVERSION_DEFINITION,read_only:true,api_attempts:0,sources:{},filter_applicability:{channel:'Online Store only',currency:'Not applicable: all presentment currencies',commerce_geography:'Not applicable: visitor country is independent of shipping destination'}};
  if(!['combined','online'].includes(scope.channel))return {...result,unavailable_reason:'Online conversion is not applicable to POS or Unknown channel; no source read was made'};
  let range;try{range=kpiConversionRange(periods,reportNow);}catch(e){return {...result,unavailable_reason:safeCode(e)};}
  if(!range)return {...result,unavailable_reason:'Before governed Shopify source history; no source read was made'};
  if(!graphql&&missingShopifyConfig(env).length)return {...result,unavailable_reason:'Shopify reporting connection unavailable'};
  const remaining=Math.min(KPI_CONVERSION_BOUNDS.timeout_ms,deadlineAt-Date.now());
  if(remaining<=0||signal?.aborted)return {...result,unavailable_reason:'REQUEST_CANCELLED'};
  const controller=new AbortController(),shared=AbortSignal.any([controller.signal,AbortSignal.timeout(remaining),...(signal?[signal]:[])]),cache=new Map();let transport;
  const load=()=>transport??=(async()=>{if(graphql)return graphql;const c=loadShopifyConfig(env),token=await getShopifyAccessToken(c,fetchImpl,shared);return createShopifyGraphql({...c,token,fetchImpl,apiVersion:'2026-07'});})();
  const budgeted=(query,variables={})=>{
   shared.throwIfAborted();const key=stableAnalyticalJSON([query,variables]);if(cache.has(key))return cache.get(key);
   if(result.api_attempts>=KPI_CONVERSION_BOUNDS.max_graphql_calls)throw Object.assign(Error('Conversion call bound'),{code:'KPI_CONVERSION_BOUND'});
   result.api_attempts++;
   const pending=(async()=>{await assertLease();return (await load())(query,variables,shared);})();cache.set(key,pending);return pending;
  };
  try{
   const reader=createCountryConversionReportReader({env,graphql:budgeted,now});
   const settled=await Promise.allSettled(Object.keys(groups).map(async geography=>{const request=kpiConversionRequest(range,geography);const source=await reader(request,{signal:shared,deadlineAt:Math.min(deadlineAt,Date.now()+remaining),assertLease});return {request,source};}));
   for(const [i,geography] of Object.keys(groups).entries()){
    const r=settled[i];result.sources[geography]=r.status==='fulfilled'?r.value:{failure:safeCode(r.reason)};
    onProviderStage?.({stage:'kpi_conversion_source',geography,status:r.status==='fulfilled'&&r.value.source.supported?'observed':'unavailable',api_attempts:result.api_attempts});
   }
   signal?.throwIfAborted();await assertLease();
   if(Buffer.byteLength(JSON.stringify(result))>KPI_CONVERSION_BOUNDS.max_evidence_bytes)return {...result,sources:{},unavailable_reason:'KPI_CONVERSION_BOUND'};
   if(Object.values(result.sources).some(r=>r.source?.supported&&r.source.shop?.ianaTimezone!=='Europe/London'))return {...result,sources:{},unavailable_reason:'KPI_CONVERSION_TIMEZONE_MISMATCH'};
   assertKpiConversionSource(result);return result;
  }finally{controller.abort();}
 };
}
export function assertKpiConversionSource(conversion){
 if(conversion.version!==1||conversion.definition!==KPI_CONVERSION_DEFINITION||conversion.read_only!==true||!conversion.sources||!Number.isSafeInteger(conversion.api_attempts)||conversion.api_attempts<0||conversion.api_attempts>KPI_CONVERSION_BOUNDS.max_graphql_calls)mismatch();
 const totals=new Map();let shop;
 for(const [geography,record] of Object.entries(conversion.sources)){
  if(!groups[geography])mismatch();if(!record.source?.supported)continue;
  if(!same(record.request.population_scope,{geography_role:'visitor_country',country:'GB',groups:groups[geography]}))mismatch();
  assertCountryReport(record.request,record.source);
  if(record.source.shop?.ianaTimezone!=='Europe/London')mismatch();
  if(shop&&!same(shop,record.source.shop))mismatch();shop=record.source.shop;
  for(const p of record.source.partitions)for(const r of p.rows.filter(r=>r.group==='global')){const prior=totals.get(r.date),v=[r.sessions,r.numerator,p.measurement_era];if(prior&&!same(prior,v))mismatch();totals.set(r.date,v);}
 }
 return true;
}
function periodRows(conversion,period,geography){
 const record=conversion.sources[geography],source=record?.source,days=datesBetween(period.start_date,period.end_date),failure=conversion.unavailable_reason||record?.failure||source?.failure?.code;
 const result={period:period.id,period_label:period.label,start_date:period.start_date,end_date:period.end_date,metric:'conversion',label:'Shopify online conversion / '+(geography==='uk'?'UK':geography),currency:null,channel:'online',geography,geography_role:'visitor_country',value:null,sessions:null,converted_sessions:null,status:'unavailable',reason:failure||'No compatible Shopify country report',requested_days:days.length,observed_days:0,measurement_era:null,source:'ShopifyQL human sessions',source_store:source?.shop?.id??null,time_zone:'Europe/London',query_retrieved_at:source?.coverage?.query_retrieved_at??null,upstream_tracking_completeness:'unverified',target:null,currency_filter_applied:false,commerce_geography_filter_applied:false};
 if(!source?.supported)return {row:result,segments:[]};
 const rows=source.partitions.flatMap(p=>p.rows.filter(r=>r.group===sourceGroup[geography]&&r.date>=period.start_date&&r.date<=period.end_date).map(r=>({...r,measurement_era:p.measurement_era}))),segments=[];
 const eras=[...new Set(rows.map(r=>r.measurement_era))];
 for(const era of eras){const values=rows.filter(r=>r.measurement_era===era),sessions=values.reduce((n,r)=>n+r.sessions,0),numerator=values.reduce((n,r)=>n+r.numerator,0);segments.push({period:period.id,geography,measurement_era:era,start_date:values[0].date,end_date:values.at(-1).date,observed_days:values.length,sessions,converted_sessions:numerator,rate:sessions?numerator/sessions:null,scope:'Observed compatible days only; not a full-period KPI'});}
 result.observed_days=rows.length;
 if(rows.length!==days.length){result.reason=period.start_date<'2025-11-20'?'Requested period includes dates before governed Shopify history':'Missing or excluded native report days; a partial-period rate is not substituted';return {row:result,segments};}
 if(eras.length!==1){result.reason='Session measurement changed within this period; different eras are not pooled';return {row:result,segments};}
 const total=segments[0];result.sessions=total.sessions;result.converted_sessions=total.converted_sessions;result.measurement_era=eras[0];
 if(!Number.isSafeInteger(result.sessions)||!Number.isSafeInteger(result.converted_sessions))mismatch();
 result.value=total.rate;result.status=total.rate==null?'unavailable':'supported';result.reason=total.rate==null?'Zero observed sessions; conversion has no denominator':null;return {row:result,segments};
}
export function kpiConversionRows(conversion,periods){
 assertKpiConversionSource(conversion);const rows=[],segments=[],unknown=[];
 for(const p of periods){const current=[];for(const geography of Object.keys(groups)){const r=periodRows(conversion,p,geography);rows.push(r.row);segments.push(...r.segments);current.push(r.row);}
  const [global,uk,intl]=current,compatible=current.every(r=>r.sessions!=null&&r.measurement_era===global.measurement_era),sessions=compatible?global.sessions-uk.sessions-intl.sessions:null,numerator=compatible?global.converted_sessions-uk.converted_sessions-intl.converted_sessions:null;
  if(compatible&&(sessions<0||numerator<0||numerator>sessions))mismatch();
  unknown.push({period:p.id,start_date:p.start_date,end_date:p.end_date,geography:'unknown / blank / ZZ',sessions,converted_sessions:numerator,note:'Included in combined only; excluded from direct international query. No rate inferred when populations are incomplete or incompatible.'});
 }
 return {rows,segments,unknown};
}
export function conversionComparison(row,other){
 if(!other||row.value==null||other.value==null)return {value:null,reason:other?.reason||row.reason||'Compatible comparison unavailable'};
 if(row.metric==='conversion'&&row.measurement_era!==other.measurement_era)return {value:null,reason:'Session measurement eras differ; change withheld'};
 return {value:other.value,reason:null};
}
export function assertKpiConversionEvidence(e){
 if(!e.conversion){if(e.rows.some(r=>r.metric==='conversion'&&r.value!=null))mismatch();return true;}
 const derived=kpiConversionRows(e.conversion,e.periods),actual=e.rows.filter(r=>r.metric==='conversion');if(!same(derived.rows,actual)||!same(derived.segments,e.conversion_segments)||!same(derived.unknown,e.conversion_unknown)||!same(e.monthly.filter(r=>r.metric==='conversion'),actual.filter(r=>r.period.startsWith('month:'))))mismatch();
 if(e.summary.filter(r=>r.metric==='conversion').length!==actual.filter(r=>['selected','mtd'].includes(r.period)).length)mismatch();
 for(const r of e.summary.filter(r=>r.metric==='conversion')){const original=actual.find(x=>x.period===r.period&&x.geography===r.geography);if(!original)mismatch();for(const k of Object.keys(original))if(!same(r[k],original[k]))mismatch();
  for(const [field,id] of [['previous',r.period==='mtd'?'mtd_previous':'previous'],['year',r.period==='mtd'?'mtd_year':'year'],['baseline','baseline']]){
   const compared=conversionComparison(r,actual.find(x=>x.period===id&&x.geography===r.geography));if(r[field+'_value']!==(field==='baseline'&&!e.baseline?.fixed?null:compared.value))mismatch();
   if(field!=='baseline'){const delta=r.value==null||compared.value==null?null:r.value-compared.value,expected={absolute:delta,percentage:delta==null||compared.value===0?null:delta/Math.abs(compared.value),direction:delta==null?'unavailable':delta>0?'up':delta<0?'down':'flat'};if(!same(expected,r[field+'_change']))mismatch();}
  }
 }
 return true;
}
export function kpiConversionWorkbookRows(e){
 return [...e.rows.filter(r=>r.metric==='conversion'),...e.conversion_segments.map(r=>({...r,row_kind:'Observed measurement-era segment'})),...e.conversion_unknown.map(r=>({...r,row_kind:'Unknown geography reconciliation'}))];
}

export const unavailableKpiConversion=reason=>({version:1,definition:KPI_CONVERSION_DEFINITION,read_only:true,api_attempts:0,sources:{},unavailable_reason:safeCode(reason)});
