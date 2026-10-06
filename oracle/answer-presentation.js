import { evidenceNumber as numeric } from './numeric-evidence.js';

// Presentation consumes provider contracts; it never retrieves or recomputes evidence.
const text = value => String(value ?? 'Unavailable').replace(/[\r\n]/g, ' ').replaceAll('|', '\\|').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const number = value => numeric(value) == null ? 'Unavailable' : numeric(value).toLocaleString('en-GB', {maximumFractionDigits: 2});
const money = (value, currency) => numeric(value) == null || !/^[A-Z]{3}$/.test(currency || '') ? 'Unavailable' : `${currency} ${number(value)}`;
const rate = value => numeric(value) == null ? 'Unavailable' : `${number(numeric(value) * 100)}%`;
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Intl.DateTimeFormat('en-GB', {day:'numeric', month:'long', year:'numeric', timeZone:'Europe/London'}).format(new Date(`${value}T12:00:00Z`)) : text(value);
const period = p => p?.start_date && p?.end_date ? `${day(p.start_date)}–${day(p.end_date)}` : 'Dates unavailable';
const table = (headers, rows, limit=12) => rows.length ? ['| '+headers.join(' | ')+' |', '|'+headers.map(()=>'---').join('|')+'|', ...rows.slice(0,limit).map(row=>'| '+row.map(text).join(' | ')+' |')].join('\n') + (rows.length>limit ? `\n\nShowing ${limit} rows; the remaining figures are in Show details.` : '') : '';
const failed = value => ['failed','rejected','unavailable'].includes(value?.status) || value?.retrieval_failed || value?.success === false;
const rowsOf = value => value?.rows || value?.results || [];
const businessSeries = value => String(value || 'Sales').replace(/ · (?:shopify|square)\b/gi,'').replace(/ · ww\b/gi,' · International').replace(/ · us\b/gi,' · US').replace(/ · uk\b/gi,' · UK').replace(/ · jp\b/gi,' · Japan');
const knownComplete = e => e.coverage?.complete === true;

/** Zero requires an explicit complete eligible population AND an observed zero.
 * Empty arrays never establish zero, even if a retrieval succeeded. */
export function salesEvidenceState(e) {
  const rows = e.rows || [];
  if (e.retrieval_failed || e.availability === 'provider_failure' || e.retrieval?.length && e.retrieval.every(failed)) return rows.length ? 'partial' : 'failed';
  if (e.retrieval?.some(failed) || e.coverage?.complete === false) return rows.length ? 'partial' : 'empty';
  if (!rows.length) return 'empty';
  return knownComplete(e) && rows.every(r => numeric(r.value) === 0 && numeric(r.units) === 0 && numeric(r.orders_containing_product) === 0) ? 'zero' : 'available';
}
const stateAnswer = state => ({zero:'No sales were recorded.', empty:'No sales records were found. Coverage has not been verified, so this does not establish zero sales.', failed:'Sales could not be retrieved.', partial:'Available sales are shown below. Some sales evidence is missing.', available:'Recorded sales are shown below.'})[state];
const salesTable = e => table(['Period','Source / channel','Sales','Units','Orders containing product'], (e.rows || []).map(r=>[r.period, businessSeries(r.label), money(r.value,r.currency),number(r.units),number(r.orders_containing_product)]));

