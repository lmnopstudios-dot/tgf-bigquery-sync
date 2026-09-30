const LABELS={
  search_shopify_products:'Current catalogue',
  get_shopify_product_performance:'Online Store product sales',
  get_shopify_inventory_by_location:'Current location inventory',
  get_shopify_inventory_efficiency:'Inventory efficiency',
  get_shopify_customer_product_behavior:'Customer and product behaviour',
  get_shopify_conversion_kpis:'Shopify Online Store conversion',
  get_shopify_sales_kpis:'Shopify Online Store sales',
  get_ecommerce_report_v2_evidence:'Governed ecommerce evidence',
  search_knowledge:'Governed business context',
  get_historical_product_opportunities:'Joined Woo + Shopify + Online stock comparison',
  get_governed_pageviews_per_session:'Average pageviews per session'
};

const IDENTITY_KEYS=['product_title','title','name','product','variant_title','product_variant_title'];
const METRIC_KEYS=['net_items_sold','units_sold','orders','gross_sales','discounts','returns','net_sales','total_sales','available','available_quantity','inventory_quantity','sell_through_rate','woo_units','shopify_units','woo_units_per_day','shopify_units_per_day','online_positive_stock','customers','customer_count','overlap_customers','affinity_rate'];
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
  const sections=[],hasValidatedEvidence=entries.some(entry=>entry.result?.success!==false&&!entry.result?.error);
  for(const entry of entries){
    if(entry.result?.success===false){
      const stage=String(entry.result.failed_stage||'evidence retrieval').replaceAll('_',' '),code=String(entry.result.code||'TOOL_FAILED').slice(0,80);
      sections.push(`### ${LABELS[entry.name]||'Governed evidence'} unavailable\n- **Failed stage:** ${stage}.\n- **Status:** ${code}; ${entry.result.retryable?'an explicit retry is allowed.':'not retryable.'}\n- No analytical rows, zero-stock findings, or zero-opportunity conclusion were accepted from this error result.`);
      continue;
    }
    if(entry.name==='get_governed_pageviews_per_session'&&entry.result?.woo_ga4&&entry.result?.shopify_native){
      const line=x=>`- **${x.label}:** total views ${value(x.total_views)}; sessions ${value(x.total_sessions)}; weighted views/session ${value(x.views_per_session)}; coverage ${x.coverage.actual_start_date||'none'} to ${x.coverage.actual_end_date||'none'} (${x.coverage.covered_days}/${x.requested.days} days, ${x.coverage.missing_days} missing); source ${x.source}.`;
      sections.push(`### ${LABELS[entry.name]}\n${line(entry.result.woo_ga4)}\n${line(entry.result.shopify_native)}\n- Calculation: total views / total sessions; daily rates were not averaged. Sources remain separately labelled and are not a like-for-like platform effect.`);
      continue;
    }
    const rows=rowsFor(entry.result).slice(0,12), lines=summaryLines(entry.result);
    if(entry.name==='get_historical_product_opportunities'){
      const windows=entry.result?.observation_windows||{};
      lines.push(`- **Windows:** Woo ${windows.woo?.start_date||'unavailable'} to ${windows.woo?.end_date||'unavailable'}; Shopify Online ${windows.shopify?.start_date||'unavailable'} to ${windows.shopify?.end_date||'unavailable'}; Online inventory as of ${windows.inventory?.as_of||'unavailable'}.`);
      for(const row of rows)lines.push(`- **#${row.rank??'?'} ${String(row.product_title||row.product_ref||'Unknown').slice(0,120)}:** Woo ${value(row.woo_units)} units (WW ${JSON.stringify(row.woo_ww||{})}; US ${JSON.stringify(row.woo_us||{})}); Shopify Online ${value(row.shopify_units)} units ${JSON.stringify(row.shopify_online||{})}; velocities ${value(row.woo_units_per_day)} → ${value(row.shopify_units_per_day)} units/day; Online stock ${value(row.online_positive_stock)} across ${JSON.stringify(row.stocked_variants||[])}; mapping ${JSON.stringify(row.mapping_provenance||[])}.`);
      lines.push(`- **Coverage:** ${JSON.stringify(entry.result.coverage||{})}. **Limitations:** ${(entry.result.limitations||[]).join(' ')}`);
      sections.push(`### ${LABELS[entry.name]}\n${lines.join('\n')}`);
      continue;
    }
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
    hasValidatedEvidence?'The validated figures retrieved before the failure are shown below.':'No validated analytical figures were available; the bounded failure outcome is shown below.',
    ...sections,
    missing.length?`### Unavailable\n${missing.join(', ')} could not be incorporated into the final analysis.`:'### Unavailable\nThe final comparison and interpretation are unavailable.',
    '### Interpretation boundary\nFigures are reproduced exactly from validated aggregate tool results. No conversion rate, device/channel denominator, cross-platform equivalence, or causal migration trend has been inferred by this fallback.',
    '### Recommendation status\nNo evidence-backed recommendation is claimed because the final synthesis did not complete.',
    '**Retry:** Please retry this analysis; the background route allows the full evidence and synthesis workflow to run again.'
  ].join('\n\n');
}

export function synthesisFailureKind(error,{deadlineAt,signal,outputBytes=0,maxOutputBytes=1_500_000}={}){
  if(signal?.aborted||Date.now()>=deadlineAt)return 'request_deadline';
  if(['AbortError','TimeoutError'].includes(error?.name))return 'synthesis_timeout_with_request_budget_remaining';
  const code=String(error?.status||error?.code||'').toLowerCase(),type=String(error?.type||'').toLowerCase();
  if(outputBytes>maxOutputBytes||code==='413'||/context_length|request_too_large|payload_too_large/.test(`${code} ${type}`))return 'tool_result_size';
  return 'provider_failure';
}
