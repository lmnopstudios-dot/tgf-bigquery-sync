const DATE=/^\d{4}-\d{2}-\d{2}$/;
const BF=/\bblack\s+friday\b/i;

const iso=value=>value?.value||value||null;
const n=value=>value==null||value===''?null:Number.isFinite(Number(value))?Number(value):null;
const fmt=value=>value==null?'unavailable':Number(value).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(value,currency)=>value==null?'unavailable':`${currency} ${fmt(value)}`;
const days=(start,end)=>Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
const safeCode=error=>String(error?.code||error?.name||'SOURCE_FAILED').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,60);

export function isHistoricalEventComparison(message){
  const text=String(message||'');
  return BF.test(text)&&/\b(?:last|previous|recent|compare|comparison|overview|sales?|years?)\b/i.test(text);
}

/** Select only reviewed, completed event records. Knowledge supplies scope, never totals. */
export function resolveHistoricalEvents(items,{asOf=new Date(),count=3,eventPattern=BF}={}){
  const requestDate=new Date(asOf).toISOString().slice(0,10),candidates=(items||[]).filter(item=>item.kind==='event'&&item.status==='confirmed')
    .filter(item=>eventPattern.test(`${item.title||''} ${(item.tags||[]).join(' ')}`));
  const invalid=[],byYear=new Map();
  for(const item of candidates){
    const start=iso(item.effective_from??item.start_date),end=iso(item.effective_to??item.end_date??start),year=Number(String(start||'').slice(0,4));
    if(!DATE.test(String(start))||!DATE.test(String(end))||start>end){invalid.push({id:item.id,title:item.title||'Unnamed event',reason:'missing or invalid reviewed start/end dates'});continue;}
    if(end>=requestDate)continue;
    const normalized={id:item.id,name:item.title,year,start_date:start,end_date:end,duration_days:days(start,end),timezone:item.timezone||null,date_precision:item.date_precision||null,provenance:{status:item.status,source_type:item.source_type||null,source_reference:item.source_reference||null,recorded_at:item.recorded_at||null}};
    const same=byYear.get(year)||[];same.push(normalized);byYear.set(year,same);
  }
  const conflicts=[];for(const [year,rows] of byYear)if(new Set(rows.map(row=>`${row.start_date}|${row.end_date}`)).size>1)conflicts.push({year,event_ids:rows.map(x=>x.id),periods:rows.map(x=>`${x.start_date} to ${x.end_date}`),reason:'conflicting confirmed event dates'});
  const blocked=new Set(conflicts.map(x=>x.year));
  const events=[...byYear.entries()].filter(([year])=>!blocked.has(year)).map(([,rows])=>rows.sort((a,b)=>String(b.provenance.recorded_at).localeCompare(String(a.provenance.recorded_at)))[0]).sort((a,b)=>b.end_date.localeCompare(a.end_date)).slice(0,count);
  return{request_date:requestDate,requested_count:count,events,conflicts,invalid,complete:events.length===count&&conflicts.length===0};
}

function eventCount(message){const match=String(message).match(/\blast\s+(\d{1,2})\s+(?:black\s+friday\s+)?(?:sales?|years?)\b/i);return Math.max(1,Math.min(Number(match?.[1]||3),5));}
function financeRows(report){return report?.finance?.current||report?.finance||[];}
function historicalSources(report){return report?.customers?.historical?.current||report?.historical?.current?.sources||report?.historical_ecommerce?.current?.sources||[];}
function sourceStatus(report,event){
  const woo=historicalSources(report).map(x=>x.source||x.dataset||'woo');
  const shopify=report?.conversion?.current||report?.customers?.current||report?.products?.current?.length?['shopify_native']:[];
  return{woo,shopify,period:event.start_date+' to '+event.end_date,matrixify:'excluded by governed source services; never a second Shopify sale'};
}
function renderEvent(section){
  const {event,report}=section,lines=[`## ${event.name} (${event.year})`,`**Applied sale period:** ${event.start_date} to ${event.end_date} (${event.duration_days} days); timezone ${event.timezone||'not stored on the event record (reporting dates are used as recorded)'}.`,`**Event provenance:** confirmed ${event.id}; ${event.provenance.source_type||'source type unavailable'}; ${event.provenance.source_reference||'source reference unavailable'}; recorded ${event.provenance.recorded_at||'time unavailable'}.`];
  if(section.status!=='fulfilled')return lines.concat(`- **Sales evidence unavailable:** ${section.error_code}; this event failed independently and no zero was substituted.`);
  lines.push(`- **Supported platform segments:** historical Woo ${section.source_status.woo.length?section.source_status.woo.join(', '):'unavailable'}; native Shopify ${section.source_status.shopify.length?'available':'unavailable'}. Segments are disclosed separately and are not silently merged.`);
  const finance=financeRows(report);if(!finance.length)lines.push('- No supported monetary rows were returned; missing evidence is not zero.');
  for(const row of finance){const orders=n(row.sales_transaction_count??row.orders),gross=n(row.gross_sales),refunds=n(row.refunds),net=n(row.net_gross??row.net_sales),currency=row.currency||'currency unavailable';lines.push(`- **${currency}:** eligible sale transactions ${fmt(orders)}; gross sales ${money(gross,currency)}; recorded refunds ${money(refunds==null?null:Math.abs(refunds),currency)}; net gross ${money(net,currency)}; value per eligible sale transaction ${money(orders>0&&net!=null?net/orders:null,currency)}; net gross/day ${money(net==null?null:net/event.duration_days,currency)}.`);}
  const conversion=report?.conversion?.current;if(conversion)lines.push(`- **Historical behaviour (Shopify-native definition):** sessions ${fmt(conversion.sessions)}; added-to-cart sessions ${fmt(conversion.sessions_with_cart_additions)}; reached-checkout sessions ${fmt(conversion.sessions_that_reached_checkout)}; completed-checkout sessions ${fmt(conversion.sessions_that_completed_checkout)}; conversion ${conversion.conversion_rate==null?'unavailable':`${(Number(conversion.conversion_rate)*100).toFixed(2)}%`}. Orders remain distinct from completed-checkout sessions.`);else lines.push('- **Historical behaviour:** unavailable for this event/platform period; sales evidence above remains valid and no unrelated sessions were substituted.');
  const wooProducts=(report?.products?.historical?.current||[]).flatMap(source=>source.products||[]),products=(report?.products?.current?.length?report.products.current:wooProducts).slice(0,5);if(products.length){lines.push('- **Leading supported products:** '+products.map(x=>`${String(x.product_title||x.product_name||x.name||'Unknown').slice(0,80)} (${fmt(x.net_items_sold??x.quantity_sold)} units; ${money(n(x.net_sales??x.net_line_sales),x.currency||finance[0]?.currency||'currency unavailable')})`).join('; ')+'.');}else lines.push('- Units and leading products are unavailable from a compatible source for this period.');
  const customer=report?.customers?.current?.overall;if(customer)lines.push(`- **Shopify-native customer evidence:** new ${fmt(customer.new_customers)}; returning ${fmt(customer.returning_customers)}; returning-customer rate ${customer.returning_customer_rate==null?'unavailable':`${(Number(customer.returning_customer_rate)*100).toFixed(2)}%`}.`);else lines.push('- New/returning customer evidence is unavailable; no cross-platform identity was inferred.');
  return lines;
}

