import { storedTemporal, provenanceCode } from './event-presentation.js';
import { messageIntent } from './message-intent.js';
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDate=value=>DATE.test(String(value))&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const BF=/\bblack\s+friday\b/i;

/** Reviewed relationship evidence. This relates records; it does not alter either knowledge row. */
export const REVIEWED_CAMPAIGN_PHASES=Object.freeze({
  'ev_2523cea3-5058-481e-9ac0-f6d4520603d6':Object.freeze({campaign:'black-friday-2025',phase:'vip_early_access',label:'VIP early access',expected_start:'2025-11-27',expected_end:'2025-11-27'}),
  'ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd':Object.freeze({campaign:'black-friday-2025',phase:'public',label:'Public campaign',expected_start:'2025-11-28',expected_end:'2025-11-30'})
});

const iso=storedTemporal;
const n=value=>value==null||value===''?null:Number.isFinite(Number(value))?Number(value):null;
const fmt=value=>value==null?'unavailable':Number(value).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(value,currency)=>value==null?'unavailable':`${currency} ${fmt(value)}`;
const days=(start,end)=>Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
const safeCode=error=>String(error?.code||error?.name||'SOURCE_FAILED').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60);
const provenance=item=>({status:item.status,source_type:item.source_type||null,source_reference:item.source_reference||null,recorded_at:iso(item.recorded_at)});

export function historicalEventRequest(message){
  const intent=messageIntent(message);
  if(intent.blocked)return null;
  const text=intent.instruction;
  if(/\b(?:klaviyo|email|e-mail|flows?|sent campaigns?)\b/i.test(text))return null;
  if(!/\b(?:compare|comparison|contrast|analyse|analyze|report|overview)\b/i.test(intent.actionText))return null;
  if(/\b(?:exclude|excluding|except|outside|not)\b[\s\S]{0,45}\b(?:sale|friday|promotion)\b|context only|as context/i.test(text))return null;
  const match=text.match(/\b(?:last|latest)\s+(\d{1,2})\s+(?:completed\s+)?([a-z][a-z -]{1,60}?)\s+(?:campaigns?|promotions?|events?)\b/i)||text.match(/\b(?:last|latest)\s+(\d{1,2})\s+(?:completed\s+)?([a-z][a-z -]{1,60}?)\s+(?:sale(?:s| periods?)?|periods?|years?)\b/i);
  const name=match?.[2]?.trim()||(BF.test(text)?'Black Friday':null);
  if(!name||/^(?:online|shopify|woo(?:commerce)?|sales|revenue|latest|previous)$/i.test(name))return null;
  return {name:name.replace(/\b\w/g,c=>c.toUpperCase()),count:Math.max(1,Math.min(Number(match?.[1]||text.match(/\b(?:last|latest)\s+(\d{1,2})\b/i)?.[1]||3),5))};
}
export function isHistoricalEventComparison(message){return Boolean(historicalEventRequest(message));}

function normalize(item){
  const start=iso(item.effective_from??item.start_date),end=iso(item.effective_to??item.end_date??(item.date_precision==='day'?start:null));
  if(!validDate(start)||!validDate(end)||start>end)return{invalid:{id:item.id,title:item.title||'Unnamed event',status:item.status,year:Number(String(item.title||'').match(/\b(20\d{2})\b/)?.[1])||null,reason:'missing or invalid reviewed start/end dates'}};
  return{row:{id:item.id,name:item.title||'Unnamed event',year:Number(start.slice(0,4)),start_date:start,end_date:end,duration_days:days(start,end),timezone:item.timezone||null,date_precision:item.date_precision||null,description:item.content??item.description??null,tags:item.tags||[],provenance:provenance(item)}};
}

