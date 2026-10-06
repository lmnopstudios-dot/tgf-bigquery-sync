import { PRODUCT_REPORT_CAPABILITIES } from './product-report-config.js';

const numeric=value=>value!==null&&value!==undefined&&value!==''&&typeof value!=='boolean'&&Number.isFinite(Number(value))?Number(value):null;
const date=value=>/^\d{4}-\d{2}(?:-\d{2})?$/.test(String(value||''));
const periodText=p=>p?.start_date&&p?.end_date?`${p.start_date} to ${p.end_date}`:'';
const safeText=value=>String(value||'').slice(0,240);
const currency=value=>/^[A-Z]{3}$/.test(value||'')?value:null;
const available=row=>!['unavailable','rejected','failed','unsupported'].includes(row.status)&&row.coverage?.complete!==false;

// A reusable fact contract for governed adapters. Never parse numerical claims
// from prose. Providers must establish composition/funnel compatibility explicitly.
export function selectChartForDataset(dataset){
  if(!dataset?.definition||!dataset?.unit||!Array.isArray(dataset.points)||!dataset.points.length)return [];
  if(['composition','funnel'].includes(dataset.shape)&&(!dataset.compatible||dataset.bounded))return [];
  if(dataset.shape==='composition'&&(!dataset.mutually_exclusive||!dataset.complete_population))return [];
  if(dataset.shape==='funnel'&&(!dataset.same_population||dataset.unit!=='sessions'))return [];
  if(dataset.shape==='funnel'&&dataset.points.some(p=>numeric(p.value)==null||!available(p)))return [];
  const facets=new Map();
  for(const point of dataset.points.slice(0,5000)){
    const value=numeric(point.value);if(value===null||!available(point))continue;
    const c=currency(point.currency);if(dataset.unit==='money'&&!c)continue;
    const definition=point.definition||dataset.definition,facet=[c||dataset.unit,definition,point.population||dataset.population||'',dataset.shape==='composition'||dataset.shape==='funnel'?point.period||dataset.period:''].join('|');
    const points=facets.get(facet)||[];points.push({...point,value,currency:c,definition});facets.set(facet,points);
  }
  const charts=[];
  for(const points of facets.values()){
    const c=points[0].currency,definition=points[0].definition;
    if(!points.length)continue;
    let kind=dataset.shape==='ranking'?'horizontal_bar':dataset.shape==='comparison'?'grouped_bar':dataset.shape==='composition'?'stacked_percentage_bar':dataset.shape==='funnel'?'stage_bar':'line';
    if(kind==='line'&&new Set(points.filter(p=>date(p.period)).map(p=>p.period)).size<2)continue;
    if(kind==='grouped_bar'&&(!dataset.compatible||new Set(points.map(p=>p.series)).size<2))continue;
    if(kind==='stacked_percentage_bar'&&(points.some(p=>p.value<0)||points.reduce((s,p)=>s+p.value,0)<=0))continue;
    if(kind==='stage_bar'&&(points.some(p=>p.value<0)||points.some((p,i)=>i>0&&p.value>points[i-1].value)))continue;
    const sorted=kind==='horizontal_bar'?[...points].sort((a,b)=>(dataset.direction==='asc'?a.value-b.value:b.value-a.value)||String(a.id||a.label).localeCompare(String(b.id||b.label))).slice(0,10):kind==='line'?[...points].sort((a,b)=>String(a.period).localeCompare(String(b.period))):points.slice(0,120);
    const spec={version:1,kind,id:`evidence-chart-${charts.length}-${safeText(dataset.id||'facts').replace(/[^a-z0-9-]/gi,'-')}`,title:safeText(dataset.title),period:safeText(dataset.period),metric:safeText(dataset.metric),unit:c||dataset.unit,definition:safeText(definition),source:safeText(dataset.source),population:safeText(dataset.population),bounded:Boolean(dataset.bounded)||kind==='horizontal_bar'&&points.length>sorted.length,missing_values:'gap',placement:null,table:{columns:['Period','Series','Label','Unit','Value'],rows:sorted.map(p=>[p.period||dataset.period,p.series||'',p.label,c||dataset.unit,p.value])},accessible_label:`${safeText(dataset.title)}; ${safeText(dataset.period)}; ${c||dataset.unit}. ${safeText(definition)}. Missing evidence is not zero.`};
    if(kind==='line')spec.period_axis=[...new Set(dataset.points.map(p=>p.period).filter(date))].sort();
    if(kind==='line')spec.series=sorted.map(p=>({period:p.period,label:p.series||p.label,currency:c||'PCT',unit:dataset.unit,value:p.value}));
    else if(kind==='grouped_bar')spec.groups=[...new Set(sorted.map(p=>p.label))].map(label=>({label,currency:c,items:sorted.filter(p=>p.label===label).map((p,i)=>({label:p.series,value:p.value,rank:i+1}))}));
    else spec.groups=[{label:c||dataset.metric,currency:c,items:sorted.map((p,i)=>({label:p.label,value:kind==='stacked_percentage_bar'?p.value/sorted.reduce((s,p)=>s+p.value,0)*100:p.value,rank:i+1}))}];
    charts.push(spec);
  }
  return charts.slice(0,8);
}
function datasets(e){
  if(!e||e.ambiguous||e.retrieval_failed)return [];
  if(e.kind==='ecommerce_monthly_baseline'){
    const management=e.evidence?.management;if(management?.status!=='fulfilled')return [];
    const report=management.result,conversion=report?.conversion?.current,p=e.periods?.current;
    const funnel=conversion?[{id:'shopify-funnel',shape:'funnel',title:'Shopify Online Store session stages',period:periodText(p),metric:'Session stages',unit:'sessions',definition:'Shopify-native sessions that reached each stage in the same Online Store period; no GA4 event counts are substituted.',source:'Shopify Online Store',compatible:true,same_population:true,points:[['Sessions','sessions'],['Added to cart','sessions_with_cart_additions'],['Reached checkout','sessions_that_reached_checkout'],['Completed checkout','sessions_that_completed_checkout']].map(([label,key])=>({label,value:conversion[key]}))}]:[];
    return funnel;
  }
  if(e.kind==='governed_tool_results')return (e.results||[]).flatMap(({name,result})=>{
    if(name==='get_shopify_online_country_products'){
      const seen=new Set();return [{id:'shipping-countries',shape:'ranking',title:'Top Shopify Online Store shipping countries',period:periodText(result.period),metric:'Operational net sales',unit:'money',definition:'Order-valued operational net sales by direct shipping country. Product rows repeat the country total and are deduplicated.',source:'Shopify',bounded:true,points:(result.rows||[]).filter(r=>{const key=`${r.currency}|${r.country_code||r.country_name}|${r.country_rank}`;if(seen.has(key))return false;seen.add(key);return true;}).map(r=>({label:r.country_name||r.country_code,currency:r.currency,value:r.country_operational_net_sales}))}];
    }
    if(name==='analyze_customer_journey'&&result.scope?.exact_order_sequence===2&&result.scope?.group_by==='cohort_year_downstream_product')return [{id:'second-orders',shape:'ranking',title:'Second-order products',period:`${result.scope.cohort_entry_start} to ${result.scope.cohort_entry_end}`,metric:'Distinct customers',unit:'customers',definition:'Distinct customers purchasing the product in their exact second order; product categories can overlap.',source:'Governed customer journey',bounded:true,points:(result.results||[]).map(r=>({label:r.product,value:r.returning_customers,population:String(r.cohort_year)}))}];
    return datasets(result);
  });
  if(e.kind==='product_report_export'){
    const c=e.report_config,metric=c.sort.metric,capability=PRODUCT_REPORT_CAPABILITIES[metric];
    if(!capability?.supported||e.ranking_status==='unavailable')return [];
    const key=capability.money?`${metric}:${c.currency}`:metric;
    return [{id:'product-ranking',shape:'ranking',title:`Products by ${metric}`,period:periodText(c.period),metric,unit:capability.money?'money':metric==='landing_sessions'?'sessions':'count',definition:capability.definition,source:capability.provider_binding.provider,population:c.population.kind,bounded:Boolean(c.population.limit),direction:c.sort.direction,points:e.rows.map(r=>({id:r.product_id,label:r.title,value:r.metrics[key],currency:capability.money?c.currency:null}))}];
  }
  if(['governed_channel_sales','governed_sales_explanation','governed_product_sales'].includes(e.kind)){
    const multiple=new Set((e.rows||[]).map(r=>r.period)).size>1;
    const comparative=!multiple&&e.periods?.[1]&&new Set((e.comparison_rows||[]).map(r=>r.period)).size===1;
    return [{id:'sales',shape:comparative?'comparison':multiple?'time_series':'ranking',compatible:true,title:e.kind==='governed_product_sales'?'Product line sales':'Sales by source and channel',metric:e.kind==='governed_product_sales'?'Product line sales':'Canonical net gross',period:(e.periods||[]).map(periodText).join(' versus '),unit:'money',definition:e.kind==='governed_product_sales'?'Source-native product line sales; source and presentment currency remain separate.':'Canonical net gross; source-only comparisons, not business-wide online performance.',source:'Governed persisted commerce evidence',points:[...(e.rows||[]).map(r=>({...r,label:r.label,series:comparative?periodText(e.periods?.[0]):r.label})),...(comparative?e.comparison_rows.map(r=>({...r,label:r.label,series:periodText(e.periods?.[1])})):[])]}];
  }
  if(['governed_device_conversion','focused_woo_historical_conversion'].includes(e.kind)){
    return [{id:'conversion',shape:e.comparison_type==='explicit_period_comparison'?'comparison':'time_series',compatible:true,title:'Mobile and desktop conversion rates',metric:'Conversion rate',period:(e.periods||[]).map(periodText).join(' versus '),unit:'percent',definition:'Native same-grain numerator / sessions, with complete coverage.',source:'Governed native conversion evidence',points:(e.sections||[]).filter(s=>s.status==='fulfilled').flatMap(s=>(s.rows||[]).map(r=>({label:r.device_type,series:e.comparison_type==='explicit_period_comparison'?periodText(s.period):r.device_type,period:s.period.start_date.slice(0,7),value:r.rate==null?null:numeric(r.rate)*100,definition:s.definition,coverage:r.coverage})))}];
  }
  if(e.kind==='shopify_operational_sales_baseline'){
    return [{id:'operational-sales',shape:new Set((e.metric_rows||[]).map(r=>r.period.start_date)).size===2?'comparison':'time_series',compatible:true,title:'Shopify operational net sales',metric:'Operational net sales',unit:'money',definition:'Shopify-reported operational net sales; channels remain separate.',source:'ShopifyQL',period:(e.requested_periods||[]).map(periodText).join(' versus '),points:(e.metric_rows||[]).filter(r=>r.metric==='net_sales').map(r=>({label:r.channel,series:new Set((e.metric_rows||[]).map(row=>row.period.start_date)).size===2?periodText(r.period):r.channel,period:r.period.start_date.slice(0,7),currency:r.currency,value:r.value,status:r.status,definition:r.definition}))}];
  }
  if(e.kind==='shopify_shipping_country_comparison'){
    const sections=e.sections?.filter(s=>s.status==='fulfilled')||[];
    return [{id:'countries',shape:sections.length>1?'comparison':'ranking',compatible:true,title:'Shipping countries by operational net sales',metric:'Operational net sales',unit:'money',definition:'Direct shipping-country operational net sales, never a whole-population share from top-N.',source:'Governed online country sales',period:sections.map(s=>periodText(s.period)).join(' versus '),bounded:true,points:sections.flatMap(s=>(s.result?.rows||s.value?.rows||[]).map(r=>({label:r.country_name||r.country_code,series:periodText(s.period),currency:r.currency,value:r.sources?.find(source=>source.source_platform==='shopify')?.operational_net_sales??r.operational_net_sales})))}];
  }
  // Explicit evidence contracts allow further governed routes to declare
  // compatible shape/units without introducing prompt-specific selectors.
  return Array.isArray(e.chart_datasets)?e.chart_datasets:[];
}
export function selectOracleCharts(evidence){return datasets(evidence).flatMap(selectChartForDataset).slice(0,8);}
export function withOracleCharts(result){
  if(!result?.evidence)return result;
  const charts=result.evidence.chart_specs||selectOracleCharts(result.evidence);
  let answer=result.answer;
  if(charts.length&&result.evidence.kind==='governed_device_conversion'&&!answer.includes('<summary>Full monthly conversion table</summary>'))answer=answer.replace(/(^\| Month \| Mobile conversion[^\n]*\n(?:\|[^\n]*\n?)+)/m,table=>`<details>\n<summary>Full monthly conversion table</summary>\n\n${table}\n</details>\n`);
  return {...result,answer,evidence:{...result.evidence,chart_specs:charts},charts,inline_chart:charts[0]||null};
}
