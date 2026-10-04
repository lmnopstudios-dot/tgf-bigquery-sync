const DATE=/^\d{4}-\d{2}-\d{2}$/;
const BF=/\bblack\s+friday\b/i;

/** Reviewed relationship evidence. This relates records; it does not alter either knowledge row. */
export const REVIEWED_CAMPAIGN_PHASES=Object.freeze({
  'ev_2523cea3-5058-481e-9ac0-f6d4520603d6':Object.freeze({campaign:'black-friday-2025',phase:'vip_early_access',label:'VIP early access',expected_start:'2025-11-27',expected_end:'2025-11-27'}),
  'ev_f9521f60-1aaf-41f6-a540-4e4bf00082dd':Object.freeze({campaign:'black-friday-2025',phase:'public',label:'Public campaign',expected_start:'2025-11-28',expected_end:'2025-11-30'})
});

const iso=value=>value?.value||value||null;
const n=value=>value==null||value===''?null:Number.isFinite(Number(value))?Number(value):null;
const fmt=value=>value==null?'unavailable':Number(value).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(value,currency)=>value==null?'unavailable':`${currency} ${fmt(value)}`;
const days=(start,end)=>Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
const safeCode=error=>String(error?.code||error?.name||'SOURCE_FAILED').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60);
const provenance=item=>({status:item.status,source_type:item.source_type||null,source_reference:item.source_reference||null,recorded_at:item.recorded_at||null});

export function isHistoricalEventComparison(message){return BF.test(String(message||''))&&/\b(?:last|previous|recent|compare|comparison|overview|sales?|years?)\b/i.test(String(message||''));}

function normalize(item){
  const start=iso(item.effective_from??item.start_date),end=iso(item.effective_to??item.end_date??start);
  if(!DATE.test(String(start))||!DATE.test(String(end))||start>end)return{invalid:{id:item.id,title:item.title||'Unnamed event',status:item.status,reason:'missing or invalid reviewed start/end dates'}};
  return{row:{id:item.id,name:item.title||'Unnamed event',year:Number(start.slice(0,4)),start_date:start,end_date:end,duration_days:days(start,end),timezone:item.timezone||null,date_precision:item.date_precision||null,description:item.content??item.description??null,tags:item.tags||[],provenance:provenance(item)}};
}