/** Resolve campaigns and their phases. Conflicts are scoped to one phase, never merely to one year. */
export function resolveHistoricalEvents(items,{asOf=new Date(),count=3,eventPattern=BF,eventName="Black Friday"}={}){
  const requestDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(asOf)),invalid=[],unconfirmed=[],unmatched=[],phaseRows=new Map(),ordinary=new Map(),contextRecords=[];
  const matching=(items||[]).filter(item=>item.kind==='event'&&eventPattern.test(`${item.title||''} ${(item.tags||[]).join(' ')}`));
  const incompleteYears=new Set(matching.map(normalize).filter(x=>x.row&&x.row.end_date>=requestDate).map(x=>x.row.year));
  const observedYears=[];
  for(const item of items||[]){
    if(item.kind!=='event'||!eventPattern.test(`${item.title||''} ${(item.tags||[]).join(' ')}`))continue;
    const normalized=normalize(item);if(normalized.invalid){invalid.push(normalized.invalid);if(normalized.invalid.year&&normalized.invalid.year<Number(requestDate.slice(0,4))&&item.status!=='cancelled')observedYears.push(normalized.invalid.year);continue;}const row=normalized.row;
    if(row.end_date>=requestDate||incompleteYears.has(row.year))continue;
    if(item.status==='cancelled')continue;
    observedYears.push(row.year);
    if(item.status!=='confirmed'){unconfirmed.push({...row,reason:`record status is ${item.status||'unknown'}, not confirmed`});continue;}
    const reviewed=REVIEWED_CAMPAIGN_PHASES[item.id];
    if(reviewed){const key=`${reviewed.campaign}:${reviewed.phase}`,rows=phaseRows.get(key)||[];rows.push({...row,phase:reviewed.phase,phase_label:reviewed.label,campaign_id:reviewed.campaign});phaseRows.set(key,rows);continue;}
    const searchable=`${item.title||''} ${item.description||item.content||''}`;
    const physical=/\b(?:soho|tgf east|physical|in[ -]?store|shop)\b/i.test(searchable),explicitOnline=/\bonline\b/i.test(searchable);
    if(physical){contextRecords.push({...row,scope:'physical_store',reason:'physical-store event retained as context and excluded from online scope'});continue;}
    const phase=String(item.phase||'').trim()||(/\bvip|early access\b/i.test(searchable)?'vip_early_access':/\bpublic\b/i.test(searchable)?'public':explicitOnline?'online_campaign':'campaign');
    const key=`${row.year}:${phase}`,rows=ordinary.get(key)||[];rows.push({...row,phase,phase_label:phase==='campaign'?'Campaign':phase});ordinary.set(key,rows);
  }
  const conflicts=[];
  const choose=(key,rows)=>{if(new Set(rows.map(x=>`${x.start_date}|${x.end_date}`)).size>1){conflicts.push({phase_key:key,year:rows[0].year,phase:rows[0].phase,event_ids:rows.map(x=>x.id),periods:rows.map(x=>`${x.start_date} to ${x.end_date}`),reason:'conflicting confirmed dates for the same campaign phase'});return null;}return rows.sort((a,b)=>String(b.provenance.recorded_at).localeCompare(String(a.provenance.recorded_at)))[0];};
  const resolvedPhases=[...phaseRows].map(([key,rows])=>choose(key,rows)).filter(Boolean);
  for(const phase of resolvedPhases){const map=REVIEWED_CAMPAIGN_PHASES[phase.id];if(phase.start_date!==map.expected_start||phase.end_date!==map.expected_end)conflicts.push({phase_key:`${map.campaign}:${map.phase}`,year:phase.year,phase:map.phase,event_ids:[phase.id],periods:[`${phase.start_date} to ${phase.end_date}`,`${map.expected_start} to ${map.expected_end}`],reason:'confirmed phase dates contradict the explicit reviewed mapping'});}
  const blocked=new Set(conflicts.map(x=>x.phase_key));
  const mapped=resolvedPhases.filter(x=>!blocked.has(`${x.campaign_id}:${x.phase}`));
  const campaigns=[];
  for(const campaignId of new Set(Object.values(REVIEWED_CAMPAIGN_PHASES).map(x=>x.campaign))){
    const expected=Object.entries(REVIEWED_CAMPAIGN_PHASES).filter(([,x])=>x.campaign===campaignId);
    const phases=mapped.filter(x=>x.campaign_id===campaignId);
    // Only require a reviewed relationship when this campaign is in the result set.
    if(!expected.some(([id])=>matching.some(x=>x.id===id)))continue;
    if(phases.length===expected.length){
      const start=phases.map(x=>x.start_date).sort()[0],end=phases.map(x=>x.end_date).sort().at(-1);
      campaigns.push({id:`campaign:${campaignId}`,name:`${eventName} ${phases[0].year}`,year:phases[0].year,start_date:start,end_date:end,duration_days:days(start,end),phases:phases.sort((a,b)=>a.start_date.localeCompare(b.start_date)),relationship_provenance:{type:'explicit_reviewed_mapping',event_ids:phases.map(x=>x.id)}});
    }else for(const [,phase] of expected)if(!phases.some(x=>x.phase===phase.phase)&&!blocked.has(`${campaignId}:${phase.phase}`))unmatched.push({year:Number(phase.expected_start.slice(0,4)),phase:phase.phase,reason:'reviewed campaign phase record was not returned'});
  }
  const onlineYears=new Set([...ordinary.values()].flat().filter(x=>x.phase==='online_campaign').map(x=>x.year));
  for(const [key,rows] of ordinary){const row=choose(key,rows);if(row&&!blocked.has(key)){if(row.phase==='online_campaign'||row.phase==='campaign'&&!onlineYears.has(row.year))campaigns.push({...row,phases:[row]});else if(row.phase==='campaign'&&onlineYears.has(row.year))contextRecords.push({...row,scope:'parent_context',reason:'parent campaign retained as context; online event controls online dates'});else unmatched.push({...row,reason:'phase has no governed parent campaign mapping'});}}
  const futureYears=matching.map(normalize).filter(x=>x.row&&x.row.end_date>=requestDate&&x.row.provenance.status==='confirmed').map(x=>x.row.year);
  const scheduledPredecessor=futureYears.length?Math.min(...futureYears)-1:null;
  const anchors=[...observedYears,...(scheduledPredecessor==null?[]:[scheduledPredecessor])];
  const latest=anchors.length?Math.max(...anchors):null;
  const cancelledYears=new Set(matching.filter(x=>x.status==='cancelled').map(normalize).filter(x=>x.row).map(x=>x.row.year));
  // Annual slots come from governed completed/scheduled records. A scheduled
  // successor can expose a missing newest campaign without inventing its dates.
  const expectedYears=[];
  if(latest!=null)for(let year=latest;expectedYears.length<count&&year>latest-20;year--){
    if(incompleteYears.has(year)||cancelledYears.has(year)&&!campaigns.some(x=>x.year===year))continue;
    expectedYears.push(year);
  }
  const selected=campaigns.filter(x=>expectedYears.includes(x.year)).sort((a,b)=>b.year-a.year);
  const missing=expectedYears.filter(year=>!selected.some(x=>x.year===year)&&!conflicts.some(x=>x.year===year)&&!unconfirmed.some(x=>x.year===year)&&!unmatched.some(x=>x.year===year)&&!invalid.some(x=>x.year===year)).map(year=>({year,reason:`no matching ${eventName} event record was returned`}));
  return{request_date:requestDate,requested_count:count,expected_years:expectedYears,events:selected,context_records:contextRecords,conflicts,invalid,missing,unconfirmed,unmatched,complete:selected.length===count&&conflicts.length===0&&invalid.length===0&&missing.length===0&&unconfirmed.length===0&&unmatched.length===0};
}


