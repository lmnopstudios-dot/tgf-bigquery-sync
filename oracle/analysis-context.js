const FIELDS = new Set([
  'analysis_type','metrics','start_date','end_date','requested_end_period','grain','comparison_type',
  'comparison_start_date','comparison_end_date','currencies','channel','channel_breakdown','location',
  'platform','geography','customer_segment','product_ref','filters','sort','limit','report_section',
  'output_preference','partial_period','unresolved_required_fields'
  ,'tool_route','request_kind'
  ,'journey_intent','entry_product_classification','subsequent_product_classification','excluded_product_titles','include_unclassified_products','first_order_semantic','cohort_entry_start','cohort_entry_end','observation_end','minimum_order_sequence','maximum_order_sequence','within_days','journey_group_by'
]);
const GRAINS = new Set(['day','week','month','quarter','year']);
const CURRENCIES = new Set(['GBP','USD','JPY','EUR']);
const METRICS = new Set(['sales','refunds','customers','products','ecommerce_performance','customer_journey','customer_order_interval']);
const MONTHS = {jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};

export const ANALYSIS_CONTEXT_FIELDS = Object.freeze([...FIELDS]);
export function emptyAnalysisContext(){return {analysis_type:null,metrics:[],start_date:null,end_date:null,requested_end_period:null,grain:null,comparison_type:null,comparison_start_date:null,comparison_end_date:null,currencies:[],channel:null,channel_breakdown:false,location:null,platform:null,geography:null,customer_segment:null,product_ref:null,filters:[],sort:null,limit:null,report_section:null,output_preference:null,partial_period:false,unresolved_required_fields:[],tool_route:null,request_kind:null,journey_intent:null,entry_product_classification:null,subsequent_product_classification:null,excluded_product_titles:[],include_unclassified_products:false,first_order_semantic:null,cohort_entry_start:null,cohort_entry_end:null,observation_end:null,minimum_order_sequence:null,maximum_order_sequence:null,within_days:null,journey_group_by:null}}

const iso = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')) ? value : null;
export function validateAnalysisContext(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('analysis context must be an object');
  for(const key of Object.keys(value)) if(!FIELDS.has(key)) throw new Error(`invalid analysis context field: ${key}`);
  const out={...emptyAnalysisContext()};
  if(value.analysis_type!=null&&!['finance','customers','products','ecommerce','customer_journey'].includes(value.analysis_type)) throw new Error('invalid analysis_type');
  out.analysis_type=value.analysis_type??null;
  out.metrics=[...new Set(value.metrics||[])].filter(x=>METRICS.has(x)).slice(0,8);
  for(const key of ['start_date','end_date','cohort_entry_start','cohort_entry_end','observation_end','comparison_start_date','comparison_end_date']) {if(value[key]!=null&&!iso(value[key])) throw new Error(`invalid ${key}`);out[key]=value[key]??null}
  if(value.grain!=null&&!GRAINS.has(value.grain)) throw new Error('invalid grain'); out.grain=value.grain??null;
  out.requested_end_period=typeof value.requested_end_period==='string'?value.requested_end_period.slice(0,20):null;
  out.comparison_type=typeof value.comparison_type==='string'?value.comparison_type.slice(0,32):null;
  out.currencies=[...new Set(value.currencies||[])].filter(x=>CURRENCIES.has(x)).slice(0,4);
  out.channel=['online','instore'].includes(value.channel)?value.channel:null; out.channel_breakdown=Boolean(value.channel_breakdown);
  for(const key of ['location','platform','geography','customer_segment','product_ref','sort','report_section','output_preference']) out[key]=typeof value[key]==='string'?value[key].slice(0,100):null;
  out.filters=Array.isArray(value.filters)?value.filters.filter(x=>typeof x==='string'&&x.length<=100&&!/@|phone|email|customer[_ -]?id/i.test(x)).slice(0,12):[];
  out.limit=Number.isInteger(value.limit)&&value.limit>0&&value.limit<=100?value.limit:null;
  out.partial_period=Boolean(value.partial_period);
  out.unresolved_required_fields=[...new Set(value.unresolved_required_fields||[])].filter(x=>FIELDS.has(x)).slice(0,8);
  if(value.tool_route!=null&&!['get_shopify_online_country_products','get_average_customer_order_interval'].includes(value.tool_route)) throw new Error('invalid tool_route');
  out.tool_route=value.tool_route??null;
  if(value.request_kind!=null&&value.request_kind!=='advisory') throw new Error('invalid request_kind');
  out.request_kind=value.request_kind??null;
  out.journey_intent=typeof value.journey_intent==='string'?value.journey_intent.slice(0,100):null;
  out.entry_product_classification=typeof value.entry_product_classification==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value.entry_product_classification)?value.entry_product_classification:null;
  out.subsequent_product_classification=typeof value.subsequent_product_classification==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value.subsequent_product_classification)?value.subsequent_product_classification:null;
  out.excluded_product_titles=Array.isArray(value.excluded_product_titles)?[...new Set(value.excluded_product_titles.filter(x=>typeof x==='string'&&x.length<=100&&!/@|phone|email/i.test(x)))].slice(0,12):[];
  out.include_unclassified_products=Boolean(value.include_unclassified_products);
  out.first_order_semantic=['first_observed_ever','first_observed_in_period'].includes(value.first_order_semantic)?value.first_order_semantic:null;
  for(const key of ['minimum_order_sequence','maximum_order_sequence'])out[key]=Number.isInteger(value[key])&&value[key]>=2?value[key]:null;
  out.within_days=Number.isInteger(value.within_days)&&value.within_days>=1&&value.within_days<=3650?value.within_days:null;
  out.journey_group_by=['downstream_product','cohort_year_downstream_product','entry_product','collaboration_name','summary'].includes(value.journey_group_by)?value.journey_group_by:null;
  return out;
}