/** Resolve campaigns and their phases. Conflicts are scoped to one phase, never merely to one year. */
export function resolveHistoricalEvents(items,{asOf=new Date(),count=3,eventPattern=BF}={}){
  const requestDate=new Date(asOf).toISOString().slice(0,10),invalid=[],unconfirmed=[],unmatched=[],phaseRows=new Map(),ordinary=new Map();
  for(const item of items||[]){
    if(item.kind!=='event'||!eventPattern.test(`${item.title||''} ${(item.tags||[]).join(' ')}`))continue;
    const normalized=normalize(item);if(normalized.invalid){invalid.push(normalized.invalid);continue;}const row=normalized.row;
    if(row.end_date>=requestDate)continue;
    if(item.status!=='confirmed'){unconfirmed.push({...row,reason:`record status is ${item.status||'unknown'}, not confirmed`});continue;}
    const reviewed=REVIEWED_CAMPAIGN_PHASES[item.id];
    if(reviewed){const key=`${reviewed.campaign}:${reviewed.phase}`,rows=phaseRows.get(key)||[];rows.push({...row,phase:reviewed.phase,phase_label:reviewed.label,campaign_id:reviewed.campaign});phaseRows.set(key,rows);continue;}
    const phase=String(item.phase||'').trim()||(/\bvip|early access\b/i.test(`${item.title} ${item.description||item.content||''}`)?'vip_early_access':/\bpublic\b/i.test(`${item.title} ${item.description||item.content||''}`)?'public':'campaign');
    const key=`${row.year}:${phase}`,rows=ordinary.get(key)||[];rows.push({...row,phase,phase_label:phase==='campaign'?'Campaign':phase});ordinary.set(key,rows);
  }
  const conflicts=[];
  const choose=(key,rows)=>{if(new Set(rows.map(x=>`${x.start_date}|${x.end_date}`)).size>1){conflicts.push({phase_key:key,year:rows[0].year,phase:rows[0].phase,event_ids:rows.map(x=>x.id),periods:rows.map(x=>`${x.start_date} to ${x.end_date}`),reason:'conflicting confirmed dates for the same campaign phase'});return null;}return rows.sort((a,b)=>String(b.provenance.recorded_at).localeCompare(String(a.provenance.recorded_at)))[0];};
  const resolvedPhases=[...phaseRows].map(([key,rows])=>choose(key,rows)).filter(Boolean);
  for(const phase of resolvedPhases){const map=REVIEWED_CAMPAIGN_PHASES[phase.id];if(phase.start_date!==map.expected_start||phase.end_date!==map.expected_end)conflicts.push({phase_key:`${map.campaign}:${map.phase}`,year:phase.year,phase:map.phase,event_ids:[phase.id],periods:[`${phase.start_date} to ${phase.end_date}`,`${map.expected_start} to ${map.expected_end}`],reason:'confirmed phase dates contradict the explicit reviewed mapping'});}
  const blocked=new Set(conflicts.map(x=>x.phase_key));
  const mapped=resolvedPhases.filter(x=>!blocked.has(`${x.campaign_id}:${x.phase}`));
  const campaigns=[];
  const bf2025=mapped.filter(x=>x.campaign_id==='black-friday-2025');
  if(bf2025.length===2){campaigns.push({id:'campaign:black-friday-2025',name:'Black Friday 2025',year:2025,start_date:'2025-11-27',end_date:'2025-11-30',duration_days:4,timezone:null,date_precision:'range',phases:bf2025.sort((a,b)=>a.start_date.localeCompare(b.start_date)),relationship_provenance:{type:'explicit_reviewed_mapping',reference:'confirmed Black Friday 2025 phase mapping reviewed 2026-10-04',event_ids:bf2025.map(x=>x.id)},campaign_context:'Online-only 20% promotion on eligible silver products; eye rings, mixed-metal products, enamel products and collaborations excluded. Physical stores did not participate and POS remained on Square. This context does not filter whole-store sales without governed product classification evidence.'});}
  else for(const expected of ['vip_early_access','public'])if(!bf2025.some(x=>x.phase===expected)&&!blocked.has(`black-friday-2025:${expected}`))unmatched.push({year:2025,phase:expected,reason:'reviewed campaign phase record was not returned'});
  for(const [key,rows] of ordinary){const row=choose(key,rows);if(row&&!blocked.has(key)){if(row.phase==='campaign')campaigns.push({...row,phases:[row]});else unmatched.push({...row,reason:'phase has no governed parent campaign mapping'});}}
  const expectedYears=[];for(let year=Number(requestDate.slice(0,4))-(requestDate.slice(5)<='11-30'?1:0);expectedYears.length<count;year--)expectedYears.push(year);
  const selected=campaigns.filter(x=>expectedYears.includes(x.year)).sort((a,b)=>b.year-a.year);
  const missing=expectedYears.filter(year=>!selected.some(x=>x.year===year)&&!conflicts.some(x=>x.year===year)&&!unconfirmed.some(x=>x.year===year)&&!unmatched.some(x=>x.year===year)).map(year=>({year,reason:'no matching Black Friday event record was returned'}));
  return{request_date:requestDate,requested_count:count,expected_years:expectedYears,events:selected,conflicts,invalid,missing,unconfirmed,unmatched,complete:selected.length===count&&conflicts.length===0&&invalid.length===0&&missing.length===0&&unconfirmed.length===0&&unmatched.length===0};
}

function eventCount(message){const match=String(message).match(/\blast\s+(\d{1,2})\s+(?:black\s+friday\s+)?(?:sales?|years?)\b/i);return Math.max(1,Math.min(Number(match?.[1]||3),5));}
function onlineRows(report){const rows=report?.online_sales?.rows||report?.rows||[];const seen=new Set();return rows.filter(row=>{const key=`${row.currency}|${row.source_platform}|${row.source_store}`;if(seen.has(key))return false;seen.add(key);return true;}).flatMap(row=>(row.source_coverage||[]).map(source=>({...source,currency:row.currency})));}
function renderEvent(section){
  const {event,report}=section,lines=[`## ${event.name} (${event.year})`,`**Applied full-campaign period:** ${event.start_date} to ${event.end_date} (${event.duration_days} days).`];
  for(const phase of event.phases)lines.push(`- **${phase.phase_label}:** ${phase.start_date} to ${phase.end_date}; confirmed ${phase.id}; ${phase.provenance.source_type||'source type unavailable'}; ${phase.provenance.source_reference||'source reference unavailable'}; recorded ${phase.provenance.recorded_at||'time unavailable'}.`);
  if(event.campaign_context)lines.push(`- **Campaign context:** ${event.campaign_context}`);
  if(section.status!=='fulfilled')return lines.concat(`- **Sales evidence unavailable:** ${section.error_code}; this campaign failed independently and no zero was substituted.`);
  const rows=onlineRows(report);if(!rows.length)lines.push('- No governed online sales rows were returned; missing evidence is not zero.');
  for(const row of rows){const orders=n(row.eligible_orders),sales=n(row.eligible_sales);lines.push(`- **${row.source_platform}/${row.source_store} · ${row.currency}:** eligible online orders ${fmt(orders)}; operational net sales ${money(sales,row.currency)}; sales/order ${money(orders>0?sales/orders:null,row.currency)}; sales/day ${money(sales==null?null:sales/event.duration_days,row.currency)}; orders/day ${orders==null?'unavailable':fmt(orders/event.duration_days)}.`);}
  const conversion=report?.conversion?.current,compat=report?.conversion?.comparability?.current??report?.conversion?.compatible;
  if(conversion&&compat===true)lines.push(`- **Compatible online traffic:** sessions ${fmt(conversion.sessions)}; conversion ${conversion.conversion_rate==null?'unavailable':`${(Number(conversion.conversion_rate)*100).toFixed(2)}%`}.`);else lines.push('- **Conversion:** unavailable because compatible traffic evidence for this exact campaign period was not established.');
  return lines;
}