function failureDiagnostic(error){const detail=Array.isArray(error?.errors)?error.errors[0]||{}:{};return{reason:String(detail.reason||error?.code||error?.name||'QUERY_ERROR').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60),location:String(detail.location||error?.location||'').replace(/[^A-Za-z0-9_:.@\[\]-]/g,'').slice(0,120)||null};}
export function eventSalesRows(report){
  const bySource=new Map();
  for(const row of report?.online_sales?.rows||report?.rows||[])for(const source of row.source_coverage||[]){
    const key=JSON.stringify([row.currency,source.source_platform,source.source_store]);
    if(!bySource.has(key))bySource.set(key,{...source,currency:row.currency});
  }
  return [...bySource.values()];
}
const onlineRows=eventSalesRows;
function renderEvent(section){
  const {event,report}=section,lines=[`## ${event.name} (${event.year})`,`**Applied full-campaign period:** ${event.start_date} to ${event.end_date} (${event.duration_days} days).`];
  for(const phase of event.phases)lines.push(`- **${phase.phase_label}:** ${phase.start_date} to ${phase.end_date}; confirmed ${provenanceCode(phase.id)}; ${provenanceCode(phase.provenance.source_type)}; ${provenanceCode(phase.provenance.source_reference)}; recorded ${phase.provenance.recorded_at||'time unavailable'}.`);
  if(event.campaign_context)lines.push(`- **Campaign context:** ${event.campaign_context}`);
  if(section.status!=='fulfilled')return lines.concat(`- **Sales evidence unavailable:** ${section.error_code}; this campaign failed independently and no zero was substituted.`);
  for(const c of report?.source_components||[])if(c.status==='rejected')lines.push(`- **${c.platform} sales evidence unavailable:** ${c.error_code}; other source observations are retained.`);
  const rows=onlineRows(report);if(!rows.length)lines.push('- No governed online sales rows were returned; missing evidence is not zero.');
  for(const row of rows){const orders=n(row.eligible_orders),sales=n(row.eligible_sales);lines.push(`- **${provenanceCode(`${row.source_platform}/${row.source_store}`)} · ${row.currency}:** eligible online orders ${fmt(orders)}; operational net sales ${money(sales,row.currency)}; sales/order ${money(orders>0?sales/orders:null,row.currency)}; sales/day ${money(sales==null?null:sales/event.duration_days,row.currency)}; orders/day ${orders==null?'unavailable':fmt(orders/event.duration_days)}.`);}
  const conversion=report?.conversion?.current,compat=report?.conversion?.comparability?.current??report?.conversion?.compatible;
  if(conversion&&compat===true&&report.conversion.period?.start_date===event.start_date&&report.conversion.period?.end_date===event.end_date)lines.push(`- **Compatible online traffic:** sessions ${fmt(conversion.sessions)}; conversion ${conversion.conversion_rate==null?'unavailable':`${(Number(conversion.conversion_rate)*100).toFixed(2)}%`}.`);else lines.push('- **Conversion:** unavailable because compatible traffic evidence for this exact campaign period was not established.');
  return lines;
}