/** Bounded, lazy orchestration. Every event is an independent failure boundary. */
export function createHistoricalEventComparisonService({knowledgeService,collectEvent,now=()=>new Date(),concurrency=2,queryTimeoutMs=55_000}){
  if(!knowledgeService?.searchKnowledge||typeof collectEvent!=='function')throw new Error('knowledgeService and collectEvent are required');
  return async message=>{
    if(!isHistoricalEventComparison(message))return null;
    const requested_at=new Date(now()),count=eventCount(message),knowledge=await knowledgeService.searchKnowledge({text:null,knowledge_type:'event',start_date:null,end_date:null,status:'confirmed',tags:['black-friday'],limit:50});
    const resolved=resolveHistoricalEvents(knowledge.items,{asOf:requested_at,count}),sections=new Array(resolved.events.length),limit=Math.max(1,Math.min(concurrency,2));let cursor=0;
    const bounded=async event=>{let timer;try{return await Promise.race([collectEvent(event),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('bounded event query timeout'),{code:'EVENT_QUERY_TIMEOUT'})),queryTimeoutMs);timer.unref?.();})]);}finally{clearTimeout(timer);}};
    const worker=async()=>{while(cursor<resolved.events.length){const index=cursor++,event=resolved.events[index],query_started_at=new Date(now()).toISOString();try{const report=await bounded(event);sections[index]={event,status:'fulfilled',report,source_status:sourceStatus(report,event),query_started_at,query_completed_at:new Date(now()).toISOString()};}catch(error){sections[index]={event,status:'rejected',error_code:safeCode(error),query_started_at,query_completed_at:new Date(now()).toISOString()};}}};
    await Promise.all(Array.from({length:Math.min(limit,resolved.events.length)},worker));
    const lines=['# Black Friday sale comparison',`**Request as of:** ${resolved.request_date}. Selected the ${count} most recent completed, confirmed Black Friday sale records; nominal Friday–Monday dates were not substituted.`];
    if(resolved.conflicts.length)lines.push('## Event scope requiring clarification',...resolved.conflicts.map(x=>`- ${x.year}: ${x.reason}: ${x.periods.join(' versus ')} (${x.event_ids.join(', ')}).`));
    if(resolved.invalid.length)lines.push(...resolved.invalid.map(x=>`- ${x.title} (${x.id}) needs clarification: ${x.reason}.`));
    if(resolved.events.length<count)lines.push(`- Only ${resolved.events.length} independently resolved completed event(s) were available; ${count-resolved.events.length} remain unavailable rather than invented.`);
    for(const section of sections)lines.push('',...renderEvent(section));
    lines.push('','## Comparison boundaries','- Knowledge records define event scope only. Every figure above comes from governed analytical source services; knowledge narrative was not used as a sales total.','- Currencies remain separate. Percentage changes are intentionally omitted where source/metric compatibility is not established or the earlier denominator is zero. Different event durations are shown with per-day measures.','- Online behavioural evidence is kept separate from company-wide finance. No migration causality is asserted. Matrixify representations are excluded by governed source services; retired Woo remains historical/reportable.');
    const evidence={version:'historical_event_comparison.v1',requested_scope:{event:'Black Friday',count,as_of:resolved.request_date,metrics:['eligible_orders','supported_sales','discounts','recorded_refunds','value_per_eligible_order','units','daily_sales_orders','peak_day','customers','products','conversion'],currencies:'separate',channel:'online where source-qualified; finance otherwise explicitly labelled'},resolved_scope:resolved,sections,collected_at:new Date(now()).toISOString()};
    return{answer:lines.join('\n'),evidence,tools:['search_knowledge','get_ecommerce_management_report']};
  };
}