function period(text, now){
  const lower=text.toLowerCase(), today=new Date(now), todayIso=today.toISOString().slice(0,10);
  const fromNamedToNow=lower.match(/\bfrom\s+(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\s+to\s+(?:now|today)\b/);
  if(fromNamedToNow){const start=`${fromNamedToNow[3]}-${String(MONTHS[fromNamedToNow[2]]).padStart(2,'0')}-${String(+fromNamedToNow[1]).padStart(2,'0')}`;return {start_date:start,end_date:todayIso,requested_end_period:'now',partial_period:true}}
  const numeric=lower.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\s*(?:-|–|to)\s*(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/);
  if(numeric){const isoDate=(d,m,y)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;const start=isoDate(+numeric[1],+numeric[2],numeric[3]),end=isoDate(+numeric[4],+numeric[5],numeric[6]);if(iso(start)&&iso(end)&&start<=end)return {start_date:start,end_date:end,requested_end_period:end,partial_period:false}}
  const found=[...lower.matchAll(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})/g)];
  if(found.length){const first=found[0],last=found.at(-1),sm=MONTHS[first[1]],sy=+first[2],em=MONTHS[last[1]],ey=+last[2],monthEnd=new Date(Date.UTC(ey,em,0)).toISOString().slice(0,10);return {start_date:`${sy}-${String(sm).padStart(2,'0')}-01`,end_date:monthEnd>todayIso?todayIso:monthEnd,requested_end_period:`${ey}-${String(em).padStart(2,'0')}`,partial_period:monthEnd>todayIso}}
  const yearOnly=lower.match(/(?:just |about |from |in |for )?(20\d{2})(?!\s*[-–to]+\s*(?:20)?\d)/);
  if(yearOnly){const y=+yearOnly[1], end=`${y}-12-31`;return {start_date:`${y}-01-01`,end_date:end>todayIso&&y===today.getUTCFullYear()?todayIso:end,requested_end_period:String(y),partial_period:end>todayIso}}
  if(/last year/.test(lower)){const y=today.getUTCFullYear()-1;return {start_date:`${y}-01-01`,end_date:`${y}-12-31`,requested_end_period:String(y),partial_period:false}}
  if(/\b(?:this year|year to date|ytd)\b/.test(lower)){const y=today.getUTCFullYear();return {start_date:`${y}-01-01`,end_date:todayIso,requested_end_period:String(y),partial_period:true}}
  const rollingYears=lower.match(/\blast\s+(\d{1,2})\s+years?\b/);
  if(rollingYears){const start=new Date(Date.UTC(today.getUTCFullYear()-Number(rollingYears[1]),today.getUTCMonth(),today.getUTCDate()));return {start_date:start.toISOString().slice(0,10),end_date:todayIso,requested_end_period:'now',partial_period:true}}
  return null;
}