/** Bounded, lazy orchestration. Every campaign is an independent failure boundary. */
export function createHistoricalEventComparisonService({knowledgeService,collectEvent,now=()=>new Date(),concurrency=2,queryTimeoutMs=55_000}){
  if(!knowledgeService?.searchKnowledge||typeof collectEvent!=='function')throw new Error('knowledgeService and collectEvent are required');
  return async (message,options={})=>{const request=historicalEventRequest(message)||(options.analysisContext?.tool_route==='compare_historical_events'?{name:options.analysisContext.event_name,count:options.analysisContext.event_count}:null);if(!request)return null;if(options.analysisContext&&(['instore','all'].includes(options.analysisContext.channel)||options.analysisContext.channel_breakdown||options.analysisContext.platform||options.analysisContext.geography||options.analysisContext.currencies?.length||options.analysisContext.filters?.length))return {analysis_unavailable:true,partial:true,answer:'This campaign comparison supports source-separated online sales in native currencies. The requested channel, source or population filter has no verified campaign binding. Specify online sales without that filter; no substitute monthly report was queried.',tools:[]};const requested_at=new Date(now()),{count,name}=request,eventPattern=new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'[ -]+'),'i');
    // Tags are useful but not authoritative: older confirmed rows may have a
    // human-readable event name without the normalized tag. Query both scopes
    // and preserve retrieval outcomes so an empty result is not reported as a
    // genuinely absent record when both governed reads failed.
    const searches=[{name:'tag',args:{text:null,knowledge_type:'event',start_date:null,end_date:null,status:null,tags:[name.toLowerCase().replace(/\s+/g,'-')],limit:50}},{name:'confirmed_name',args:{text:name,knowledge_type:'event',start_date:null,end_date:null,status:'confirmed',tags:[],limit:50}}],settled=await Promise.allSettled(searches.map(x=>knowledgeService.searchKnowledge(x.args))),retrieval=settled.map((result,index)=>({scope:searches[index].name,status:result.status,...(result.status==='fulfilled'?{returned_count:result.value.returned_count??result.value.items?.length??0}:{failure:failureDiagnostic(result.reason)})}));
    if(settled.every(x=>x.status==='rejected'))throw Object.assign(new Error('Black Friday knowledge retrieval failed; record absence was not established'),{code:'EVENT_KNOWLEDGE_RETRIEVAL_FAILED',diagnostic:{retrieval}});
    const byId=new Map();for(const result of settled)if(result.status==='fulfilled')for(const item of result.value.items||[])if(item?.id)byId.set(item.id,item);
    const resolved=resolveHistoricalEvents([...byId.values()],{asOf:requested_at,count,eventPattern,eventName:name}),sections=new Array(resolved.events.length),limit=Math.max(1,Math.min(concurrency,2));let cursor=0;
    const bounded=async event=>{let timer;try{return await Promise.race([collectEvent(event,{channel:'online',exclude_pos:true,exclude_matrixify:true,currency_policy:'separate',product_eligibility_filter:false}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('bounded event query timeout'),{code:'EVENT_QUERY_TIMEOUT'})),queryTimeoutMs);timer.unref?.();})]);}finally{clearTimeout(timer);}};
    const worker=async()=>{while(cursor<resolved.events.length){const index=cursor++,event=resolved.events[index],query_started_at=new Date(now()).toISOString();try{sections[index]={event,status:'fulfilled',report:await bounded(event),query_started_at,query_completed_at:new Date(now()).toISOString()};}catch(error){sections[index]={event,status:'rejected',error_code:safeCode(error),failure_diagnostic:failureDiagnostic(error),query_started_at,query_completed_at:new Date(now()).toISOString()};}}};await Promise.all(Array.from({length:Math.min(limit,resolved.events.length)},worker));
    const lines=[`# ${name} campaign comparison`,`**Request as of:** ${resolved.request_date}. Resolved campaign years and governed phases; nominal Black Friday weekends were not substituted.`];
    if(!resolved.events.length)lines.push('No completed campaign has verified dates and usable sales observations. Governed dates or source evidence are missing; no nominal dates or older replacement campaign were used.');
    lines.push(...comparisonTable(sections),'','<details>','<summary>Show details</summary>','',`Latest selection uses discovered governed annual campaign records; discovery completeness is unverified. Online-only governed convention applied; in-store/POS is excluded. Source-native definitions remain separate; collection completeness is unverified. Charts and exports are unavailable for this binding.`);
    for(const [heading,key] of [['Conflicting same-phase records','conflicts'],['Missing years','missing'],['Unconfirmed records','unconfirmed'],['Unmatched records or phases','unmatched'],['Invalid records','invalid']])if(resolved[key].length)lines.push('',`## ${heading}`,...resolved[key].map(x=>`- ${x.year||'unknown year'}${x.phase?` ${x.phase}`:''}: ${x.reason} (${(x.event_ids||[x.id]).filter(Boolean).join(', ')||'no record ID'}).`));
    for(const section of sections)lines.push('',...renderEvent(section));
    lines.push('','## Comparison boundaries','- Totals cover each full campaign; phases are displayed separately and are not double-counted as additional campaigns. Different durations are compared using actual totals and daily rates.','- Only source-qualified online orders are included. POS/Square and Matrixify Shopify representations are excluded; currencies remain separate.','- Promotion exclusions are context only. Whole-store sales are not filtered to eligible products because no governed product-classification evidence was requested and supplied.','- Conversion is shown only when compatible traffic evidence covers the exact campaign period.');
    lines.push('','</details>');
    return{partial:!resolved.complete||retrieval.some(x=>x.status==='rejected')||sections.some(x=>x.status!=='fulfilled'||x.report?.partial||x.report?.coverage_complete!==true||!onlineRows(x.report).length),answer:lines.join('\n'),evidence:{kind:'historical_event_comparison',subject:'sales',metrics:['sales'],periods:resolved.events.map(x=>({event_id:x.id,start_date:x.start_date,end_date:x.end_date})),version:'historical_event_comparison.v2',requested_scope:{event:name,count,as_of:resolved.request_date,channel:'online',exclude_pos:true,exclude_matrixify:true,currencies:'separate',product_eligibility_filter:false},knowledge_retrieval:retrieval,resolved_scope:resolved,sections,requested_at:requested_at.toISOString(),collected_at:new Date(now()).toISOString()},tools:['search_knowledge','get_online_country_sales']};};
}

