import { naturalReportPeriod } from './report-natural-period.js';
// Capability boundary for the existing published-product export. Provider bindings
// describe persisted governed evidence, not promises of arbitrary query support.
const metric=(name,aliases,definition,provider,field,{money=false,supported=true}={})=>Object.freeze({name,aliases:Object.freeze(aliases),definition,grain:money?'Shopify parent product + presentment currency':'Shopify parent product',compatible_dimensions:Object.freeze(['period','current_online_published_product','online']),provider_binding:supported?Object.freeze({provider,field,table:({sales:'shopify_data.order_line_items + shopify_data.order_locations',traffic:'ga4.landing_pages',organic:'search_console.pages + search_console.canonical_daily'}[provider]),source_grain:({sales:'deduplicated order line; product counts before currency joins',traffic:'landing_path + date',organic:'page + date + selected source property'}[provider])}):null,money,supported});
export const PRODUCT_REPORT_CAPABILITIES=Object.freeze({
  units_sold:metric('units_sold',['units sold','units','items sold'], 'Sum of original Shopify line quantity in existing online-order evidence; not net units after returns. Payment/cancellation eligibility is not filtered by this binding.','sales','units_sold'),
  product_orders:metric('product_orders',['distinct orders','orders containing the product','orders'], 'Distinct Shopify order IDs containing this parent product in existing online-order evidence, counted once across its lines and variants; not units. Payment/cancellation eligibility is not filtered by this binding.','sales','product_orders'),
  product_sales:metric('product_sales',['product sales amounts','sales amounts','sales value','product sales','sales','revenue'], 'Discounted Shopify product line total in presentment currency, before any refund allocation; excludes order shipping/taxes and is not total value of orders containing the product. Payment/cancellation eligibility is not filtered by this binding.','sales','sales',{money:true}),
  landing_sessions:metric('landing_sessions',['landing-page sessions','landing page sessions','landing sessions','landing traffic','landings','landing-page traffic'], 'GA4 sessions beginning on the validated product landing URL; website property scope, not product page views or commerce-channel attribution.','traffic','sessions'),
  organic_clicks:metric('organic_clicks',['organic clicks','search clicks','clicks'], 'Search Console clicks on the validated product URL, using the selected governed property per day.','organic','clicks'),
  organic_impressions:metric('organic_impressions',['organic impressions','search impressions','impressions'], 'Search Console impressions of the validated product URL, using the selected governed property per day.','organic','impressions'),
  net_sales:metric('net_sales',['net sales','net revenue'], 'Product net sales after allocated refunds are unavailable from these persisted provider bindings.',null,null,{money:true,supported:false}),
  gross_sales:metric('gross_sales',['gross sales'], 'Gross product sales are not bound by this report.',null,null,{money:true,supported:false}),
  net_units:metric('net_units',['net units sold','net units'], 'Net units after allocated returns are not bound by this report.',null,null,{supported:false}),
  conversion_rate:metric('conversion_rate',['product conversion rate','conversion rate','bounce rate'], 'Product-level conversion/bounce rate has no compatible denominator binding in this report.',null,null,{supported:false}),
  refunds:metric('refunds',['product refunds','refunds'], 'Refund money is not allocated to products in this report.',null,null,{money:true,supported:false}),
  page_views:metric('page_views',['page views','pageviews'], 'Product page views are not landing sessions and are not bound by this report.',null,null,{supported:false}),
  profit:metric('profit',['profit','margin'], 'Product profit/margin has no governed binding in this report.',null,null,{money:true,supported:false}),
  order_value:metric('order_value',['total value of orders','order value'], 'Total value of orders containing the product is not product line sales and is not bound by this report.',null,null,{money:true,supported:false})
});
const names=Object.keys(PRODUCT_REPORT_CAPABILITIES);
const fail=()=>{throw Object.assign(new Error('Invalid product report configuration'),{code:'INVALID_PRODUCT_REPORT_CONFIG'});};
const validDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
export function validateProductReportConfig(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return fail();
  const keys=['version','population','period','channel','metrics','currency','sort','output_format','priority_preset','unresolved','unsupported_requirements'];
  if(Object.keys(value).some(key=>!keys.includes(key))||value.version!==1)return fail();
  const p=value.population,d=value.period,s=value.sort;
  if(!p||p.kind!=='current_online_published'||Object.keys(p).some(k=>!['kind','product_ids','limit'].includes(k))||p.limit!==null&&(!Number.isInteger(p.limit)||p.limit<1||p.limit>10000))return fail();
  if(p.product_ids!==null&&(!Array.isArray(p.product_ids)||!p.product_ids.length||p.product_ids.some(id=>! /^[1-9]\d*$/.test(id))))return fail();
  if(!d||Object.keys(d).some(k=>!['start_date','end_date','timezone'].includes(k))||!validDate(d.start_date)||!validDate(d.end_date)||d.start_date>d.end_date||d.timezone!=='Europe/London')return fail();
  if(value.channel!=='online'||value.output_format!=='xlsx'||![null,'photography_content'].includes(value.priority_preset))return fail();
  if(!Array.isArray(value.metrics)||!value.metrics.length||value.metrics.some(m=>!names.includes(m))||new Set(value.metrics).size!==value.metrics.length)return fail();
  if(value.currency!==null&&!/^[A-Z]{3}$/.test(value.currency))return fail();
  if(!s||Object.keys(s).some(k=>!['metric','direction'].includes(k))||![null,'priority',...names].includes(s.metric)||!['asc','desc'].includes(s.direction)||s.metric==='priority'&&!value.priority_preset)return fail();
  if(!Array.isArray(value.unresolved)||value.unresolved.some(x=>!['sort_metric','currency','metrics'].includes(x))||!Array.isArray(value.unsupported_requirements)||value.unsupported_requirements.some(x=>typeof x!=='string'||x.length>160))return fail();
  if(s.metric&&PRODUCT_REPORT_CAPABILITIES[s.metric]?.money&&!value.currency&&!value.unresolved.includes('currency'))return fail();
  if(s.metric&&s.metric!=='priority'&&!value.metrics.includes(s.metric))return fail();
  return {version:1,population:{kind:p.kind,product_ids:p.product_ids?[...new Set(p.product_ids)].sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0):null,limit:p.limit},period:{start_date:d.start_date,end_date:d.end_date,timezone:d.timezone},channel:value.channel,metrics:[...value.metrics],currency:value.currency,sort:{metric:s.metric,direction:s.direction},output_format:value.output_format,priority_preset:value.priority_preset,unresolved:[...new Set(value.unresolved)].sort(),unsupported_requirements:[...new Set(value.unsupported_requirements)].sort()};
}
export const productReportConfigKey=value=>JSON.stringify(validateProductReportConfig(value));
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function mentionedMetrics(text){
  // Consume longest aliases first: “net sales” must not become ordinary sales.
  let rest=text.toLowerCase();const found=[];
  const aliases=names.flatMap(name=>PRODUCT_REPORT_CAPABILITIES[name].aliases.map(alias=>({name,alias}))).sort((a,b)=>b.alias.length-a.alias.length);
  for(const {name,alias} of aliases){const re=new RegExp(`\\b${escape(alias)}\\b`,'g');const match=re.exec(rest);if(match){found.push({name,index:match.index});rest=rest.replace(re,value=>' '.repeat(value.length));}}
  return [...new Set(found.sort((a,b)=>a.index-b.index).map(x=>x.name))];
}
export function isProductReportRequest(text,previous=null){
  text=String(text||'');
  if(!/\b(?:export|download)\b/i.test(text)&&/\b(?:customers?|before|after|next)\b|\b(?:first|second|third|nth)\s+(?:purchase|order)\b/i.test(text))return false;
  if(previous&&!/\b(?:klaviyo|campaigns?|flows?|customers?|conversion|countries|country)\b/i.test(text)&&((mentionedMetrics(text).length&&/^(?:add|include|sort|rank|only|use|units|sales value)\b/i.test(text))||(/^(?:what about|for|in|this year|last year|change (?:the )?dates)\b/i.test(text)&&naturalReportPeriod(text,Date.now()))||/^(?:top \d+|all (?:published (?:Shopify )?)?products|only product ids?|online|xlsx|GBP|USD|EUR|JPY)\b/i.test(text)))return true;
  if(!/\b(?:export|download|report)\b/i.test(text)&&/\b(?:countries|country|locations)\b/i.test(text))return false;
  return /\bproducts?\b/i.test(text)&&/\b(?:export|download|show|report|list|ranked|rank|top[ -]selling|top \d+)\b/i.test(text)&&! /\b(?:inventory|stock|collections?)\b/i.test(text)||/\b(?:photography|content)\b/i.test(text)&&/\bpriority list\b/i.test(text);
}
export const hasExplicitMetricRanking=text=>/\b(?:sort(?:ed)? by|rank(?:ed)? by|in order of)\b/i.test(text);
export function productReportClarification(config){
  if(config.unsupported_requirements.length)return `This product report supports current Online Store published Shopify products, online line sales, website landing sessions and organic search evidence in XLSX. Unsupported request: ${config.unsupported_requirements.join('; ')}. Please choose a supported scope or format.`;
  if(config.unresolved.includes('metrics'))return 'Which product metrics should I export? Supported columns are units sold, distinct orders containing the product, discounted product line sales, landing-page sessions, organic clicks and organic impressions.';
  if(config.unresolved.includes('sort_metric'))return 'For top selling, should I rank by units sold or product sales value?';
  if(config.unresolved.includes('currency'))return 'Which presentment currency should I use to sort product sales value (for example GBP or USD)? Amounts in different currencies are not comparable.';
  return null;
}
export function resolveProductReportConfig(message,{previous=null,period=null,defaultPeriod,priority=false,now=Date.now()}={}){
  const text=String(message),lower=text.toLowerCase();
  if(hasExplicitMetricRanking(text)&&mentionedMetrics(text).length)priority=false;
  const continuation=Boolean(previous)&&!priority&&!/\b(?:export|download|show|report|list)\b.*\bproducts?\b/i.test(text)&&! /^(?:new|forget|start over)\b/i.test(text);
  const config=continuation?structuredClone(validateProductReportConfig(previous)):{version:1,population:{kind:'current_online_published',product_ids:null,limit:null},period:{...defaultPeriod,timezone:'Europe/London'},channel:'online',metrics:[],currency:null,sort:{metric:null,direction:'desc'},output_format:'xlsx',priority_preset:priority?'photography_content':null,unresolved:[],unsupported_requirements:[]};
  const rolling=text.match(/\blast\s+(\d{1,4})\s+(?:completed\s+)?days?\b/i);
  period??=naturalReportPeriod(text,now);
  if(rolling){const end=new Date(`${defaultPeriod.end_date}T00:00:00Z`),start=new Date(+end-(Number(rolling[1])-1)*86400000);period={start_date:start.toISOString().slice(0,10),end_date:defaultPeriod.end_date};}
  if(period)config.period={start_date:period.start_date,end_date:period.end_date,timezone:'Europe/London'};
  const requested=mentionedMetrics(text),sortText=text.match(/\b(?:(?:sort(?:ed)?|rank(?:ed)?)\s+(?:products?\s+)?by|in order of)\s+(.+?)(?:[.;]|$)/i)?.[1];
  const sorting=sortText?mentionedMetrics(sortText)[0]:null;
  if(requested.length){config.unresolved=config.unresolved.filter(x=>x!=='metrics');config.metrics=continuation&&/^(?:add|include|sort|rank)\b/i.test(text)?[...new Set([...config.metrics,...requested])]:requested;}
  if(continuation&&config.unresolved.includes('sort_metric')){const chosen=requested.find(m=>['units_sold','product_sales'].includes(m));if(chosen){config.sort.metric=chosen;config.unresolved=config.unresolved.filter(x=>x!=='sort_metric');}}
  if(!requested.length&&!continuation&&!priority&&!/\btop[ -]selling\b/i.test(text))config.unresolved.push('metrics');
  if(continuation&&requested.length&&/^(?:only|use)\b/i.test(text)&&!requested.includes(config.sort.metric)){config.sort.metric=requested.find(m=>!PRODUCT_REPORT_CAPABILITIES[m].money)??(config.currency?requested[0]:null);}
  if(!config.metrics.length)config.metrics=priority?['product_sales','landing_sessions','organic_clicks','organic_impressions']:['units_sold'];
  if(sorting&&/\bonly\b/i.test(text))config.metrics=[sorting];
  if(sorting&&config.priority_preset){config.priority_preset=null;if(/\bonly\b/i.test(text))config.metrics=[sorting];}
  if(priority)config.sort={metric:'priority',direction:'desc'};
  else if(sorting){config.sort.metric=sorting;config.unresolved=config.unresolved.filter(x=>x!=='sort_metric');}
  else if(/\btop[ -]selling\b/i.test(text)){
    const resolved=requested.find(x=>['units_sold','product_sales'].includes(x))||(continuation&&['units_sold','product_sales'].includes(config.sort.metric)?config.sort.metric:null);
    config.sort.metric=resolved;config.unresolved=resolved?[]:['sort_metric'];
  }else if(!config.sort.metric&&!config.unresolved.includes('sort_metric'))config.sort.metric=config.metrics.find(m=>!PRODUCT_REPORT_CAPABILITIES[m].money)??(config.currency?config.metrics[0]:null);
  if(/\b(?:ascending|asc|lowest|least)\b/i.test(text))config.sort.direction='asc';else if(/\b(?:descending|desc|highest|most)\b/i.test(text))config.sort.direction='desc';
  if(/\ball currencies\b/i.test(text))config.currency=null;
  const currency=text.match(/\b(GBP|USD|EUR|JPY|CAD|AUD)\b/i)?.[1]?.toUpperCase();if(currency){config.currency=currency;if(!config.sort.metric&&!config.unresolved.includes('sort_metric'))config.sort.metric=config.metrics[0];}
  const limit=text.match(/\btop\s+(\d+)\b/i);if(limit)config.population.limit=Number(limit[1]);if(/\ball (?:published (?:Shopify )?|Shopify (?:published )?)?products\b/i.test(text)){config.population.limit=null;config.population.product_ids=null;}
  const ids=text.match(/\bproduct ids?\s+([\d, ]+)/i);if(ids)config.population.product_ids=ids[1].split(/[, ]+/).filter(Boolean);
  if(/\bonline (?:only|instead)\b|\bxlsx (?:only|instead)\b/i.test(text))config.unsupported_requirements=[];
  if(/\b(?:in[ -]store|pos|retail|woocommerce|all channels|collection|collaboration|category|categories|country|countries|inventory|stock)\b/i.test(text))config.unsupported_requirements.push('requested population/channel/dimension has no binding');
  if(/\b(?:csv|pdf|google sheets)\b/i.test(text))config.unsupported_requirements.push('requested output format has no binding');
  if(PRODUCT_REPORT_CAPABILITIES[config.sort.metric]?.money&&!config.currency)config.unresolved=[...new Set([...config.unresolved,'currency'])];else config.unresolved=config.unresolved.filter(x=>x!=='currency');
  if(config.sort.metric&&config.sort.metric!=='priority'&&!config.metrics.includes(config.sort.metric))config.metrics.push(config.sort.metric);
  return {config:validateProductReportConfig(config),continuation};
}