function sales(e) {
  const state=salesEvidenceState(e), product=e.subject==='product_sales';
  const lines=[stateAnswer(state)];
  if(product) lines.push(`Product: **${text(e.selected_candidate?.catalogue_titles?.[0] || e.entity_query)}**.`);
  if(e.rows?.length) lines.push(product?salesTable(e):table(['Period','Source / channel','Sales after refunds (including tax)'],e.rows.map(r=>[r.period,businessSeries(r.label),money(r.value,r.currency)])));
  if(e.comparison_rows?.length) lines.push('Comparison',product?salesTable({rows:e.comparison_rows}):table(['Period','Source / channel','Sales after refunds (including tax)'],e.comparison_rows.map(r=>[r.period,businessSeries(r.label),money(r.value,r.currency)])));
  if(product && e.comparison_compatible===false) lines.push('Sales changes cannot be verified because complete, compatible comparison coverage is unavailable.');
  if(e.online_comparison) lines.push('Overall online performance cannot be compared reliably across the platform change; the figures describe individual sources.');
  if(!knownComplete(e)&&state==='available') lines.push('Coverage is unverified; the figures may not include all sales.');
  if(e.placement?.context) lines.push('Purchases attributable to the cart cross-sell could not be verified. Its activation date is unconfirmed; these dates are a proxy.');
  if(e.availability?.startsWith('historical_mapping')) lines.push('Historical sales cannot be reliably linked to the selected product.');
  if(e.kind==='governed_sales_explanation') lines.push('Documented events provide context; their contribution to sales and causal impact remain unverified.');
  return lines;
}
function sectionsSummary(e, type) {
  const sections=e.sections || [], rows=[], lines=[];
  for(const s of sections) {
    const p=period(s.period || s.applied_period), result=s.result || s.value || s;
    if(failed(s)){rows.push([p,'Unavailable',...Array(type==='customers'?4:type==='conversion'?3:2).fill('Unavailable')]);continue;}
    if(type==='customers') {
      const r=result?.overall || {};
      rows.push([p,'Shopify',number(r.customers),number(r.new_customers),number(r.returning_customers),number(r.orders)]);
    } else if(type==='conversion') {
      const definition=/GA4|Woo/i.test(s.definition || '')?'WooCommerce':/Shopify/i.test(s.definition || '')?'Shopify':'Native source';
      if(!s.rows?.length) rows.push([p,definition,'Unavailable','Unavailable','Unavailable']);
      for(const r of s.rows || []) rows.push([p,definition,[r.device_type,r.referrer_source || r.traffic_source].filter(Boolean).join(' / '),number(r.sessions),rate(r.rate)]);
    } else {
      const rs=rowsOf(result);
      if(!rs.length) rows.push([p,s.platform || 'Sales','Unavailable','Unavailable']);
      for(const r of rs) {
        if(type==='country') {
          if(!r.country_code)continue;
          const native=r.sources?.find(x=>x.source_platform==='shopify') || r;
          rows.push([p,r.country_name || r.country_code,number(native.orders),money(native.operational_net_sales,r.currency)]);
        } else rows.push([p,[r.source_platform || s.platform,r.source_store].filter(Boolean).join(' / ') || 'Sales',number(r.orders ?? r.eligible_orders),money(r.operational_net_sales ?? r.net_sales ?? r.sales ?? r.total_less_refunds,r.currency)]);
      }
    }
  }
  const allFailed=sections.length>0&&sections.every(failed);
  const noCountryRows=type==='country'&&!sections.some(s=>rowsOf(s.result || s.value || s).some(r=>r.country_code));
  lines.push(allFailed?(type==='conversion'?'Conversion figures could not be retrieved.':type==='customers'?'Customer figures could not be retrieved.':'Sales could not be retrieved.'):noCountryRows?'No sales records were found for named shipping destinations.':type==='customers'?'Customer figures are shown for each period.':type==='conversion'?'Available conversion rates are shown by device and period.':type==='country'?'Sales by shipping destination are shown below.':'Available sales are shown by period and source.');
  lines.push(table(type==='customers'?['Period','Platform','Customers','New customers','Returning customers','Orders']:type==='conversion'?['Period','Platform','Device / source','Sessions','Conversion']:['Period',type==='country'?'Country':'Source','Orders','Net sales'], rows));
  if(sections.some(failed)) lines.push('Some periods could not be retrieved. Available periods remain shown; unavailable figures are not zero.');
  if(type==='customers') lines.push('New and returning classifications may not reconcile to distinct customers. These figures do not establish retention or a first-ever purchase across platforms; monthly counts cannot be added as annual unique customers.');
  if(type==='conversion') {
    if(new Set(sections.map(s=>s.definition).filter(Boolean)).size>1) lines.push('Conversion definitions differ across platforms; the rates are not a like-for-like comparison.');
    if(sections.some(s=>s.period?.partial || s.rows?.some(r=>r.rate==null))) lines.push('Partial or incomplete periods have unavailable rates where a compatible denominator and complete coverage cannot be verified.');
  }
  if(type==='country') {
    const unresolved=sections.some(s=>rowsOf(s.result || s.value).some(r=>numeric(r.unknown_country_orders)>0 || numeric(r.unknown_country_sales)>0));
    if(unresolved) lines.push('Some shipping destinations are unresolved and excluded from the named-country ranking.');
    lines.push('Country rankings do not establish whole-population shares.');
  }
  if(type==='conversion' && !rows.length)lines.push('No conversion records were found; coverage has not been verified.');
  if(type!=='conversion') lines.push('Coverage must be verified before treating these figures as a complete population.');
  return lines;
}
function deviceTrend(e) {
  const sections=[...(e.sections||[])].sort((a,b)=>a.period.start_date.localeCompare(b.period.start_date));
  const lines=['Available conversion rates are shown by device and month.',table(['Month','Mobile','Desktop'],sections.map(s=>[s.period.start_date.slice(0,7),...['mobile','desktop'].map(device=>failed(s)?'Unavailable':rate(s.rows?.find(r=>r.device_type===device)?.rate))]),sections.length)];
  for(const change of e.changes||[])lines.push(`${change.device_type}: ${numeric(change.percentage_point_change)==null?'change unavailable':`${numeric(change.percentage_point_change).toFixed(2)} percentage points`} (${change.comparison_period.start_date.slice(0,7)} → ${change.current_period.start_date.slice(0,7)}).`);
  if((e.changes||[]).length)lines.push('These are descriptive rate changes; causal impact is unverified.');
  if(sections.some(failed))lines.push('Some periods could not be retrieved. Available periods remain shown; unavailable figures are not zero.');
  if(new Set(sections.map(s=>s.definition)).size>1)lines.push('Conversion definitions differ across platforms; the rates are not a like-for-like comparison.');
  if(sections.some(s=>s.rows?.some(r=>r.rate==null)))lines.push('Partial or incomplete periods have unavailable rates because complete coverage and compatible numerators and denominators could not be verified.');
  lines.push(...new Set(sections.flatMap(s=>s.limitations||[])));
  return lines;
}
function businessView(e) {
  if(['governed_product_sales','governed_channel_sales','governed_sales_explanation'].includes(e.kind)) return sales(e);
  if(e.kind==='native_conversion_breakdown')return [...sectionsSummary(e,'conversion'),e.source_evidence?.rows?.some(r=>r.cardinality_limited || r.referrer_source==='__other__')?'Some traffic sources are grouped or hidden; source-level attribution is incomplete.':null,e.source_evidence?.rows?.some(r=>r.measurement_change_warning)?'Session measurement changed during this period; this may affect the apparent trend.':null];
  if(e.kind==='governed_device_conversion')return deviceTrend(e);
  if(e.kind==='focused_woo_historical_conversion')return sectionsSummary(e,'conversion');
  if(['shopify_customer_comparison','shopify_monthly_customer_baseline'].includes(e.kind)) return sectionsSummary(e,'customers');
  if(e.kind==='shopify_shipping_country_comparison')return sectionsSummary(e,'country');
  if(['woo_shopify_monthly_platform_comparison','independent_calendar_month_comparison'].includes(e.kind))return [...sectionsSummary(e,'sales'),'Different source definitions and currencies remain separate; no combined platform uplift or causal effect is established.'];
  if(['ecommerce_monthly_baseline','woo_shopify_platform_comparison'].includes(e.kind)) {
    const items=e.evidence || {}, report=items.management?.result, rows=[];
    for(const r of report?.finance?.current || [])rows.push([period(e.periods?.current),'Company finance','Sales after refunds (including tax)',money(r.net_gross,r.currency)]);
    for(const [key,item] of Object.entries(items)) {
      if(!key.startsWith('country_'))continue;
      const applied=key==='country_current'?e.periods?.current:key==='country_previous'?e.periods?.previous_period:e.periods?.prior_year;
      // Source coverage totals repeat on country rows. Never add these repetitions.
      const seen=new Set();
      for(const r of rowsOf(item.result))for(const source of r.source_coverage || []) {
        const id=[source.source_platform,source.source_store,r.currency].join('|');
        if(seen.has(id))continue;seen.add(id);
        rows.push([period(applied),`${source.source_platform} ${source.source_store || ''}`,'Operational sales',money(source.eligible_sales,r.currency)]);
      }
    }
    const current=report?.conversion?.current;
    if(current)rows.push([period(e.periods?.current),'Shopify Online Store','Conversion',rate(current.conversion_rate)]);
    return [rows.length?'Available business figures are shown below.':'No business figures were found for the requested periods.',table(['Period','Scope','Metric','Value'],rows),
      Object.values(items).some(failed)?'Some parts of this report could not be retrieved; available figures remain shown.':null,
      'Company finance and operational sales use different definitions. Source populations and currencies remain separate; a like-for-like platform improvement cannot be established.',
      'Collection completeness is unverified. Customer classifications do not establish retention or lifetime first purchases across platforms. Email attribution does not establish causal uplift.',
      'Unresolved shipping destinations are excluded from named-country rankings.'];
  }
  if(e.kind==='shopify_operational_sales_baseline')return ['Available sales figures are shown by channel and period.',table(['Period','Channel','Metric','Value'],(e.metric_rows||[]).filter(r=>['net_sales','orders','net_items_sold','average_order_value'].includes(r.metric)).map(r=>[period(r.period),r.channel,({net_sales:'Net sales',orders:'Orders',net_items_sold:'Units sold',average_order_value:'Average order value'})[r.metric],r.unit==='money'?money(r.value,r.currency):number(r.value)])),...(e.sections?.some(failed)?['Some periods could not be retrieved; their figures are unavailable.']:[]),'Unverified coverage limits completeness. These are operational sales figures.'];
  if(e.kind==='governed_klaviyo_email')return ['Email-attributed revenue is shown below. It measures credited purchases, not additional sales caused by email.', table(['Period','Message','Kind','Attributed revenue','Attributed conversions','Unique clicks'],(e.rows||[]).map(r=>[period(r.requested_period || {start_date:r.actual_start_date,end_date:r.actual_end_date}),r.entity_name || 'Unnamed message',r.report_kind,money(r.attributed_conversion_value,r.currency),number(r.attributed_conversion_events),number(r.unique_clicks)])),e.rows?.length?null:'No attribution records were found; missing coverage does not establish zero activity.',!e.coverage?.complete?'Coverage is incomplete or unverified.':null,'Reports use calendar-month windows; exact day slicing is unavailable. Recent attribution may be provisional.',e.sections?.length?'Historical compatibility of attribution definitions and windows is unverified; a like-for-like improvement is not established.':null,e.shopify_email_referrer?'Email-referrer sessions describe a separate population and cannot verify campaign purchases.':null];
  if(['product_report_export','product_priority_export'].includes(e.kind)) {
    const columns=(e.report_columns || []).filter(c=>!['url','ranking_status'].includes(c.key)).slice(0,5);
    const rows=e.rows || [];
    const preview=e.kind==='product_priority_export'
      ? table(['Product','Priority'],rows.map(r=>[r.title || 'Unnamed product',number(r.priority)]))
      : table(columns.map(c=>c.header),rows.map(r=>columns.map(c=>c.key==='title'?r.title:c.key.includes(':')?money(r.metrics?.[c.key],c.key.split(':')[1]):number(r.metrics?.[c.key]))));
    return [`Your product report contains ${number(e.manifest?.row_count ?? rows.length)} products.`,
      e.ranking_status!=='available'?`Ranking is ${text(e.ranking_status || 'unverified')}; missing evidence may change the order.`:null,
      e.catalogue?.complete===false?'The product catalogue is incomplete; the report includes retrieved products only.':null,
      'The download retains the full report and supporting definitions.',preview,
      e.kind==='product_priority_export'?'Priorities identify review tasks; photography quality and purchase journeys have not been assessed.':null,
      e.kind==='product_report_export'&&e.report_config?.metrics?.some(m=>['product_sales','units_sold','product_orders'].includes(m))?'Commerce metrics use stored line/order evidence; payment and cancellation eligibility are not filtered. Product sales, when requested, are before refund allocation.':null,
      e.kind==='product_report_export'&&e.report_config?.metrics?.some(m=>/landing_|organic_/.test(m))?'Traffic and search describe website evidence and do not establish product conversion.':null];
  }
  return null;
}