export function transitionAnalysisContext(existing, message, {now=Date.now(),reportContext=null}={}){
  let base=validateAnalysisContext(existing||{}); const text=String(message||'').trim(), lower=text.toLowerCase();
  if(reportContext) base=initializeFromReportContext(base,reportContext);
  const set={},clear=[];
  const unrelated=/^(?:what do you know about|who |why is |new question:|forget that\b)/i.test(text)&&!/\b(sales|refunds?|customers?|products?|revenue)\b/i.test(text);
  const explicitNew=/^(?:new (?:question|analysis)|forget that|start over)\b/i.test(text);
  const continuation=!unrelated&&!explicitNew&&(base.metrics.length>0||/\b(refunds?|sales|customers?|products?|ecommerce)\b/i.test(lower));
  if(explicitNew) base=emptyAnalysisContext();
  if(!unrelated){
    const advisory=/\bany ideas (?:of|on|for) what we can do\b[\s\S]*\buse data where possible\b/i.test(text);
    if(advisory) set.request_kind='advisory';
    const countryProducts=/\b(?:top\s+(?:ten|10)\s+)?(?:locations?|countries)\b[\s\S]*\bonline sales\b[\s\S]*\b(?:top\s+(?:ten|10)\s+)?products?\b|\bonline sales\b[\s\S]*\b(?:locations?|countries)\b[\s\S]*\bproducts?\b/i.test(text);
    if(countryProducts) set.tool_route='get_shopify_online_country_products';
    const customerOrderInterval=/\b(?:average|mean|median)\b[\s\S]*\b(?:time|days?)\b[\s\S]*\bbetween\b[\s\S]*\b(?:online )?orders?\b[\s\S]*\b(?:same|each|per)\b[\s\S]*\bcustomer\b|\b(?:time|days?)\b[\s\S]*\bbetween consecutive (?:online )?orders?\b/i.test(text);
    if(customerOrderInterval){set.tool_route='get_average_customer_order_interval';set.metrics=['customer_order_interval'];set.analysis_type='customers';set.channel='online';}
    const journey=/\b(?:first (?:observed )?(?:purchase|order)|bought? (?:after|next)|buy (?:after|next)|second (?:purchase|order)|third (?:purchase|order)|nth order|repeat (?:purchase )?rate|within \d+ days?|downstream|acquisition products?|customers? buy (?:after|next))\b/.test(lower);
    if(journey||base.analysis_type==='customer_journey'&&/^(?:okay[, ]+)?(?:which|what|within|on|exclude)\b/.test(lower)){set.metrics=['customer_journey'];set.analysis_type='customer_journey';set.journey_intent='purchase_sequence';const isFollowUp=base.analysis_type==='customer_journey';if(/collaboration/.test(lower)&&!isFollowUp)set.entry_product_classification='collaboration';else if(/\brings?\b/.test(lower)&&!isFollowUp)set.entry_product_classification='ring';else if(/\bclothing\b/.test(lower)&&!isFollowUp)set.entry_product_classification='clothing';if(/\bjewellery\b/.test(lower)){set.subsequent_product_classification='jewellery';set.include_unclassified_products=true}const excluded=[...lower.matchAll(/\bexclude\s+([^,.?]+?)(?=\s+(?:and|but|from|what|which)\b|[,.?]|$)/g)].map(m=>m[1].trim()).filter(Boolean);if(excluded.length)set.excluded_product_titles=[...base.excluded_product_titles,...excluded.map(x=>x.replace(/\b\w/g,c=>c.toUpperCase()))];if(/which collaboration/.test(lower))set.journey_group_by='collaboration_name';else if(/acquisition products?/.test(lower))set.journey_group_by='entry_product';else if(/each year separately|by (?:cohort )?year|annual cohorts?/.test(lower))set.journey_group_by='cohort_year_downstream_product';else if(/what|top|products?|items?/.test(lower))set.journey_group_by=base.journey_group_by==='cohort_year_downstream_product'?'cohort_year_downstream_product':'downstream_product';const seq=lower.match(/\b(second|third) (?:purchase|order)\b/);if(seq){const n=seq[1]==='second'?2:3;set.minimum_order_sequence=n;set.maximum_order_sequence=n}const days=lower.match(/\bwithin (30|60|90|365) days?\b/);if(days)set.within_days=+days[1]}
    else if(/\brefunds?\b/.test(lower)) set.metrics=['refunds'],set.analysis_type='finance';
    else if(/\bsales|revenue\b/.test(lower)) set.metrics=['sales'],set.analysis_type='finance';
    else if(/\bcustomers?\b/.test(lower)) set.metrics=['customers'],set.analysis_type='customers';
    else if(/\bproducts?\b/.test(lower)) set.metrics=['products'],set.analysis_type='products';
    for(const [pattern,grain] of [[/\bdaily\b/,'day'],[/\bweekly\b/,'week'],[/\bmonthly\b/,'month'],[/\bquarterly\b/,'quarter'],[/\byearly|annually\b/,'year']]) if(pattern.test(lower)) set.grain=grain;
    if(/each year separately|by (?:cohort )?year|annual cohorts?/.test(lower))set.grain='year';
    for(const currency of CURRENCIES) if(new RegExp(`\\b${currency}\\b`,'i').test(text)) set.currencies=[currency];
    if(/all currencies/i.test(text)) clear.push('currencies');
    if(/all channels/i.test(text)){clear.push('channel');set.channel_breakdown=false}
    else if(/split .*online.*(?:in ?store|pos)|split .*in ?store.*online/i.test(lower)) {clear.push('channel');set.channel_breakdown=true}
    else if(/online only/i.test(lower)) set.channel='online',set.channel_breakdown=false;
    else if(/(?:in ?store|pos) only/i.test(lower)) set.channel='instore',set.channel_breakdown=false;
    if(/graph it|chart it/i.test(lower)) set.output_preference='chart';
    const top=lower.match(/top\s+(\d{1,3})/);if(top){set.limit=Math.min(+top[1],100);set.sort='descending'}
    if(/exclude pos/i.test(lower)) set.filters=[...base.filters.filter(x=>x!=='exclude_pos'),'exclude_pos'];
    if(/include pos|clear (?:the )?filters?/i.test(lower)) clear.push('filters');
    Object.assign(set,period(text,now)||{});
    if(!base.currencies.length&&!set.currencies&&set.analysis_type==='finance'&&(set.tool_route||base.tool_route)!=='get_shopify_online_country_products'&&!advisory) set.currencies=['GBP'];
  }
  const next={...base,...set};if(next.analysis_type==='customer_journey'){next.first_order_semantic=next.first_order_semantic||'first_observed_ever';if(next.start_date){next.cohort_entry_start=next.start_date;next.cohort_entry_end=next.end_date;next.observation_end=next.end_date;}}for(const key of clear) next[key]=emptyAnalysisContext()[key];
  const missing=[];if(next.metrics.length&&!next.start_date&&next.request_kind!=='advisory') missing.push('start_date','end_date');
  next.unresolved_required_fields=[...new Set(missing)];
  const ready=next.metrics.length>0&&Boolean(next.start_date&&next.end_date);
  const changed=Object.keys(set).filter(k=>JSON.stringify(base[k])!==JSON.stringify(next[k]));
  const retained=ANALYSIS_CONTEXT_FIELDS.filter(k=>!changed.includes(k)&&!clear.includes(k)&&JSON.stringify(next[k])!==JSON.stringify(emptyAnalysisContext()[k]));
  return {context:validateAnalysisContext(next),transition:{continuation,set:changed,clear:[...new Set(clear)],retain:retained,missing_required_fields:next.unresolved_required_fields,ready_to_execute:ready,applies_to_message:!unrelated}};
}

