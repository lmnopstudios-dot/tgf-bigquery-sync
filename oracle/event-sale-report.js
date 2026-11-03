import {resolveHistoricalEvents} from './historical-event-comparison.js';
import {storedTemporal,provenanceCode} from './event-presentation.js';
import {stableAnalyticalJSON} from './analytical-plan.js';
const code=e=>/^[A-Z0-9_]{1,70}$/.test(String(e?.code))?e.code:'EVENT_SECTION_FAILED';
const channel=r=>/^(?:online)$/i.test(r.channel)?'online':/^(?:pos|in[- ]?store|retail)$/i.test(r.channel)?'instore':'unknown';
const num=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const value=(n,c)=>num(n)==null?'Unavailable':`${c||''} ${Number(n).toLocaleString('en-GB',{maximumFractionDigits:2})}`.trim();
const esc=s=>String(s??'Unavailable').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export function resolveEventSaleWindows(items,scope,asOf){
 const windows=[],issues=[];
 for(const year of scope.years)for(const ch of scope.channels){
  const candidates=items.filter(r=>r.kind==='event'&&r.status!=='cancelled'&&!r.superseded_by&&/black[ -]+friday/i.test(r.title+' '+(r.tags||[]).join(' '))&&Number(storedTemporal(r.effective_from??r.start_date)?.slice(0,4))===year);
  const physical=r=>/\b(?:soho|tgf east|physical|in[ -]?store|shop)\b/i.test(r.title+' '+(r.content||r.description||''));
  let events=[];
  if(ch==='online'){
   const resolved=resolveHistoricalEvents(candidates.filter(r=>!physical(r)),{asOf,count:1});events=resolved.events.filter(e=>e.year===year);
   issues.push(...resolved.conflicts.map(x=>({...x,channel:ch,type:'ambiguous'})));
  }else{
   const grouped=new Map();for(const r of candidates.filter(physical)){
    const location=r.location_name||(/\b(?:soho|tgf east)\b/i.exec(r.title)?.[0])||null;
    const key=location?.toLowerCase()||'all';const group=grouped.get(key)||[];group.push(r);grouped.set(key,group);
   }
   for(const rows of grouped.values()){
    const confirmed=rows.filter(r=>r.status==='confirmed');
    if(new Set(confirmed.map(r=>[storedTemporal(r.effective_from??r.start_date),storedTemporal(r.effective_to??r.end_date)].join('/'))).size>1){issues.push({type:'ambiguous',year,channel:ch,event_ids:confirmed.map(r=>r.id),reason:'Conflicting confirmed store-sale windows'});continue;}
    const r=confirmed[0];if(!r)continue;
    const start=storedTemporal(r.effective_from??r.start_date),end=storedTemporal(r.effective_to??r.end_date);
    if(!valid(start)||!valid(end)||start>end)continue;
    events.push({id:r.id,name:r.title,year,start_date:start,end_date:end,location_name:r.location_name||(/\b(?:soho|tgf east)\b/i.exec(r.title)?.[0])||null,phases:[{id:r.id,start_date:start,end_date:end,description:r.content||r.description,timezone:r.timezone,provenance:{status:r.status,source_reference:r.source_reference,source_type:r.source_type,recorded_at:storedTemporal(r.recorded_at)}}]});
   }
  }
  if(!events.length)issues.push({type:'unavailable',year,channel:ch,reason:'No unambiguous confirmed channel sale window was resolved'});
  for(const e of events){
   if(e.end_date>=asOf){issues.push({type:'unavailable',year,channel:ch,reason:'Sale period is not completed'});continue;}
   const entries=e.phases.map(p=>items.find(r=>r.id===p.id)).filter(Boolean),descriptions=entries.map(r=>r.content||r.description||'').join(' ');
   windows.push({...e,id:`${ch}:${e.id}`,channel:ch,timezone:entries.find(r=>r.timezone)?.timezone||'Europe/London',timezone_provenance:entries.some(r=>r.timezone)?'knowledge metadata':'report convention; knowledge DATE metadata has no IANA timezone',intraday:/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|\b(?:midnight|noon)\b/i.test(descriptions),knowledge_entries:entries});
  }
 }
 return {windows,issues};
}
function totalsRows(report,ch){
 const groups=new Map();
 for(const r of report.rows||[]){if(channel(r)!==ch&&channel(r)!=='unknown')continue;
  const key=JSON.stringify([r.source,r.channel,r.currency]),g=groups.get(key)||{source:r.source,channel:channel(r),currency:r.currency,sales:null,refunds:null,refund_events:null,observed:false};
  const amount=num(r.amount);
  // A net total includes only observed sale/refund components; a missing
  // currency amount never turns into zero.
  g.sales=!g.observed?amount:g.sales==null||amount==null?null:g.sales+amount;g.observed=true;
  if(r.transaction_type==='refund'){g.refunds=num(r.amount);g.refund_events=num(r.refund_events);}
  groups.set(key,g);
 }return [...groups.values()];
}
export function renderEventSaleReport(e){
 const lines=[`# ${e.requested_scope.event} sale periods`,'Sales definition: canonical finance gross sales less accounting refunds, including tax, within one currency. Refunds use the refund transaction date. Product line sales are separate source-native operational measures; they do not reconcile to finance totals. Currencies are never converted or combined.'];
 for(const read of e.knowledge_retrieval||[])if(read.status==='rejected')lines.push(`Knowledge retrieval incomplete: ${read.code}; absence of records has not been established.`);
 for(const section of e.sections){const w=section.window;
  lines.push(`\n## ${w.year} · ${w.channel}${w.location_name?' · '+esc(w.location_name):''}`,`Sale window: **${w.start_date} to ${w.end_date}**, inclusive. Reporting timezone: ${esc(w.timezone)} (${esc(w.timezone_provenance)}).`);
  for(const r of w.knowledge_entries)lines.push(`Knowledge ${provenanceCode(r.id)} — ${esc(r.title)}: ${storedTemporal(r.effective_from??r.start_date)} to ${storedTemporal(r.effective_to??r.end_date)}; ${provenanceCode(r.source_reference)}; status ${r.status}; recorded ${storedTemporal(r.recorded_at)||'unavailable'}. ${esc(r.content||r.description||'')}`);
  if(w.intraday)lines.push('The stored description includes clock-time bounds. The date-grain finance binding cannot calculate that exact intraday sale window; no whole-day replacement was used.');
  if(section.totals.status==='fulfilled'){
   const rows=totalsRows(section.totals.evidence,w.channel);
   lines.push('| Source | Channel | Currency | Sales after refunds incl. tax | Refund value (signed) | Refund events |','|---|---|---|---:|---:|---:|');
   for(const r of rows)lines.push(`| ${esc(r.source)} | ${r.channel} | ${r.currency} | ${value(r.sales)} | ${value(r.refunds)} | ${value(r.refund_events)} |`);
   const byCurrency=new Map();for(const r of rows.filter(r=>r.channel===w.channel)){const prior=byCurrency.get(r.currency);byCurrency.set(r.currency,prior===undefined?r.sales:prior==null||r.sales==null?null:prior+r.sales);}
   for(const [currency,total]of byCurrency)lines.push(`${w.channel} ${currency} ${section.totals.evidence.coverage?.complete===true?'total':'observed subtotal (coverage unverified)'}: ${value(total,currency)}. Unknown channels are excluded from this subtotal.`);
   if(!rows.length)lines.push('Total sales unavailable: no qualifying transaction observations were returned; this does not establish zero.');
  }else lines.push(`Total sales unavailable: ${section.totals.code}.`);
  if(section.products){if(section.products.status==='fulfilled'){
   const report=section.products.evidence,rows=report.rows.filter(r=>r.channel===w.channel||r.channel==='unknown').sort((a,b)=>String(a.currency).localeCompare(String(b.currency))||String(a.namespace).localeCompare(String(b.namespace))||(num(b.sales)??-Infinity)-(num(a.sales)??-Infinity));
   lines.push('Products ranked by line sales within source and currency:','| Product identity | Product | Source | Channel | Currency | Units | Line sales | Refunded units | Product refunds |','|---|---|---|---|---|---:|---:|---:|---:|');
   for(const r of rows)lines.push(`| ${esc(r.product_ref)} | ${esc(r.title)} | ${r.namespace} | ${r.channel} | ${r.currency} | ${value(r.units)} | ${value(r.sales)} | Unavailable | Unavailable |`);
   if(!rows.length)lines.push('Product evidence unavailable; no product observations were returned.');
   for(const c of report.components||[])if(c.status!=='fulfilled')lines.push(`Product source ${c.source} unavailable: ${c.code}.`);
   lines.push(...(report.limitations||[]),`Approved mapping evidence: ${report.mapping_status}. Unmapped source products remain separate.`);
  }else lines.push(`Products unavailable: ${section.products.code}.`);}
 }
 for(const issue of e.resolved_scope.issues)lines.push(`\n${issue.year} ${issue.channel}: ${issue.reason||'Conflicting confirmed dates'}; ${issue.event_ids?.join(', ')||'no supporting entry'}.`);
 let changes=0;
 for(const s of e.sections){const prior=e.sections.find(p=>p.window.year===s.window.year-1&&p.window.channel===s.window.channel&&(p.window.location_name||null)===(s.window.location_name||null));
  if(s.totals.status!=='fulfilled'||prior?.totals.status!=='fulfilled'||s.totals.evidence.coverage?.complete!==true||prior.totals.evidence.coverage?.complete!==true||s.totals.evidence.definition!==prior.totals.evidence.definition)continue;
  for(const r of totalsRows(s.totals.evidence,s.window.channel)){const p=totalsRows(prior.totals.evidence,prior.window.channel).find(p=>p.source===r.source&&p.channel===r.channel&&p.currency===r.currency);if(!p||r.channel==='unknown'||num(p.sales)==null||num(r.sales)==null)continue;changes++;lines.push(`Year-on-year ${s.window.year} vs ${prior.window.year}, ${r.source} ${r.channel} ${r.currency}: change ${value(r.sales-p.sales)}, ${p.sales>0?((r.sales/p.sales-1)*100).toFixed(2)+'%':'percentage unavailable (nonpositive baseline)'}.`);}
 }
 if(!changes&&e.requested_scope.sale_scope.years.length>1)lines.push('Year-on-year changes unavailable: both exact channel windows need verified complete coverage and identical metric, source and currency definitions.');
 lines.push('Migration: Matrixify Shopify imports and legacy Shopify finance rows are excluded by the governed authority. Legitimate Woo/native Shopify overlap is retained; same-day overlap does not prove duplicates. Unknown channels remain separate, and incomplete source coverage must not be read as zero.');
 const conflict=e.resolved_scope.issues.find(i=>i.type==='ambiguous');if(conflict)lines.push(`Which of the conflicting confirmed ${conflict.year} ${conflict.channel} sale records (${conflict.event_ids.join(', ')}) should define that section?`);
 return lines.join('\n');
}
export function createEventSaleReportService({knowledgeService,provider,now=Date.now}){
 return async(message,options={})=>{
  const context=options.analysisContext,scope=context?.event_scope;if(!scope)return null;
  const stage=e=>options.onProviderStage?.(e),asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date(now()));
  stage({stage:'event_knowledge_resolution',status:'started',years:scope.years,channels:scope.channels});
  const searches=[{text:null,tags:['black-friday'],status:null},{text:context.event_name,tags:[],status:'confirmed'}];
  const reads=await Promise.allSettled(searches.map(s=>knowledgeService.searchKnowledge({...s,knowledge_type:'event',start_date:null,end_date:null,limit:50})));
  const items=[...new Map(reads.flatMap(r=>r.status==='fulfilled'?(r.value.items||[]):[]).map(r=>[r.id,r])).values()];
  const resolved=resolveEventSaleWindows(items,scope,asOf),sections=[];
  stage({stage:'event_knowledge_resolution',status:'success',window_count:resolved.windows.length,issue_count:resolved.issues.length,failed_reads:reads.filter(r=>r.status==='rejected').length});
  stage({stage:'event_capability_selection',status:'resolved',metrics:context.metrics,source_grains:['canonical_transaction_date','source_product_line'],currency_policy:'separate'});
  const execute=async(operation,w)=>{stage({stage:'event_'+operation,status:'started',window_id:w.id,start_date:w.start_date,end_date:w.end_date,channel:w.channel});try{const evidence=await provider[operation](w);if(stableAnalyticalJSON(evidence.period)!==stableAnalyticalJSON(w))throw Object.assign(Error('Scope mismatch'),{code:'EVIDENCE_SCOPE_MISMATCH'});stage({stage:'event_'+operation,status:'success',window_id:w.id});return {status:'fulfilled',evidence};}catch(error){stage({stage:'event_'+operation,status:'failed',window_id:w.id,code:code(error)});return {status:'failed',code:code(error)};}};
  for(const window of resolved.windows){const operations=await Promise.all([execute('totals',window),...(scope.products?[execute('products',window)]:[])]);sections.push({window,totals:operations[0],...(scope.products?{products:operations[1]}:{})});}
  const evidence={kind:'historical_event_comparison',version:'event_sale_report.v1',subject:'sales',metrics:context.metrics,requested_scope:{event:context.event_name,count:context.event_count,sale_scope:scope,as_of:asOf,currencies:'separate'},knowledge_entries:items,knowledge_retrieval:reads.map((r,i)=>({scope:searches[i],status:r.status,...(r.status==='rejected'?{code:'EVENT_KNOWLEDGE_RETRIEVAL_FAILED'}:{returned_count:r.value.items?.length||0})})),resolved_scope:resolved,sections,periods:resolved.windows.map(w=>({event_id:w.id,start_date:w.start_date,end_date:w.end_date,channel:w.channel})),complete:false};
  stage({stage:'event_answer_completeness',status:'partial',successful_totals:sections.filter(s=>s.totals.status==='fulfilled').length,successful_products:sections.filter(s=>s.products?.status==='fulfilled').length,coverage_verified:false});
  return {answer:renderEventSaleReport(evidence),analysis_context:context,evidence,partial:true,tools:['search_knowledge','canonical_finance','event_product_lines']};
 };
}
export function assertEventSaleEvidence(context,e){
 const fail=()=>{throw Object.assign(Error('Event sale scope mismatch'),{code:'EVIDENCE_SCOPE_MISMATCH'});};
 if(e.version!=='event_sale_report.v1'||stableAnalyticalJSON(context.event_scope)!==stableAnalyticalJSON(e.requested_scope?.sale_scope)||e.requested_scope.event!==context.event_name||e.subject!=='sales')fail();
 if(e.requested_scope.count!==context.event_count||stableAnalyticalJSON(e.metrics)!==stableAnalyticalJSON(context.metrics)||stableAnalyticalJSON(resolveEventSaleWindows(e.knowledge_entries||[],context.event_scope,e.requested_scope.as_of))!==stableAnalyticalJSON(e.resolved_scope))fail();
 if(e.sections?.length!==e.resolved_scope.windows.length)fail();
 const ids=new Set();
 for(const s of e.sections||[]){const w=s.window;if(!w||ids.has(w.id)||!context.event_scope.years.includes(w.year)||!context.event_scope.channels.includes(w.channel)||!valid(w.start_date)||!valid(w.end_date)||w.start_date>w.end_date||!w.knowledge_entries?.length||w.knowledge_entries.some(k=>k.status!=='confirmed'))fail();if(!e.resolved_scope.windows.some(r=>stableAnalyticalJSON(r)===stableAnalyticalJSON(w)))fail();ids.add(w.id);
  if(s.totals.status==='fulfilled'&&(s.totals.evidence.definition!=='canonical_net_gross'||!Array.isArray(s.totals.evidence.rows)))fail();
  if(context.event_scope.products&&!s.products)fail();
  if(s.products?.status==='fulfilled'&&(s.products.evidence.definition!=='source_native_product_line_sales'||!Array.isArray(s.products.evidence.rows)))fail();
  for(const result of [s.totals,...(s.products?[s.products]:[])])if(result.status==='fulfilled'&&stableAnalyticalJSON(result.evidence?.period)!==stableAnalyticalJSON(w))fail();
 }
 return true;
}