// Only analytical metadata is rendered. Full provider evidence stays in the response;
// credentials, query payloads and person-level rows never become a display dump.
function supportingMetadata(e) {
  const keys=['periods','requested_periods','applied_dates','cutoff_date','time_zone','channel','currencies','resolved_product_ref','selected_candidate','history','coverage','retrieval','placement','definitions','classification_boundary','ranking_status','ranking_method','provider_provenance','evidence_availability','comparison_compatible','comparison_period'];
  const metadata=Object.fromEntries(keys.filter(key=>e[key]!=null).map(key=>[key,e[key]]));
  if(e.kind==='governed_product_sales') {
    metadata.metric_definitions={sales:'Persisted source-native line-item sales; operational evidence, not canonical finance.',units:'Sum of source-native line quantity in this product/source/channel/currency/month population.',orders_containing_product:'Distinct source order IDs containing the product in the same product/source/store/channel/currency/month population; not a unit count.'};
    metadata.product_sources=(e.source_rows || []).map(r=>Object.fromEntries(['source_platform','source_store','source_product_id','source_variant_ids','mapping_method','mapping_status','coverage','source_collected_at','provenance'].filter(k=>r[k]!=null).map(k=>[k,r[k]])));
  }
  if(e.sections)metadata.sections=e.sections.map(s=>({period:s.period || s.applied_period,status:s.status,definition:s.definition,coverage:s.coverage || s.result?.coverage,source_collected_at:s.result?.source_collected_at,storage:s.storage,provenance:s.provenance}));
  const json=JSON.stringify(metadata,(key,value)=>/password|secret|token|authorization|cookie|sql|query|customer_id|email_address/i.test(key)?undefined:value,2);
  return json==='{}'?'':`### Supporting metadata\n\n\`\`\`json\n${json.replaceAll('`','\\u0060')}\n\`\`\``;
}

