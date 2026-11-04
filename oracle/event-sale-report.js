import {resolveLegacyEventSaleWindows} from './event-sale-windows-v1.js';
import {resolveSaleSessions} from './event-sale-sessions.js';
import {resolveHistoricalEvents} from './historical-event-comparison.js';
import {storedTemporal,provenanceCode} from './event-presentation.js';
import {stableAnalyticalJSON} from './analytical-plan.js';
const code=e=>/^[A-Z0-9_]{1,70}$/.test(String(e?.code))?e.code:'EVENT_SECTION_FAILED';
const channel=r=>/^(?:online)$/i.test(r.channel)?'online':/^(?:pos|in[- ]?store|retail)$/i.test(r.channel)?'instore':'unknown';
const num=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const value=(n,c)=>num(n)==null?'Unavailable':`${c||''} ${Number(n).toLocaleString('en-GB',{maximumFractionDigits:2})}`.trim();
const esc=s=>String(s??'Unavailable').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export {resolveSaleSessions as resolveEventSaleWindows} from './event-sale-sessions.js';
const resolveEventSaleWindows=resolveSaleSessions;

function totalsRows(report,ch){
 const groups=new Map();
 for(const r of report.rows||[]){if(channel(r)!==ch&&channel(r)!=='unknown')continue;
  const key=JSON.stringify([r.source,r.channel,r.currency]),g=groups.get(key)||{source:r.source,channel:channel(r),currency:r.currency,sales:null,gross_sales:null,refunds:null,refund_events:null,observed:false};
  const currencyKnown=/^[A-Z]{3}$/.test(r.currency||'');const amount=currencyKnown?num(r.amount):null;
  // A net total includes only observed sale/refund components; a missing
  // currency amount never turns into zero.
  g.sales=!g.observed?amount:g.sales==null||amount==null?null:g.sales+amount;g.observed=true;
  if(r.transaction_type==='sale')g.gross_sales=amount;
  if(r.transaction_type==='refund'){g.refunds=currencyKnown?num(r.amount):null;g.refund_events=num(r.refund_events);}
  groups.set(key,g);
 }return [...groups.values()].map(g=>({...g,sales:report.requires_refund_evidence&&(g.refunds==null||(report.components||[]).some(c=>c.measure==='refunds'&&c.status!=='fulfilled'&&(g.source==='Square'&&c.source==='square'||g.source==='Shopify Online Store'&&c.source==='shopify'||g.source==='WooCommerce '+c.source)))?null:g.sales}));
}
export function renderEventSaleReport(e){
 const lines=[`# ${e.requested_scope.event} sale periods`,'Sales definition: canonical finance gross sales less accounting refunds, including tax, within one currency. Refunds use the refund transaction date. Product line sales are separate source-native operational measures; they do not reconcile to finance totals. Currencies are never converted or combined.'];
 for(const read of e.knowledge_retrieval||[])if(read.status==='rejected')lines.push(`Knowledge retrieval incomplete: ${read.code}; absence of records has not been established.`);
 for(const section of e.sections){const w=section.window;
  lines.push(`\n## ${w.year} · ${w.channel}${w.location_name?' · '+esc(w.location_name):''}`,`Sale window: **${w.start_date} to ${w.end_date}**, inclusive. Reporting timezone: ${esc(w.timezone)} (${esc(w.timezone_provenance)}).`);
  for(const r of w.knowledge_entries)lines.push(`Knowledge ${provenanceCode(r.id)} — ${esc(r.title)}: ${storedTemporal(r.effective_from??r.start_date)} to ${storedTemporal(r.effective_to??r.end_date)}; ${provenanceCode(r.source_reference)}; status ${r.status}; recorded ${storedTemporal(r.recorded_at)||'unavailable'}. ${esc(r.content||r.description||'')}`);
  if(w.start_at&&w.end_exclusive)lines.push(`${w.time_precision==='date_only'?'Calendar-date bounds (exact hours unavailable)':'Exact session'}: ${w.start_at} ≤ transaction time < ${w.end_exclusive}. ${esc(w.time_basis)}`);
  if(w.time_issue)lines.push(`Exact session unavailable: ${w.time_issue}; ${esc(w.endpoint_wording||'missing clock evidence')}. No whole-day replacement was used.`);
  lines.push('Sales in this window are not proof of a campaign discount. Campaign-discount attribution remains unavailable without matched discount evidence.');
  if(section.totals.status==='fulfilled'){
   for(const c of section.totals.evidence.components||[])if(c.status!=='fulfilled')lines.push(`Missing ${c.source} ${c.measure}: ${c.code}.`);
   if(section.totals.evidence.exact_hours===false)lines.push('Calendar-date observations only: exact sale-hour totals are unavailable because the knowledge entries do not record opening/closing hours. These figures are not a substitute for an exact-hour section.');
   lines.push(`Measure: ${section.totals.evidence.definition==='timestamped_source_net_gross'?'timestamped source payments/orders less refund events; ledger reconciliation unverified':'canonical finance net gross'}. ${esc((section.totals.evidence.limitations||[]).join(' '))}`);
   if(section.totals.evidence.location_evidence)lines.push(`Verified location: ${esc(section.totals.evidence.location_evidence.location_name)} — ${esc(section.totals.evidence.location_evidence.location_id)} (${esc(section.totals.evidence.location_evidence.source)}).`);
   const rows=totalsRows(section.totals.evidence,w.channel);
   lines.push('| Source | Channel | Currency | Gross sales incl. tax | Sales after refunds incl. tax | Refund value (signed) | Refund events |','|---|---|---|---:|---:|---:|---:|');
   for(const r of rows)lines.push(`| ${esc(r.source)} | ${r.channel} | ${r.currency} | ${value(r.gross_sales)} | ${value(r.sales)} | ${value(r.refunds)} | ${value(r.refund_events)} |`);
   const byCurrency=new Map();for(const r of rows.filter(r=>r.channel===w.channel)){const prior=byCurrency.get(r.currency);byCurrency.set(r.currency,prior===undefined?r.sales:prior==null||r.sales==null?null:prior+r.sales);}
   for(const [currency,total]of byCurrency)lines.push(`${w.channel} ${currency} ${section.totals.evidence.coverage?.complete===true?'total':'observed subtotal (coverage unverified)'}: ${value(total,currency)}. Unknown channels are excluded from this subtotal.`);
   if(!rows.length)lines.push('Total sales unavailable: no qualifying transaction observations were returned; this does not establish zero.');
  }else lines.push(`Total sales unavailable: ${section.totals.code}.`);
  if(section.products){if(section.products.status==='fulfilled'){
   const report=section.products.evidence;
   if(report.location_evidence)lines.push(`Verified product location: ${esc(report.location_evidence.location_name)} — ${esc(report.location_evidence.location_id)}.`);
   const rows=report.rows.filter(r=>r.channel===w.channel||r.channel==='unknown').sort((a,b)=>String(a.currency).localeCompare(String(b.currency))||String(a.namespace).localeCompare(String(b.namespace))||(num(b.sales)??-Infinity)-(num(a.sales)??-Infinity));
   lines.push('Products ranked by line sales within source and currency:','| Product identity | Product | Source | Channel | Currency | Units | Line sales | Refunded units | Product refunds |','|---|---|---|---|---|---:|---:|---:|---:|');
   for(const r of rows)lines.push(`| ${esc(r.product_ref)} | ${esc(r.title)} | ${r.namespace} | ${r.channel} | ${r.currency} | ${value(r.units)} | ${value(r.sales)} | Unavailable | Unavailable |`);
   if(!rows.length)lines.push('Product evidence unavailable; no product observations were returned.');
   for(const c of report.components||[])if(c.status!=='fulfilled')lines.push(`Product source ${c.source} unavailable: ${c.code}.`);
   lines.push(...(report.limitations||[]),`Approved mapping evidence: ${report.mapping_status}. Unmapped source products remain separate.`);
  }else lines.push(`Products unavailable: ${section.products.code}.`);}
 }
 for(const issue of e.resolved_scope.issues){
  lines.push(`\n${issue.year} ${issue.channel}: ${issue.reason||'Conflicting confirmed dates'}; ${issue.event_ids?.join(', ')||'no supporting entry'}.`);
  for(const r of issue.candidates||[])lines.push(`${provenanceCode(r.id)} — ${esc(r.title)} · ${esc(r.store)} · ${r.start_at||r.start_date} to ${r.end_exclusive||r.end_date}.`);
 }
 let changes=0;
 for(const s of e.sections){const prior=e.sections.find(p=>p.window.year===s.window.year-1&&p.window.channel===s.window.channel&&(p.window.location_name||null)===(s.window.location_name||null));
  if(s.totals.status!=='fulfilled'||prior?.totals.status!=='fulfilled'||s.totals.evidence.coverage?.complete!==true||prior.totals.evidence.coverage?.complete!==true||s.totals.evidence.definition!==prior.totals.evidence.definition)continue;
  for(const r of totalsRows(s.totals.evidence,s.window.channel)){const p=totalsRows(prior.totals.evidence,prior.window.channel).find(p=>p.source===r.source&&p.channel===r.channel&&p.currency===r.currency);if(!p||r.channel==='unknown'||num(p.sales)==null||num(r.sales)==null)continue;changes++;lines.push(`Year-on-year ${s.window.year} vs ${prior.window.year}, ${r.source} ${r.channel} ${r.currency}: change ${value(r.sales-p.sales)}, ${p.sales>0?((r.sales/p.sales-1)*100).toFixed(2)+'%':'percentage unavailable (nonpositive baseline)'}.`);}
 }
 if(!changes&&e.requested_scope.sale_scope.years.length>1)lines.push('Year-on-year changes unavailable: both exact channel windows need verified complete coverage and identical metric, source and currency definitions.');
 lines.push(e.requested_scope.sale_scope.source_policy?'Source split: 2025 online uses Shopify Online Store; 2024 online uses WooCommerce; in-store uses Square only. Matrixify-imported Woo orders are excluded from Shopify. Missing sources and stores remain unavailable; window membership does not prove a campaign discount.':'Migration: Matrixify Shopify imports and legacy Shopify finance rows are excluded by the governed authority. Legitimate Woo/native Shopify overlap is retained; same-day overlap does not prove duplicates. Unknown channels remain separate, and incomplete source coverage must not be read as zero.');
 const midnight=e.sections.find(s=>s.window.time_issue==='AMBIGUOUS_MIDNIGHT_ENDPOINT');
 if(midnight)lines.push(`For online record ${midnight.window.knowledge_entries[0].id}, does the documented midnight cutoff mean the start or end of ${midnight.window.end_date}?`);
 const conflict=e.resolved_scope.issues.find(i=>i.type==='ambiguous');if(conflict&&!midnight)lines.push(`Which of the conflicting confirmed ${conflict.year} ${conflict.channel} sale records (${conflict.event_ids.join(', ')}) should define that section?`);
 return lines.join('\n');
}
export function createEventSaleReportService({knowledgeService,provider,now=Date.now}){
 return async(message,options={})=>{
  const context=options.analysisContext,scope=context?.event_scope;if(!scope)return null;
  const activeProvider=provider.forRequest?provider.forRequest(options):provider;
  const stage=e=>options.onProviderStage?.(e),asOf=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date(now()));
  stage({stage:'event_knowledge_resolution',status:'started',years:scope.years,channels:scope.channels});
  const searches=[{text:null,tags:['black-friday'],status:null},{text:context.event_name,tags:[],status:'confirmed'}];
  const reads=await Promise.allSettled(searches.map(s=>knowledgeService.searchKnowledge({...s,knowledge_type:'event',start_date:null,end_date:null,limit:50})));
  const items=[...new Map(reads.flatMap(r=>r.status==='fulfilled'?(r.value.items||[]):[]).map(r=>[r.id,r])).values()];
  const resolved=resolveEventSaleWindows(items,scope,asOf),sections=[];
  stage({stage:'event_knowledge_resolution',status:reads.every(r=>r.status==='rejected')?'failed':'success',window_count:resolved.windows.length,issue_count:resolved.issues.length,failed_reads:reads.filter(r=>r.status==='rejected').length});
  stage({stage:'event_capability_selection',status:'resolved',metrics:context.metrics,source_grains:['canonical_transaction_date','source_product_line'],currency_policy:'separate'});
  const execute=async(operation,w)=>{stage({stage:'event_'+operation,status:'started',window_id:w.id,start_date:w.start_date,end_date:w.end_date,channel:w.channel});try{const evidence=await activeProvider[operation](w);if(stableAnalyticalJSON(evidence.period)!==stableAnalyticalJSON(w))throw Object.assign(Error('Scope mismatch'),{code:'EVIDENCE_SCOPE_MISMATCH'});stage({stage:'event_'+operation,status:'success',window_id:w.id});return {status:'fulfilled',evidence};}catch(error){stage({stage:'event_'+operation,status:'failed',window_id:w.id,code:code(error)});return {status:'failed',code:code(error)};}};
  for(const window of resolved.windows){const operations=await Promise.all([execute('totals',window),...(scope.products?[execute('products',window)]:[])]);sections.push({window,totals:operations[0],...(scope.products?{products:operations[1]}:{})});}
  const evidence={kind:'historical_event_comparison',version:'event_sale_report.v2',subject:'sales',metrics:context.metrics,requested_scope:{event:context.event_name,count:context.event_count,sale_scope:scope,as_of:asOf,currencies:'separate'},knowledge_entries:items,knowledge_retrieval:reads.map((r,i)=>({scope:searches[i],status:r.status,...(r.status==='rejected'?{code:'EVENT_KNOWLEDGE_RETRIEVAL_FAILED'}:{returned_count:r.value.items?.length||0})})),resolved_scope:resolved,sections,periods:resolved.windows.map(w=>({event_id:w.id,start_date:w.start_date,end_date:w.end_date,channel:w.channel})),complete:false};
  stage({stage:'event_answer_completeness',status:'partial',successful_totals:sections.filter(s=>s.totals.status==='fulfilled').length,successful_products:sections.filter(s=>s.products?.status==='fulfilled').length,coverage_verified:false});
  return {answer:renderEventSaleReport(evidence),analysis_context:context,evidence,partial:true,tools:['search_knowledge','canonical_finance','event_product_lines']};
 };
}
export function assertEventSaleEvidence(context,e){
 const fail=()=>{throw Object.assign(Error('Event sale scope mismatch'),{code:'EVIDENCE_SCOPE_MISMATCH'});};
 if(!['event_sale_report.v1','event_sale_report.v2'].includes(e.version)||stableAnalyticalJSON(context.event_scope)!==stableAnalyticalJSON(e.requested_scope?.sale_scope)||e.requested_scope.event!==context.event_name||e.subject!=='sales')fail();
 if(e.requested_scope.count!==context.event_count||stableAnalyticalJSON(e.metrics)!==stableAnalyticalJSON(context.metrics)||stableAnalyticalJSON((e.version==='event_sale_report.v1'?resolveLegacyEventSaleWindows:resolveEventSaleWindows)(e.knowledge_entries||[],context.event_scope,e.requested_scope.as_of))!==stableAnalyticalJSON(e.resolved_scope))fail();
 if(e.sections?.length!==e.resolved_scope.windows.length||e.requested_scope.currencies!=='separate'||stableAnalyticalJSON(e.periods)!==stableAnalyticalJSON(e.resolved_scope.windows.map(w=>({event_id:w.id,start_date:w.start_date,end_date:w.end_date,channel:w.channel}))))fail();
 const ids=new Set();
 for(const s of e.sections||[]){const w=s.window;if(!w||ids.has(w.id)||!context.event_scope.years.includes(w.year)||!context.event_scope.channels.includes(w.channel)||!valid(w.start_date)||!valid(w.end_date)||w.start_date>w.end_date||!w.knowledge_entries?.length||w.knowledge_entries.some(k=>k.status!=='confirmed'))fail();if(!e.resolved_scope.windows.some(r=>stableAnalyticalJSON(r)===stableAnalyticalJSON(w)))fail();ids.add(w.id);
  if(s.totals.status==='fulfilled'&&(!['canonical_net_gross','timestamped_source_net_gross'].includes(s.totals.evidence.definition)||!Array.isArray(s.totals.evidence.rows)))fail();
  if(context.event_scope.products&&!s.products)fail();
  if(s.products?.status==='fulfilled'&&(s.products.evidence.definition!=='source_native_product_line_sales'||!Array.isArray(s.products.evidence.rows)))fail();
  if(e.version==='event_sale_report.v2'&&w.source_selection){
   const matches=source=>w.source_selection==='square'?/^square/i.test(source):w.source_selection==='shopify'?/^shopify/i.test(source):/^woo/i.test(source);
   if(s.totals.status==='fulfilled'&&s.totals.evidence.rows.some(r=>!matches(r.source)))fail();
   if(s.products?.status==='fulfilled'&&s.products.evidence.rows.some(r=>!matches(r.namespace)))fail();
  }
  for(const result of [s.totals,...(s.products?[s.products]:[])])if(result.status==='fulfilled'&&stableAnalyticalJSON(result.evidence?.period)!==stableAnalyticalJSON(w))fail();
 }
 return true;
}
