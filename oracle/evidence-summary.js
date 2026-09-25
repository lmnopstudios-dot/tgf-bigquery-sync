const LABELS={
  search_shopify_products:'Current catalogue',
  get_shopify_product_performance:'Online Store product sales',
  get_shopify_inventory_by_location:'Current location inventory',
  get_shopify_inventory_efficiency:'Inventory efficiency',
  get_shopify_customer_product_behavior:'Customer and product behaviour',
  get_shopify_conversion_kpis:'Shopify Online Store conversion',
  get_shopify_sales_kpis:'Shopify Online Store sales',
  get_ecommerce_report_v2_evidence:'Governed ecommerce evidence',
  search_knowledge:'Governed business context'
};

const IDENTITY_KEYS=['product_title','title','name','product','variant_title','product_variant_title'];
const METRIC_KEYS=['net_items_sold','units_sold','orders','gross_sales','discounts','returns','net_sales','total_sales','available','available_quantity','inventory_quantity','sell_through_rate','customers','customer_count','overlap_customers','affinity_rate'];
const ROW_KEYS=['products','rows','items','results','variants','product_affinity'];
const SUMMARY_KEYS=['sessions','orders','conversion_rate','checkout_conversion_rate','purchases','purchase','total_sales','net_sales','gross_sales','average_order_value','total_users','engaged_sessions'];

const human=key=>key.replaceAll('_',' ').replace(/\b\w/g,value=>value.toUpperCase());
const value=value=>typeof value==='number'?new Intl.NumberFormat('en-GB',{maximumFractionDigits:2}).format(value):String(value);

function rowsFor(result){
  if(!result||typeof result!=='object')return [];
  for(const key of ROW_KEYS)if(Array.isArray(result[key]))return result[key];
  return [];
}

function summaryLines(result){
  if(!result||typeof result!=='object')return [];
  const candidates=[result,result.metrics,result.values].filter(value=>value&&typeof value==='object'&&!Array.isArray(value));
  const lines=[];
  for(const candidate of candidates){
    const metrics=SUMMARY_KEYS.filter(key=>['number','string'].includes(typeof candidate[key])&&candidate[key]!==''&&!Number.isNaN(Number(candidate[key]))).slice(0,8);
    if(metrics.length)lines.push(`- ${metrics.map(key=>`${human(key)} ${value(candidate[key])}`).join('; ')}`);
  }
  return [...new Set(lines)];
}

/** Build a bounded user-facing fallback from already validated aggregate output. */
export function evidenceSummary(entries,{unavailable=[]}={}){
  const sections=[];
  for(const entry of entries){
    const rows=rowsFor(entry.result).slice(0,12), lines=summaryLines(entry.result);
    for(const row of rows){
      if(!row||typeof row!=='object')continue;
      const identity=IDENTITY_KEYS.map(key=>row[key]).find(item=>typeof item==='string'&&item.trim());
      const metrics=METRIC_KEYS.filter(key=>['number','string'].includes(typeof row[key])&&row[key]!==''&&!Number.isNaN(Number(row[key]))).slice(0,6);
      if(identity&&metrics.length)lines.push(`- **${String(identity).slice(0,160)}:** ${metrics.map(key=>`${human(key)} ${value(row[key])}`).join('; ')}`);
    }
    if(!lines.length)continue;
    const dates=entry.result?.start_date&&entry.result?.end_date?` (${entry.result.start_date} to ${entry.result.end_date})`:'';
    sections.push(`### ${LABELS[entry.name]||'Governed evidence'}${dates}\n${lines.join('\n')}`);
  }
  const missing=[...new Set(unavailable)].map(name=>LABELS[name]||'A requested evidence source');
  return [
    '**Partial result — final synthesis did not complete**',
    sections.length?'The validated figures retrieved before the failure are shown below.':'No validated figures were available to include in the response.',
    ...sections,
    missing.length?`### Unavailable\n${missing.join(', ')} could not be incorporated into the final analysis.`:'### Unavailable\nThe final comparison and interpretation are unavailable.',
    '### Interpretation boundary\nFigures are reproduced exactly from validated aggregate tool results. No conversion rate, device/channel denominator, cross-platform equivalence, or causal migration trend has been inferred by this fallback.',
    '### Recommendation status\nNo evidence-backed recommendation is claimed because the final synthesis did not complete.',
    '**Retry:** Please retry this analysis; the background route allows the full evidence and synthesis workflow to run again.'
  ].join('\n\n');
}

export function synthesisFailureKind(error,{deadlineAt,signal,outputBytes=0,maxOutputBytes=1_500_000}={}){
  if(signal?.aborted||Date.now()>=deadlineAt||['AbortError','TimeoutError'].includes(error?.name))return 'deadline';
  const code=String(error?.status||error?.code||'').toLowerCase(),type=String(error?.type||'').toLowerCase();
  if(outputBytes>maxOutputBytes||code==='413'||/context_length|request_too_large|payload_too_large/.test(`${code} ${type}`))return 'tool_result_size';
  return 'provider_failure';
}