/** Unknown contracts retain their original answer. Never hide an unknown limitation. */
export function presentAnalyticalAnswer(result, context={}) {
  if(!result?.answer || !result.evidence) return result;
  context=context||{};
  const e=result.evidence, view=e.ambiguous ? [`Several products match **${text(e.entity_query)}**. Choose one to view its sales.`, ...(e.candidates || []).map((c,i)=>`${i+1}. **${text(c.catalogue_titles?.[0] || 'Unnamed product')}** — ${text(c.sources?.map(s=>[s.source_platform,s.source_store].filter(Boolean).join(' / ')).join('; ') || 'Source unavailable')}`)] : businessView(e);
  if(!view)return result;
  const original=result.presentation?.supporting_markdown ?? result.answer;
  // Flatten our existing accordions so the strict renderer never needs arbitrary HTML.
  const supporting=String(original).replace(/^<details>\s*$/gm,'').replace(/^<\/details>\s*$/gm,'').replace(/^<summary>([^<>]+)<\/summary>\s*$/gm,'### $1');
  const periods=Array.isArray(e.periods)?e.periods:e.periods?.current?[e.periods.current,e.periods.previous_period].filter(Boolean):e.requested_periods || e.sections?.map(s=>s.period).filter(Boolean) || [];
  const scope=context.start_date ? `${period(context)}${context.comparison_start_date?`; compared with ${period({start_date:context.comparison_start_date,end_date:context.comparison_end_date})}`:''}` : [...new Set(periods.map(period))].join('; ');
  const lines=view.filter(Boolean);
  if(scope) lines.push(`Dates: ${scope}.`);
  if(e.kind==='governed_device_conversion'?e.sections?.some(s=>s.period?.start_date<=e.cutoff_date&&s.period?.end_date>=e.cutoff_date):(context.current_day_included || e.partial_current_month))lines.push('Today’s data may still be incomplete.');
  const currencies=new Set([...(e.rows||[]).map(r=>r.currency),...(e.metric_rows||[]).map(r=>r.currency),...(e.sections||[]).flatMap(s=>rowsOf(s.result||s.value||s).map(r=>r.currency))].filter(Boolean));
  if(currencies.size>1)lines.push('Currencies are shown separately and have not been converted or combined.');
  const exact=context.date_cutoff?`Requested/applied dates: ${context.start_date} to ${context.end_date}${context.comparison_start_date?` versus ${context.comparison_start_date} to ${context.comparison_end_date}`:''}, inclusive (Europe/London). Current day ${context.current_day_included?'included':'excluded'}. Runtime cutoff: ${context.date_cutoff}.`:'';
  const details=[exact,supporting,supportingMetadata(e)].filter(Boolean).join('\n\n');
  return {...result,answer:lines.join('\n\n')+`\n\n<details>\n<summary>Show details</summary>\n\n${details}\n\n</details>`,presentation:{version:1,supporting_markdown:original,summary_markdown:lines.join('\n\n')}};
}

