const EXACT_BASELINE=/^can you give me an overview of current baseline kpis[?.!\s]*$/i;
export const isBaselineOverviewRequest=message=>EXACT_BASELINE.test(String(message||'').trim());
const iso=value=>value instanceof Date?value.toISOString():new Date(value).toISOString();
const day=value=>iso(value).slice(0,10);
const number=value=>value==null?'unavailable':Number(value).toLocaleString('en-GB',{maximumFractionDigits:2});
const money=(value,currency='GBP')=>value==null?'unavailable':`${currency} ${number(value)}`;
const percent=value=>value==null?'unavailable':`${(Number(value)*100).toFixed(2)}%`;
const recentPeriod=now=>{const end=new Date(now),start=new Date(end);start.setUTCDate(start.getUTCDate()-29);return{start_date:day(start),end_date:day(end)}};
const previousMonth=now=>{const end=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),0));return{start_date:`${end.toISOString().slice(0,7)}-01`,end_date:day(end)}};
const label=p=>`${p.start_date} to ${p.end_date}`;
const unavailable=(name,error)=>`- **${name}:** unavailable (${error?.code||'retrieval failed'}); this is missing evidence, not zero.`;
function emailAggregate(rows,kind){const selected=(rows||[]).filter(row=>String(row.report_kind).toLowerCase()===kind);if(!selected.length)return null;const sum=key=>selected.reduce((n,row)=>n+(Number(row[key])||0),0),currencies=[...new Set(selected.map(row=>row.currency).filter(Boolean))];return{delivered:sum('delivered'),clicks:sum('unique_clicks'),conversions:sum('attributed_conversion_events'),revenue:sum('attributed_conversion_value'),currency:currencies.length===1?currencies[0]:null}}

/** Deterministic orchestration for the broad baseline request. Inventory is deliberately absent. */
export function createBaselineOverviewService({finance,shopifyConversion,shopifySales,shopifyDevice,klaviyo,paidAdvertising=null,now=()=>new Date()}){
  return async message=>{
    if(!isBaselineOverviewRequest(message))return null;
    const requestedAt=new Date(now()),recent=recentPeriod(requestedAt),emailPeriod=previousMonth(requestedAt);
    const specs=[['finance','get_sales_summary',()=>finance({...recent,currency:'GBP'})],['sessions','get_shopify_conversion_kpis',()=>shopifyConversion({...recent,timeseries:'none'})],['sales','get_shopify_sales_kpis',()=>shopifySales({...recent,timeseries:'none'})],['device','get_shopify_device_conversion_by_traffic_source',()=>shopifyDevice('get_shopify_device_conversion_by_traffic_source',recent)],['klaviyo','get_klaviyo_email_performance',()=>klaviyo('get_klaviyo_email_performance',emailPeriod)]];
    if(paidAdvertising)specs.push(['paid','get_paid_advertising_performance',paidAdvertising]);
    const settled=await Promise.allSettled(specs.map(spec=>spec[2]()));
    const evidence=Object.fromEntries(specs.map(([key,tool],i)=>[key,{tool,result:settled[i],retrieved_at:iso(now())}]));
    const lines=['## Current baseline KPIs','Each source uses its own reporting window and retrieval timestamp; coverage and freshness are not assumed to match.'];
    const f=evidence.finance.result;lines.push(`\n### Finance — ${label(recent)} · retrieved ${evidence.finance.retrieved_at}`);
    if(f.status==='fulfilled')lines.push(`- Net sales excluding recorded tax: **${money(f.value?.net_ex_tax)}**; net gross: **${money(f.value?.net_gross)}**.`,'- Finance reconciliation remains unresolved: this overview does not represent these governed ledger totals as independently source-reconciled.');else lines.push(unavailable('Finance',f.reason));
    const c=evidence.sessions.result,s=evidence.sales.result,d=evidence.device.result;lines.push(`\n### Shopify Online Store — ${label(recent)} · retrieved ${[evidence.sessions.retrieved_at,evidence.sales.retrieved_at,evidence.device.retrieved_at].sort().at(-1)}`);
    if(c.status==='fulfilled')lines.push(`- Sessions: **${number(c.value?.metrics?.sessions)}**; completed-checkout sessions: **${number(c.value?.metrics?.sessions_that_completed_checkout)}**; conversion rate: **${percent(c.value?.metrics?.conversion_rate)}**.`);else lines.push(unavailable('Sessions',c.reason));
    if(s.status==='fulfilled')lines.push(`- Orders: **${number(s.value?.metrics?.orders)}**; AOV: **${money(s.value?.metrics?.average_order_value)}**. These are compatible Shopify operational definitions, not finance reconciliation.`);else lines.push(unavailable('Orders and AOV',s.reason));
    if(d.status==='fulfilled'){const devices=new Map();for(const row of d.value?.rows||[]){const item=devices.get(row.device_type)||{sessions:0,checkouts:0};item.sessions+=Number(row.sessions)||0;item.checkouts+=Number(row.completed_checkout_sessions??row.numerator)||0;devices.set(row.device_type,item)}lines.push(devices.size?`- Device breakdown: ${[...devices].map(([name,v])=>`**${name}** ${number(v.sessions)} sessions, ${number(v.checkouts)} completed-checkout sessions (${percent(v.sessions?v.checkouts/v.sessions:null)})`).join('; ')}.`:'- Device breakdown: unavailable; no covered rows were returned (not zero).');}else lines.push(unavailable('Device breakdown',d.reason));
    const k=evidence.klaviyo.result;lines.push(`\n### Klaviyo — ${label(emailPeriod)} · retrieved ${evidence.klaviyo.retrieved_at}`);
    if(k.status==='fulfilled'){for(const kind of ['campaign','flow']){const a=emailAggregate(k.value?.rows,kind),title=kind==='campaign'?'Campaigns':'Flows';lines.push(a?`- **${title}:** ${number(a.delivered)} delivered emails; ${number(a.clicks)} unique clicks; ${number(a.conversions)} attributed conversion events; attributed revenue ${a.currency?money(a.revenue,a.currency):`${number(a.revenue)} (mixed/unknown currency)`}.`:`- **${title}:** unavailable; no collected rows were returned (not zero).`)}const provisional=(k.value?.coverage?.windows||[]).some(window=>window.attribution_provisional||window.partial);lines.push(`- Attribution is **${provisional?'provisional':'non-incremental'}**: attributed events and revenue are not finance sales and must not be added to them.`)}else lines.push(unavailable('Klaviyo',k.reason));
    lines.push('\n### Paid advertising');if(!evidence.paid)lines.push('- Not shown: no governed collected paid-advertising evidence source is registered for this overview.');else if(evidence.paid.result.status==='rejected')lines.push(unavailable('Paid advertising',evidence.paid.result.reason));else lines.push(`- Collected evidence retrieved ${evidence.paid.retrieved_at}: ${JSON.stringify(evidence.paid.result.value)}`);
    const missing=Object.entries(evidence).filter(([,item])=>item.result.status==='rejected').map(([key])=>key);if(missing.length)lines.push(`\n**Missing sections:** ${missing.join(', ')} could not be retrieved. Available independent sections are retained; retry the missing source later.`);
    return{answer:lines.join('\n'),tools:specs.filter((_,i)=>settled[i].status==='fulfilled').map(spec=>spec[1]),attempted_tools:specs.map(spec=>spec[1])};
  };
}
