import { createShopifyCountryConversionReader, assertCountrySource, countryRequest } from './shopify-country-conversion.js';
import { datesBetween } from '../ga4/semantic.js';
import { stableAnalyticalJSON } from './analytical-plan.js';
const same=(a,b)=>stableAnalyticalJSON(a)===stableAnalyticalJSON(b);
const invalid=()=>{throw Object.assign(Error('Country report evidence mismatch'),{code:'EVIDENCE_SCOPE_MISMATCH',failed_stage:'evidence_validation'});};
export const COUNTRY_REPORT_BOUNDS=Object.freeze({max_days:1464,max_chunks:4,max_graphql_calls:20,total_timeout_ms:60000});
export function countryReportWindows(request){
  const days=datesBetween(request.start_date,request.end_date);
  if(!days.length||days.length>COUNTRY_REPORT_BOUNDS.max_days)invalid();
  const windows=[];
  for(let i=0;i<days.length;i+=366)windows.push({start_date:days[i],end_date:days[Math.min(i+365,days.length-1)]});
  return windows;
}
export function deriveCountryReport(source){
  const windows=countryReportWindows(source.request);
  if(source.kind!=='shopifyql_country_report_v1'||source.chunks?.length!==windows.length)invalid();
  const partitions=[],categories=[];let shop=null;
  for(const [i,chunk] of source.chunks.entries()){
    const request={...source.request,...windows[i]};
    if(!same(chunk.request,request))invalid();
    if(chunk.source?.supported){
      assertCountrySource(request,chunk.source);
      if(shop&&!same(shop,chunk.source.shop))invalid();shop=chunk.source.shop;
      partitions.push(...chunk.source.partitions);
      const c=chunk.source.coverage,supported=new Set(chunk.source.partitions.flatMap(p=>datesBetween(p.period.start_date,p.period.end_date)));
      for(const date of datesBetween(request.start_date,request.end_date)){
        const excluded=c.excluded_days.find(d=>d.date===date);
        categories.push({date,category:supported.has(date)?'supported':c.missing_days.includes(date)?'missing':excluded?.reason==='before_governed_Shopify_launch'?'pre-source-history':excluded?.reason==='current_or_future_day'?'current/incomplete day':'measurement-transition exclusion',reason:excluded?.reason|| (supported.has(date)?'native_report':'native_row_missing')});
      }
    }else{
      if(!['budget_exhausted','cancelled','chunk_failed','pre_source_history','pending_chunk'].includes(chunk.status))invalid();
      for(const date of datesBetween(request.start_date,request.end_date))categories.push({date,category:date<'2025-11-20'?'pre-source-history':'another explicit reason',reason:date<'2025-11-20'?'before_governed_Shopify_launch':chunk.status});
    }
  }
  const requested=datesBetween(source.request.start_date,source.request.end_date);
  if(categories.length!==requested.length||new Set(categories.map(d=>d.date)).size!==requested.length||categories.some((d,i)=>d.date!==requested[i]))invalid();
  const supported=categories.filter(d=>d.category==='supported'),missing=categories.filter(d=>d.category==='missing');
  const counts=Object.fromEntries([...new Set(categories.map(d=>d.category))].map(k=>[k,categories.filter(d=>d.category===k).length]));
  return {shop,partitions,coverage:{requested_days:requested.length,compatible_report_days:supported.length,missing_days:missing.map(d=>d.date),excluded_days:categories.filter(d=>!['supported','missing'].includes(d.category)),categories,category_counts:counts,first_compatible_day:supported[0]?.date||null,last_compatible_day:supported.at(-1)?.date||null,full_requested_period:supported.length===requested.length,upstream_tracking_completeness:'unverified',query_retrieved_at:source.chunks.map(c=>c.source?.retrieved_at).filter(Boolean).at(-1)||null,source_collected_at:null}};
}
export function assertCountryReport(request,source){
  if(source.kind!=='shopifyql_country_report_v1')return assertCountrySource(request,source);
  if(!same(source.request,request))invalid();
  const expected=deriveCountryReport(source);
  if(!same(source.partitions,expected.partitions)||!same(source.coverage,expected.coverage)||!same(source.shop,expected.shop)||!source.supported)invalid();
  return true;
}
export function createCountryConversionReportReader(options={}){
  const native=createShopifyCountryConversionReader(options);
  const reader=async (request,{signal,assertLease=async()=>{},onChunk,deadlineAt:callerDeadline=Infinity}={})=>{
    try{countryRequest({...request,end_date:request.start_date});countryRequest({...request,start_date:request.end_date});}catch{return native(request,{signal});}
    let windows;try{windows=countryReportWindows(request);}catch{return {supported:false,failure:{code:'COUNTRY_EVIDENCE_INVALID',stage:'scope_validation'},read_only:true,graphql_calls:0};}
    if(windows.length===1){await assertLease();const source=await native(request,{signal,deadlineAt:callerDeadline});await assertLease();return source;}
    const chunks=[],deadlineAt=Math.min(callerDeadline,Date.now()+COUNTRY_REPORT_BOUNDS.total_timeout_ms);let calls=0;
    for(const window of windows){
      const args={...request,...window};
      await assertLease();
      if(window.end_date<'2025-11-20'){chunks.push({request:args,status:'pre_source_history'});continue;}
      if(signal?.aborted||Date.now()>=deadlineAt||calls>=COUNTRY_REPORT_BOUNDS.max_graphql_calls){chunks.push({request:args,status:signal?.aborted?'cancelled':'budget_exhausted'});continue;}
      const source=await native(args,{signal,deadlineAt});calls+=source.graphql_calls||0;
      await assertLease();
      chunks.push({request:args,status:source.supported?'supported':'chunk_failed',source});
      if(onChunk&&chunks.some(c=>c.source?.supported)){
        const partial={kind:'shopifyql_country_report_v1',request,chunks:[...chunks,...windows.slice(chunks.length).map(w=>({request:{...request,...w},status:'pending_chunk'}))],read_only:true,graphql_calls:calls};
        await onChunk({...partial,...deriveCountryReport(partial),supported:true});
      }
    }
    const source={kind:'shopifyql_country_report_v1',request,chunks,read_only:true,graphql_calls:calls};
    const derived=deriveCountryReport(source);
    return {...source,...derived,supported:derived.partitions.length>0};
  };
  return Object.assign(reader,{capability:native.capability});
}