export const ANALYTICAL_PRESENTATION_INSTRUCTIONS = `Analytical answer presentation (all subjects):
Lead with a short plain-English business answer, relevant figures and a compact table only where useful, then brief applied dates/scope and material limitations. Use readable labels and at most two decimal places; keep missing figures unavailable and currencies separate. Avoid provider IDs, route names, query terminology and repeated row-level disclaimers in the primary answer.
Put deeper supporting evidence in a collapsed block using exactly these separate lines: <details>, <summary>Show details</summary>, supporting Markdown, </details>. Never use arbitrary HTML. Preserve requested/applied dates and cutoff, metric definitions and denominators, platform/store/currency, eligibility/channel predicates, product resolution/mapping, coverage and stored timestamps, attribution windows and sanitized diagnostics.
A verified complete eligible population with explicitly observed zero sales supports “No sales were recorded.” A successful empty retrieval supports “No sales records were found” with a brief unverified-coverage caveat. A retrieval failure supports “Sales could not be retrieved.” Never infer zero from an empty or failed retrieval. Show available figures for partial evidence.
Keep material limitations visible: partial/failed periods, provisional rankings, incompatible definitions, separate currencies, unverified coverage, unresolved shipping destinations, source-specific customer classifications and attribution versus causal impact. Do not infer retention, overlap, lifetime first purchases or causal uplift. Do not duplicate raw chart-data tables in the primary answer.
`;

export function presentNativeConversionAnswer({answer,route,result}) {
  const args=route.args || {}, periods=result.periods || {};
  const window=key=>({start_date:periods[`${key}_start`] || args.start_date,end_date:periods[`${key}_end`] || args.end_date});
  const sections=[...new Set((result.rows || []).map(r=>r.period || 'current'))].map(key=>({
    period:key==='before'||key==='after'?window(key):{start_date:args.start_date,end_date:args.end_date},status:'fulfilled',
    definition:key==='before'||route.tool==='get_woocommerce_device_conversion'?'GA4 ecommerce purchases / sessions':'Shopify completed-checkout sessions / sessions',
    rows:(result.rows || []).filter(r=>(r.period || 'current')===key),coverage:result.woo_coverage || result.period
  }));
  return presentAnalyticalAnswer({answer,evidence:{kind:'native_conversion_breakdown',sections,source_evidence:result}});
}