export function initializeFromReportContext(existing, report={}){
  const allowed={...existing,report_section:report.report_section||null,start_date:report.current_period?.start_date,end_date:report.current_period?.end_date,comparison_start_date:report.comparison_period?.start_date,comparison_end_date:report.comparison_period?.end_date,comparison_type:report.comparison_type||null,currencies:report.selected_currencies||[],metrics:(report.relevant_metric_identifiers||[]).filter(x=>METRICS.has(x))};
  return validateAnalysisContext(allowed);
}
export function analysisScope(context){const c=validateAnalysisContext(context);if(!c.metrics.length)return null;return [c.metrics.join('/'),c.grain,c.start_date&&`${c.start_date}–${c.end_date}`,c.currencies.join('/'),c.channel_breakdown?'online vs instore':c.channel||'all channels'].filter(Boolean).join(' · ')}
export function clarificationFor(context){const c=validateAnalysisContext(context);if(c.unresolved_required_fields.includes('start_date')){if(c.tool_route==='get_shopify_online_country_products')return 'What date range would you like? I’ll keep each currency in a separate ranking unless you specify one.';if(c.analysis_type!=='finance')return 'What date range would you like?';return `What date range would you like? I’ll use ${c.currencies[0]||'GBP'} unless you specify another currency.`;}return null}
