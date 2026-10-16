import { createShopifyGraphql, getShopifyAccessToken, missingShopifyConfig, loadShopifyConfig } from '../shopify/admin-client.js';
import { assertDate, datesBetween, previousDate } from '../ga4/semantic.js';
import { validatePopulationScope } from './population-scope.js';
import { stableAnalyticalJSON } from './analytical-plan.js';

export const COUNTRY_READER_CONTRACT='shopifyql_visitor_country_v1';
export const COUNTRY_READER_BOUNDS=Object.freeze({max_days:366,page_size:400,max_pages:2,max_graphql_calls:5,operation_timeout_ms:12000,total_timeout_ms:60000});
export const COUNTRY_SHOP_METADATA=`query OracleCountryCapability { shop { id ianaTimezone } currentAppInstallation { accessScopes { handle } } }`;
const REPORT=`query OracleCountryConversion($query:String!){shopifyqlQuery(query:$query){tableData{columns{name} rows} parseErrors}}`;
const same=(a,b)=>stableAnalyticalJSON(a)===stableAnalyticalJSON(b);
const invalid=()=>{throw Object.assign(Error('Invalid visitor-country source evidence'),{code:'COUNTRY_EVIDENCE_INVALID',stage:'source_validation'});};
export function countryRequest(args){
  const scope=validatePopulationScope(args.population_scope);
  for(const date of [args.start_date,args.end_date]){assertDate(date);if(new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)invalid();}
  if(scope?.groups.some(g=>!['country','global','rest_of_world'].includes(g))||args.start_date>args.end_date||datesBetween(args.start_date,args.end_date).length>COUNTRY_READER_BOUNDS.max_days||scope?.geography_role!=='visitor_country'||scope.groups.some(g=>g!=='global')&&!scope.country||args.channel!=='online'||!Array.isArray(args.dimensions)||args.dimensions.length)invalid();
  return {start_date:args.start_date,end_date:args.end_date,population_scope:scope,channel:'online',dimensions:[]};
}
export function countryConversionQuery(period,group,country,offset=0){
  if(!['global','country'].includes(group)||group==='country'&&!/^[A-Z]{2}$/.test(country))invalid();
  for(const date of [period.start_date,period.end_date])assertDate(date);
  if(![0,COUNTRY_READER_BOUNDS.page_size].includes(offset))invalid();
  return `FROM sessions\nSHOW sessions, sessions_that_completed_checkout\nGROUP BY day${group==='country'?', session_country_code':''}\nWHERE human_or_bot_session = 'human'${group==='country'?` AND session_country_code = '${country}'`:''}\nSINCE ${period.start_date} UNTIL ${period.end_date}\nORDER BY day ASC\nLIMIT ${COUNTRY_READER_BOUNDS.page_size}\nOFFSET ${offset}`;
}
const era=date=>date<'2026-09-21'?'before_documented_September_rollout':date>'2026-09-23'?'after_documented_September_rollout':null;
const normalizeDate=value=>{const date=typeof value==='string'?value.slice(0,10):null;if(!date||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)invalid();return date;};
function counts(rows,period,group,country){
  const byDay=new Map();
  for(const row of rows){
    const date=normalizeDate(row.day),sessions=Number(row.sessions),numerator=Number(row.sessions_that_completed_checkout);
    if(![row.sessions,row.sessions_that_completed_checkout].every(value=>typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))||row.sessions===null||row.sessions===''||row.sessions===undefined||row.sessions_that_completed_checkout===null||row.sessions_that_completed_checkout===''||row.sessions_that_completed_checkout===undefined||!Number.isSafeInteger(sessions)||!Number.isSafeInteger(numerator)||numerator<0||sessions<0||numerator>sessions||date<period.start_date||date>period.end_date||byDay.has(date)||group==='country'&&row.session_country_code!==country)invalid();
    byDay.set(date,{sessions,numerator});
  }
  return byDay;
}
// Deterministic replay of the actual native reports, used again on job recovery.
// Global has no country predicate. Unknown visitor countries stay in that total.
export function deriveCountryEvidence(source){
  const request=countryRequest(source.request),scope=request.population_scope;
  if(source.kind!==COUNTRY_READER_CONTRACT||!source.shop?.id||!source.shop?.ianaTimezone||!Number.isFinite(Date.parse(source.retrieved_at))||!Array.isArray(source.granted_scopes)||!source.granted_scopes.includes('read_reports'))invalid();
  try{new Intl.DateTimeFormat('en',{timeZone:source.shop.ianaTimezone});}catch{invalid();}
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:source.shop.ianaTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(source.retrieved_at));
  const expectedPeriod={start_date:request.start_date<'2025-11-20'?'2025-11-20':request.start_date,end_date:request.end_date>=today?previousDate(today):request.end_date};
  if(!same(expectedPeriod,source.effective_period)||expectedPeriod.start_date>expectedPeriod.end_date)invalid();
  const needsLocal=scope.groups.some(g=>g!=='global'),groups=needsLocal?['global','country']:['global'];
  if(!Array.isArray(source.reports)||source.reports.length!==groups.length)invalid();
  const maps={};
  for(const group of groups){
    const report=source.reports.find(r=>r.group===group);
    if(!report||!same(report.period,expectedPeriod)||!Array.isArray(report.pages)||!report.pages.length||report.pages.length>COUNTRY_READER_BOUNDS.max_pages)invalid();
    const rows=[];
    for(const [i,page] of report.pages.entries()){
      if(page.query!==countryConversionQuery(expectedPeriod,group,scope.country,i*COUNTRY_READER_BOUNDS.page_size)||!Array.isArray(page.rows)||page.rows.length>COUNTRY_READER_BOUNDS.page_size||i<report.pages.length-1&&page.rows.length!==COUNTRY_READER_BOUNDS.page_size||i===report.pages.length-1&&page.rows.length===COUNTRY_READER_BOUNDS.page_size)invalid();
      rows.push(...page.rows);
    }
    maps[group]=counts(rows,expectedPeriod,group,scope.country);
  }
  const requestedDays=datesBetween(request.start_date,request.end_date),missing=[],excluded=[],available=[];
  const partitions=[];
  for(const date of requestedDays){
    if(date<expectedPeriod.start_date||date>expectedPeriod.end_date){excluded.push({date,reason:date<'2025-11-20'?'before_governed_Shopify_launch':'current_or_future_day'});continue;}
    if(!era(date)){excluded.push({date,reason:'documented_measurement_rollout_shop_date_unverified'});continue;}
    const global=maps.global.get(date),local=maps.country?.get(date);
    if(!global||needsLocal&&!local){missing.push(date);continue;}
    if(local&&(local.sessions>global.sessions||local.numerator>global.numerator||global.numerator-local.numerator>global.sessions-local.sessions))invalid();
    let part=partitions.at(-1);
    if(!part||part.measurement_era!==era(date)||previousDate(date)!==part.period.end_date){
      part={platform:'shopify',source_store:source.shop.id,time_zone:source.shop.ianaTimezone,measurement_era:era(date),channel:'online',geography_role:'visitor_country',numerator_definition:'completed_checkout_sessions',denominator_definition:'sessions',period:{start_date:date,end_date:date},evidence_cutoff:date,rows:[]};partitions.push(part);
    }
    part.period.end_date=date;part.evidence_cutoff=date;available.push(date);
    for(const group of scope.groups){const value=group==='country'?local:group==='global'?global:{sessions:global.sessions-local.sessions,numerator:global.numerator-local.numerator};part.rows.push({date,group,country:scope.country,geography_role:'visitor_country',denominator_definition:'sessions',numerator_definition:'completed_checkout_sessions',...value});}
  }
  return {partitions,coverage:{requested_days:requestedDays.length,compatible_report_days:available.length,missing_days:missing,excluded_days:excluded,first_compatible_day:available[0]||null,last_compatible_day:available.at(-1)||null,full_requested_period:available.length===requestedDays.length,upstream_tracking_completeness:'unverified',source_collected_at:null,query_retrieved_at:source.retrieved_at,measurement_rollout_shop_date:'unverified'}};
}
export function buildCountryEvidence(fields){const source={kind:COUNTRY_READER_CONTRACT,...fields};const derived=deriveCountryEvidence(source);return {...source,supported:derived.partitions.length>0,...derived};}
export function assertCountrySource(request,source){
  if(!same(countryRequest(request),source.request))invalid();
  const expected=deriveCountryEvidence(source);
  if(!source.supported||!same(source.partitions,expected.partitions)||!same(source.coverage,expected.coverage))invalid();
  return true;
}
function failureCode(error){
  if(error?.name==='TypeError'&&/fetch/i.test(error.message||''))return 'NETWORK_FAILED';
  if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'TIMEOUT';
  return ['COUNTRY_EVIDENCE_INVALID','COUNTRY_GRAPHQL_RESPONSE_INVALID','COUNTRY_SQL_REJECTED','COUNTRY_PAGE_BOUND','COUNTRY_SCOPE_UNAVAILABLE','COUNTRY_METADATA_UNAVAILABLE','SHOPIFY_AUTH_FAILED','SHOPIFY_INVALID_RESPONSE','SHOPIFY_PERMISSION_DENIED','SHOPIFY_HTTP_FAILED','THROTTLED','ACCESS_DENIED','SHOPIFY_AUTH_INVALID_RESPONSE','NETWORK_FAILED'].includes(error?.code)?error.code:'RETRIEVAL_FAILED';
}
export function createShopifyCountryConversionReader({env=process.env,graphql=null,fetchImpl=fetch,now=()=>new Date()}={}){
  // No schema setup, warehouse client, collector, schedule or write dependency.
  const reader=async args=>{
    let calls=0,stage='scope_validation',transport=graphql;
    const wallStarted=Date.now(),started=new Date(now()),deadline=AbortSignal.timeout(COUNTRY_READER_BOUNDS.total_timeout_ms);
    const unavailable=(code,httpStatus)=>({kind:COUNTRY_READER_CONTRACT,supported:false,failure:{code,stage,...(Number.isInteger(httpStatus)?{http_status:httpStatus}:{})},read_only:true,graphql_calls:calls,evidence_cutoff:null});
    try{
      const request=countryRequest(args);
      if(!transport){
        if(missingShopifyConfig(env).length)return unavailable('CONFIGURATION_UNAVAILABLE');
        const config=loadShopifyConfig(env);
        if(!/^[a-z0-9][a-z0-9-]*$/i.test(config.shop))return unavailable('CONFIGURATION_UNAVAILABLE');
        stage='authentication';
        const token=await getShopifyAccessToken(config,fetchImpl,AbortSignal.any([deadline,AbortSignal.timeout(COUNTRY_READER_BOUNDS.operation_timeout_ms)]));
        transport=createShopifyGraphql({...config,token,fetchImpl,apiVersion:'2026-07'});
      }
      const run=async(query,variables={})=>{
        if(++calls>COUNTRY_READER_BOUNDS.max_graphql_calls)throw Object.assign(Error('Country call bound'),{code:'COUNTRY_PAGE_BOUND'});
        const remaining=COUNTRY_READER_BOUNDS.total_timeout_ms-(Date.now()-wallStarted);
        if(remaining<=0)throw Object.assign(Error('Country deadline'),{name:'TimeoutError'});
        const timeout=Math.min(remaining,COUNTRY_READER_BOUNDS.operation_timeout_ms),signal=AbortSignal.any([deadline,AbortSignal.timeout(timeout)]);
        let timer;try{return await Promise.race([transport(query,variables,signal),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Country timeout'),{name:'TimeoutError'})),timeout);})]);}finally{clearTimeout(timer);}
      };
      stage='shop_metadata';const meta=await run(COUNTRY_SHOP_METADATA),shop=meta?.shop;
      const scopes=meta?.currentAppInstallation?.accessScopes?.map(s=>s.handle)||[];
      if(!scopes.includes('read_reports'))return unavailable('COUNTRY_SCOPE_UNAVAILABLE');
      if(!shop?.id||!shop.ianaTimezone)return unavailable('COUNTRY_METADATA_UNAVAILABLE');
      const retrievedAt=new Date(now()).toISOString(),today=new Intl.DateTimeFormat('en-CA',{timeZone:shop.ianaTimezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(retrievedAt));
      const effective={start_date:request.start_date<'2025-11-20'?'2025-11-20':request.start_date,end_date:request.end_date>=today?previousDate(today):request.end_date};
      if(effective.start_date>effective.end_date)return unavailable('NO_COMPLETED_SHOPIFY_DAYS');
      const reports=[];
      for(const group of request.population_scope.groups.some(g=>g!=='global')?['global','country']:['global']){
        stage=`${group}_report`;const pages=[];
        for(let page=0;page<COUNTRY_READER_BOUNDS.max_pages;page++){
          const query=countryConversionQuery(effective,group,request.population_scope.country,page*COUNTRY_READER_BOUNDS.page_size),result=(await run(REPORT,{query}))?.shopifyqlQuery;
          if(result?.parseErrors?.length)throw Object.assign(Error('Country SQL rejected'),{code:'COUNTRY_SQL_REJECTED'});
          const data=result?.tableData,names=data?.columns?.map(c=>c.name);
          if(!Array.isArray(data?.rows)||!names?.includes('day')||!names.includes('sessions')||!names.includes('sessions_that_completed_checkout')||group==='country'&&!names.includes('session_country_code'))throw Object.assign(Error('Country report response invalid'),{code:'COUNTRY_GRAPHQL_RESPONSE_INVALID'});
          const fields=['day','sessions','sessions_that_completed_checkout',...(group==='country'?['session_country_code']:[])];
          const rows=data.rows.map(row=>{const decoded=Array.isArray(row)?Object.fromEntries(names.map((n,i)=>[n,row[i]])):row;return Object.fromEntries(fields.map(n=>[n,decoded[n]]));});
          pages.push({query,rows});if(rows.length<COUNTRY_READER_BOUNDS.page_size)break;
          if(page===COUNTRY_READER_BOUNDS.max_pages-1)throw Object.assign(Error('Country pagination incomplete'),{code:'COUNTRY_PAGE_BOUND'});
        }
        reports.push({group,period:effective,pages});
      }
      stage='source_validation';
      return {...buildCountryEvidence({request,shop:{id:shop.id,ianaTimezone:shop.ianaTimezone},granted_scopes:['read_reports'],retrieved_at:new Date(now()).toISOString(),effective_period:effective,reports}),read_only:true,graphql_calls:calls,elapsed_ms:new Date(now())-started};
    }catch(error){return unavailable(failureCode(error),error?.http_status);}
  };
  return Object.assign(reader,{capability:{configured:Boolean(graphql)||missingShopifyConfig(env).length===0,contract:COUNTRY_READER_CONTRACT}});
}