function comparisonTable(sections){
  const lines=['','| Campaign | Actual dates | Days | Source / store | Currency | Sales | Orders | Sales/day | Orders/day | Prior sales change |','|---|---|---:|---|---|---:|---:|---:|---:|---|'];
  for(let i=0;i<sections.length;i++){
    const section=sections[i],ev=section.event,rows=section.status==='fulfilled'?onlineRows(section.report):[];
    if(!rows.length)lines.push(`| ${ev.name} | ${ev.start_date} to ${ev.end_date} | ${ev.duration_days} | Unavailable (${section.error_code||'no rows'}) | — | — | — | — | — | Unavailable |`);
    for(const row of rows){
      const prior=sections[i+1],previous=prior?.status==='fulfilled'?onlineRows(prior.report).find(r=>r.currency===row.currency&&r.source_platform===row.source_platform&&r.source_store===row.source_store):null;
      // Same source definition is necessary; collection completeness is not established by a successful aggregate read.
      const sales=n(row.eligible_sales),orders=n(row.eligible_orders),change=sales!=null&&previous&&section.report?.coverage_complete===true&&prior.report?.coverage_complete===true&&n(previous.eligible_sales)>0?`${fmt((sales/Number(previous.eligible_sales)-1)*100)}%`:'Unavailable (coverage/definitions)';
      lines.push(`| ${String(ev.name).replaceAll('|',' ')} | ${ev.start_date} to ${ev.end_date} | ${ev.duration_days} | ${row.source_platform}/${row.source_store} | ${row.currency} | ${fmt(sales)} | ${fmt(orders)} | ${fmt(sales==null?null:sales/ev.duration_days)} | ${fmt(orders==null?null:orders/ev.duration_days)} | ${change} |`);
    }
  }
  lines.push('',`${sections.filter(s=>s.status==='fulfilled'&&onlineRows(s.report).length).length} campaigns have sales observations. Daily rates use each actual campaign duration; source coverage limitations apply.`);
  return lines;
}