/** Bounded, lazy orchestration. Every campaign is an independent failure boundary. */
export function createHistoricalEventComparisonService({knowledgeService,collectEvent,now=()=>new Date(),concurrency=2,queryTimeoutMs=55_000}){
  if(!knowledgeService?.searchKnowledge||typeof collectEvent!=='function')throw new Error('knowledgeService and collectEvent are required');
  return async message=>{if(!isHistoricalEventComparison(message))return null;const requested_at=new Date(now()),count=eventCount(message),knowledge=await knowledgeService.searchKnowledge({text:null,knowledge_type:'event',start_date:null,end_date:null,status:null,tags:['black-friday'],limit:50});const resolved=resolveHistoricalEvents(knowledge.items,{asOf:requested_at,count}),sections=new Array(resolved.events.length),limit=Math.max(1,Math.min(concurrency,2));let cursor=0;
    const bounded=async event=>{let timer;try{return await Promise.race([collectEvent(event,{channel:'online',exclude_pos:true,exclude_matrixify:true,currency_policy:'separate',product_eligibility_filter:false}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('bounded event query timeout'),{code:'EVENT_QUERY_TIMEOUT'})),queryTimeoutMs);timer.unref?.();})]);}finally{clearTimeout(timer);}};
    const worker=async()=>{while(cursor<resolved.events.length){const index=cursor++,event=resolved.events[index],query_started_at=new Date(now()).toISOString();try{sections[index]={event,status:'fulfilled',report:await bounded(event),query_started_at,query_completed_at:new Date(now()).toISOString()};}catch(error){sections[index]={event,status:'rejected',error_code:safeCode(error),query_started_at,query_completed_at:new Date(now()).toISOString()};}}};await Promise.all(Array.from({length:Math.min(limit,resolved.events.length)},worker));
    const lines=['# Black Friday campaign comparison',`**Request as of:** ${resolved.request_date}. Resolved campaign years and governed phases; nominal Black Friday weekends were not substituted.`];
    for(const [heading,key] of [['Conflicting same-phase records','conflicts'],['Missing years','missing'],['Unconfirmed records','unconfirmed'],['Unmatched records or phases','unmatched'],['Invalid records','invalid']])if(resolved[key].length)lines.push('',`## ${heading}`,...resolved[key].map(x=>`- ${x.year||'unknown year'}${x.phase?` ${x.phase}`:''}: ${x.reason} (${(x.event_ids||[x.id]).filter(Boolean).join(', ')||'no record ID'}).`));
    for(const section of sections)lines.push('',...renderEvent(section));
    lines.push('','## Comparison boundaries','- Totals cover each full campaign; phases are displayed separately and are not double-counted as additional campaigns. Different durations are compared using actual totals and daily rates.','- Only source-qualified online orders are included. POS/Square and Matrixify Shopify representations are excluded; currencies remain separate.','- Promotion exclusions are context only. Whole-store sales are not filtered to eligible products because no governed product-classification evidence was requested and supplied.','- Conversion is shown only when compatible traffic evidence covers the exact campaign period.');
    return{answer:lines.join('\n'),evidence:{version:'historical_event_comparison.v2',requested_scope:{event:'Black Friday',count,as_of:resolved.request_date,channel:'online',exclude_pos:true,exclude_matrixify:true,currencies:'separate',product_eligibility_filter:false},resolved_scope:resolved,sections,collected_at:new Date(now()).toISOString()},tools:['search_knowledge','get_online_country_sales']};};
}
