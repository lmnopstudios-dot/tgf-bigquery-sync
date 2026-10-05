import { isStockClearanceAdvisory } from './advisory-intent.js';

const FIELDS = new Set([
  'analysis_type','metrics','start_date','end_date','requested_end_period','grain','comparison_type',
  'comparison_start_date','comparison_end_date','currencies','channel','channel_breakdown','location',
  'platform','geography','customer_segment','product_ref','filters','sort','limit','report_section',
  'output_preference','partial_period','unresolved_required_fields'
  ,'tool_route','request_kind','advisory_topic'
  ,'journey_intent','entry_product_classification','subsequent_product_classification','excluded_product_titles','include_unclassified_products','first_order_semantic','cohort_entry_start','cohort_entry_end','observation_end','minimum_order_sequence','maximum_order_sequence','within_days','journey_group_by'
  ,'event_name','event_count'
  ,'requested_subject','included_periods','exclusions','contextual_event_mentions'
  ,'entity_query','explanation_requested','pending_product_candidates'
]);
const GRAINS = new Set(['day','week','month','quarter','year']);
const CURRENCIES = new Set(['GBP','USD','JPY','EUR']);
const METRICS = new Set(['sales','refunds','customers','products','search_console','shipping_countries','ecommerce_performance','customer_journey','customer_order_interval','product_views_before_purchase','conversion']);
export const ANALYSIS_TOOL_ROUTES = Object.freeze(['get_shopify_online_country_products','get_online_country_sales','get_shopify_customer_kpis','get_search_console_evidence','get_average_customer_order_interval','get_governed_category_sales','get_product_views_before_purchase','compare_historical_events','get_shopify_operational_sales_baseline','get_woocommerce_device_conversion','get_governed_device_conversion','get_general_sales_analysis','get_product_sales_analysis']);
const TOOL_ROUTES = new Set(ANALYSIS_TOOL_ROUTES);
const MONTHS = {jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};

export const ANALYSIS_CONTEXT_FIELDS = Object.freeze([...FIELDS]);
export function emptyAnalysisContext(){return {analysis_type:null,metrics:[],start_date:null,end_date:null,requested_end_period:null,grain:null,comparison_type:null,comparison_start_date:null,comparison_end_date:null,currencies:[],channel:null,channel_breakdown:false,location:null,platform:null,geography:null,customer_segment:null,product_ref:null,filters:[],sort:null,limit:null,report_section:null,output_preference:null,partial_period:false,unresolved_required_fields:[],tool_route:null,request_kind:null,advisory_topic:null,journey_intent:null,entry_product_classification:null,subsequent_product_classification:null,excluded_product_titles:[],include_unclassified_products:false,first_order_semantic:null,cohort_entry_start:null,cohort_entry_end:null,observation_end:null,minimum_order_sequence:null,maximum_order_sequence:null,within_days:null,journey_group_by:null,event_name:null,event_count:null,requested_subject:null,included_periods:[],exclusions:[],contextual_event_mentions:[],entity_query:null,explanation_requested:false,pending_product_candidates:[]}}

function contextValidationError(field,rule,message=`invalid ${field}`){const error=Object.assign(new Error(message),{code:'INVALID_ANALYSIS_CONTEXT',validation_field:field,validation_rule:rule});return error}

const iso = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')) ? value : null;
export function validateAnalysisContext(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('analysis context must be an object');
  for(const key of Object.keys(value)) if(!FIELDS.has(key)) throw contextValidationError('unknown_field','recognized_field',`invalid analysis context field: ${key}`);
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
  if(value.tool_route!=null&&!TOOL_ROUTES.has(value.tool_route)) throw contextValidationError('tool_route','allowed_route');
  out.tool_route=value.tool_route??null;
  if(value.request_kind!=null&&!['advisory','knowledge_save','policy_definition'].includes(value.request_kind)) throw new Error('invalid request_kind');
  out.request_kind=value.request_kind??null;
  if(value.advisory_topic!=null&&value.advisory_topic!=='stock_clearance') throw new Error('invalid advisory_topic');
  out.advisory_topic=value.advisory_topic??null;
  out.journey_intent=typeof value.journey_intent==='string'?value.journey_intent.slice(0,100):null;
  out.entry_product_classification=typeof value.entry_product_classification==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value.entry_product_classification)?value.entry_product_classification:null;
  out.subsequent_product_classification=typeof value.subsequent_product_classification==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value.subsequent_product_classification)?value.subsequent_product_classification:null;
  out.excluded_product_titles=Array.isArray(value.excluded_product_titles)?[...new Set(value.excluded_product_titles.filter(x=>typeof x==='string'&&x.length<=100&&!/@|phone|email/i.test(x)))].slice(0,12):[];
  out.include_unclassified_products=Boolean(value.include_unclassified_products);
  out.first_order_semantic=['first_observed_ever','first_observed_in_period'].includes(value.first_order_semantic)?value.first_order_semantic:null;
  for(const key of ['minimum_order_sequence','maximum_order_sequence'])out[key]=Number.isInteger(value[key])&&value[key]>=2?value[key]:null;
  out.within_days=Number.isInteger(value.within_days)&&value.within_days>=1&&value.within_days<=3650?value.within_days:null;
  out.journey_group_by=['downstream_product','cohort_year_downstream_product','entry_product','collaboration_name','summary'].includes(value.journey_group_by)?value.journey_group_by:null;
  out.event_name=typeof value.event_name==='string'?value.event_name.slice(0,100):null;
  out.event_count=Number.isInteger(value.event_count)&&value.event_count>=1&&value.event_count<=5?value.event_count:null;
  out.requested_subject=typeof value.requested_subject==='string'?value.requested_subject.slice(0,100):null;
  out.included_periods=Array.isArray(value.included_periods)?[...new Set(value.included_periods.filter(x=>/^20\d{2}-(?:0[1-9]|1[0-2])$/.test(x)))].slice(0,36):[];
  out.exclusions=Array.isArray(value.exclusions)?[...new Set(value.exclusions.filter(x=>typeof x==='string'&&x.length<=100&&!/@|phone|email/i.test(x)).map(x=>x.toLowerCase()))].slice(0,12):[];
  out.contextual_event_mentions=Array.isArray(value.contextual_event_mentions)?[...new Set(value.contextual_event_mentions.filter(x=>typeof x==='string'&&x.length<=100))].slice(0,12):[];
  out.entity_query=typeof value.entity_query==='string'?value.entity_query.slice(0,160):null;
  out.explanation_requested=Boolean(value.explanation_requested);
  out.pending_product_candidates=Array.isArray(value.pending_product_candidates)?value.pending_product_candidates.slice(0,8).map(candidate=>({product_ref:typeof candidate?.product_ref==='string'?candidate.product_ref.slice(0,240):'',catalogue_titles:Array.isArray(candidate?.catalogue_titles)?candidate.catalogue_titles.filter(x=>typeof x==='string').map(x=>x.slice(0,160)).slice(0,8):[],sources:Array.isArray(candidate?.sources)?candidate.sources.slice(0,12).map(source=>({source_platform:typeof source?.source_platform==='string'?source.source_platform.slice(0,32):null,source_store:typeof source?.source_store==='string'?source.source_store.slice(0,32):null,source_product_ref:typeof source?.source_product_ref==='string'?source.source_product_ref.slice(0,240):null})).filter(source=>source.source_product_ref):[],reporting_family_relationships:Array.isArray(candidate?.reporting_family_relationships)?candidate.reporting_family_relationships.filter(x=>typeof x==='string').map(x=>x.slice(0,160)).slice(0,8):[]})).filter(candidate=>candidate.product_ref):[];
  return out;
}

function period(text, now){
  const lower=text.toLowerCase(), today=new Date(now), todayIso=today.toISOString().slice(0,10);
  if(/\bthis year(?:'s)?\b/.test(lower)&&/\blast year(?:'s)?\b/.test(lower)){const y=today.getUTCFullYear(),priorEnd=new Date(Date.UTC(y-1,today.getUTCMonth(),today.getUTCDate())).toISOString().slice(0,10);return{start_date:`${y}-01-01`,end_date:todayIso,requested_end_period:String(y),partial_period:true,comparison_type:'matching_elapsed_year_on_year',comparison_start_date:`${y-1}-01-01`,comparison_end_date:priorEnd};}
  const fromNamedToNow=lower.match(/\bfrom\s+(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\s+to\s+(?:now|today)\b/);
  if(fromNamedToNow){const start=`${fromNamedToNow[3]}-${String(MONTHS[fromNamedToNow[2]]).padStart(2,'0')}-${String(+fromNamedToNow[1]).padStart(2,'0')}`;return {start_date:start,end_date:todayIso,requested_end_period:'now',partial_period:true}}
  const numeric=lower.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\s*(?:-|–|to)\s*(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/);
  if(numeric){const isoDate=(d,m,y)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;const start=isoDate(+numeric[1],+numeric[2],numeric[3]),end=isoDate(+numeric[4],+numeric[5],numeric[6]);if(iso(start)&&iso(end)&&start<=end)return {start_date:start,end_date:end,requested_end_period:end,partial_period:false}}
  const names=Object.keys(MONTHS).join('|'),ranges=[...lower.matchAll(new RegExp(`\\b(${names})(?:\\s+(20\\d{2}))?\\s*(?:-|–|—|through|to)\\s*(${names})\\s+(20\\d{2})\\b`,'g'))];
  if(ranges.length){const dates=ranges.map(match=>{const sy=Number(match[2]||match[4]),sm=MONTHS[match[1]],ey=Number(match[4]),em=MONTHS[match[3]],monthEnd=new Date(Date.UTC(ey,em,0)).toISOString().slice(0,10);return{start_date:`${sy}-${String(sm).padStart(2,'0')}-01`,end_date:monthEnd>todayIso?todayIso:monthEnd,requested_end_period:`${ey}-${String(em).padStart(2,'0')}`,partial_period:monthEnd>todayIso}}).filter(x=>x.start_date<=x.end_date);if(dates.length)return{...dates[0],...(dates[1]?{comparison_start_date:dates[1].start_date,comparison_end_date:dates[1].end_date}: {})}}
  const found=[...lower.matchAll(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})/g)];
  if(found.length===2&&MONTHS[found[0][1]]===MONTHS[found[1][1]]&&/\b(?:versus|vs\.?|compared? (?:with|to))\b/.test(lower)){const values=found.map(x=>({month:MONTHS[x[1]],year:Number(x[2])})).sort((a,b)=>b.year-a.year),range=x=>({start_date:`${x.year}-${String(x.month).padStart(2,'0')}-01`,end_date:new Date(Date.UTC(x.year,x.month,0)).toISOString().slice(0,10)}),current=range(values[0]),comparison=range(values[1]);return{...current,requested_end_period:current.start_date.slice(0,7),partial_period:false,comparison_type:'explicit_period_comparison',comparison_start_date:comparison.start_date,comparison_end_date:comparison.end_date};}
  if(found.length){const first=found[0],last=found.at(-1),sm=MONTHS[first[1]],sy=+first[2],em=MONTHS[last[1]],ey=+last[2],monthEnd=new Date(Date.UTC(ey,em,0)).toISOString().slice(0,10);return {start_date:`${sy}-${String(sm).padStart(2,'0')}-01`,end_date:monthEnd>todayIso?todayIso:monthEnd,requested_end_period:`${ey}-${String(em).padStart(2,'0')}`,partial_period:monthEnd>todayIso}}
  const yearOnly=lower.match(/(?:just |about |from |in |for )?(20\d{2})(?!\s*[-–to]+\s*(?:20)?\d)/);
  if(yearOnly){const y=+yearOnly[1], end=`${y}-12-31`;return {start_date:`${y}-01-01`,end_date:end>todayIso&&y===today.getUTCFullYear()?todayIso:end,requested_end_period:String(y),partial_period:end>todayIso}}
  if(/last year/.test(lower)){const y=today.getUTCFullYear()-1;return {start_date:`${y}-01-01`,end_date:`${y}-12-31`,requested_end_period:String(y),partial_period:false}}
  if(/\b(?:this year|year to date|ytd)\b/.test(lower)){const y=today.getUTCFullYear();return {start_date:`${y}-01-01`,end_date:todayIso,requested_end_period:String(y),partial_period:true}}
  const monthStart=(year,month)=>`${year}-${String(month+1).padStart(2,'0')}-01`,monthEnd=(year,month)=>new Date(Date.UTC(year,month+1,0)).toISOString().slice(0,10);
  if(/\bthis month\b/.test(lower))return{start_date:monthStart(today.getUTCFullYear(),today.getUTCMonth()),end_date:todayIso,requested_end_period:todayIso.slice(0,7),partial_period:true};
  if(/\blast month\b/.test(lower)){const d=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-1,1));return{start_date:monthStart(d.getUTCFullYear(),d.getUTCMonth()),end_date:monthEnd(d.getUTCFullYear(),d.getUTCMonth()),requested_end_period:monthStart(d.getUTCFullYear(),d.getUTCMonth()).slice(0,7),partial_period:false};}
  if(/\blast three completed months\b/.test(lower)){const end=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-1,1)),start=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-3,1));return{start_date:monthStart(start.getUTCFullYear(),start.getUTCMonth()),end_date:monthEnd(end.getUTCFullYear(),end.getUTCMonth()),requested_end_period:monthStart(end.getUTCFullYear(),end.getUTCMonth()).slice(0,7),partial_period:false};}
  const rollingYears=lower.match(/\blast\s+(\d{1,2})\s+years?\b/);
  if(rollingYears){const start=new Date(Date.UTC(today.getUTCFullYear()-Number(rollingYears[1]),today.getUTCMonth(),today.getUTCDate()));return {start_date:start.toISOString().slice(0,10),end_date:todayIso,requested_end_period:'now',partial_period:true}}
  const rollingMonths=lower.match(/\blast\s+(\d{1,2})\s+months?\b/);
  if(rollingMonths){const count=Math.min(Number(rollingMonths[1]),36),start=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-count+1,1));return {start_date:start.toISOString().slice(0,10),end_date:todayIso,requested_end_period:'now',partial_period:true}}
  return null;
}

export function transitionAnalysisContext(existing, message, {now=Date.now(),reportContext=null}={}){
  let base=validateAnalysisContext(existing||{}); const text=String(message||'').trim(), lower=text.toLowerCase();
  if(reportContext) base=initializeFromReportContext(base,reportContext);
  const set={},clear=[];
  // Definitions and policy hypotheticals can contain words such as "product" or
  // "stock", but they are not historical product analyses. Classify them before
  // the broad metric keyword rules so they never acquire a date or currency.
  const explicitSalesBaseline=/\b(?:sales\s+(?:starting\s+)?baseline|ecommerce\s+starting\s+baseline)\b|\bestablish\b[\s\S]{0,80}\b(?:sales|ecommerce)\b[\s\S]{0,40}\bbaseline\b|\bshopify\b[\s\S]{0,50}\boperational sales\b|\boperational sales\b[\s\S]{0,50}\bshopify\b/i.test(text);
  const broadBaseline=/\b(?:comprehensive\s+)?ecommerce baseline\b/i.test(text);
  // “Online Store” is a commerce channel, not an imperative to store knowledge.
  const knowledgeIntentText=text.replace(/\bonline store\b/gi,'online channel');
  const knowledgeSave=!explicitSalesBaseline&&(/\b(?:save|record|remember|store|add)\b[\s\S]*\b(?:definition|policy|rule|knowledge)\b|\b(?:propose|create|write)\b[\s\S]*\b(?:timeless|operational|governed)\s+definition\b/i.test(knowledgeIntentText));
  const policyDefinition=/\b(?:made[ -]to[ -]order|ready to ship)\b/i.test(text)&&/\b(?:if|when|without|tag(?:ged)?|definition|policy|rule|available|availability|stock|units?|size)\b/i.test(text);
  const nonTemporalKind=knowledgeSave?'knowledge_save':policyDefinition?'policy_definition':null;
  if(nonTemporalKind){base=emptyAnalysisContext();set.request_kind=nonTemporalKind;}
  const unrelated=/^(?:what do you know about|who |why is |new question:|forget that\b)/i.test(text)&&!/\b(sales|refunds?|customers?|products?|revenue)\b/i.test(text);
  const explicitNew=/^(?:new (?:question|analysis)|forget that|start over)\b/i.test(text);
  const continuation=!unrelated&&!explicitNew&&(base.metrics.length>0||/\b(refunds?|sales|customers?|products?|ecommerce)\b/i.test(lower));
  if(explicitNew) base=emptyAnalysisContext();
  if(broadBaseline){const context=emptyAnalysisContext();return{context,transition:{continuation:false,set:[],clear:ANALYSIS_CONTEXT_FIELDS.filter(key=>JSON.stringify(base[key])!==JSON.stringify(context[key])),retain:[],missing_required_fields:[],ready_to_execute:true,applies_to_message:true}};}
  if(!unrelated&&!nonTemporalKind){
    const productChoiceFollowup=base.tool_route==='get_product_sales_analysis'&&(/\b(?:choice|option|candidate|product identit(?:y|ies)|stable (?:product )?reference|first|second|third)\b/i.test(text)||/^\s*(?:#?\d+|(?:canonical|family|source|woo|shopify|square):\S+)\s*[.!]?$/i.test(text));
    if(productChoiceFollowup&&base.pending_product_candidates.length){const ordinal={first:1,second:2,third:3,fourth:4,fifth:5,sixth:6,seventh:7,eighth:8},number=text.match(/^(?:(?:use|choose|pick|select)\s+)?(?:(?:the\s+)?(?:choice|option|candidate|one|number)\s*)?#?(\d+)\s*(?:one)?\s*[.!]?$/i),word=text.match(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth)\b/i),index=number?Number(number[1]):word?ordinal[word[1].toLowerCase()]:null,exact=base.pending_product_candidates.find(candidate=>candidate.product_ref===text.trim()||candidate.sources.some(source=>source.source_product_ref===text.trim())),selected=exact||(index?base.pending_product_candidates[index-1]:null);if(selected)set.product_ref=selected.product_ref;}
    const excludedBlackFriday=/(?:\bexclude\b|\bexcluding\b|\bnot\b|\boutside\b|\bexcept\b)[\s\S]{0,30}\bblack\s+friday\b/i.test(text);
    const excludedMonthNumbers=new Set([...lower.matchAll(/(?:exclude|excluding|except|not|outside)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g)].map(x=>MONTHS[x[1]]));
    const namedMonths=[...lower.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g)].map(x=>MONTHS[x[1]]).filter(x=>!excludedMonthNumbers.has(x));
    const namedYears=[...lower.matchAll(/\b(20\d{2})\b/g)].map(x=>Number(x[1]));
    const focusedWooConversion=/\b(?:woocommerce|woo)\b[\s\S]{0,120}\b(?:traffic|sessions?|conversion)\b|\b(?:traffic|sessions?|conversion)\b[\s\S]{0,120}\b(?:woocommerce|woo)\b/i.test(text);
    const explicitDeviceConversion=!/\b(?:before|after)\b[\s\S]{0,80}\b(?:launch|launched|migration)\b/i.test(text)&&/\b(?:mobile|desktop|device)\b[\s\S]{0,80}\bconv(?:ersion|erison)(?:\s+rates?)?\b|\bconv(?:ersion|erison)(?:\s+rates?)?\b[\s\S]{0,80}\b(?:mobile|desktop|device)\b/i.test(text);
    const retainedDeviceConversion=base.tool_route==='get_governed_device_conversion'&&/\b(?:conversion(?:\s+rates?)?|better|worse|last year|year[- ]on[- ]year)\b/i.test(text);
    const productMatch=text.match(/\b(?:sales|revenue)\s+(?:breakdown\s+)?(?:of|for)\s+(.+?)(?=\s+(?:this|last)\s+(?:year|month)\b|\s+(?:in|for|during)\s+20\d{2}\b|[?.!]|$)/i);
    const namedProduct=productMatch?.[1]?.trim().replace(/^(?:the\s+)?product\s+/i,'');
    const channelComparison=!explicitSalesBaseline&&base.tool_route!=='get_governed_category_sales'&&(/\bonline\b[\s\S]{0,50}\b(?:in[ -]?store|retail|pos)\b|\b(?:in[ -]?store|retail|pos)\b[\s\S]{0,50}\bonline\b/i.test(text))&&/\b(?:sales|revenue)\b/i.test(text);
    if(namedProduct){for(const key of ['platform','geography','customer_segment','comparison_type','comparison_start_date','comparison_end_date','included_periods','event_name','event_count','filters','output_preference','product_ref','pending_product_candidates'])clear.push(key);set.requested_subject='product_sales';set.entity_query=namedProduct;set.metrics=['sales'];set.analysis_type='products';set.tool_route='get_product_sales_analysis';set.channel_breakdown=true;set.grain=/\b(?:monthly|by month)\b/i.test(text)?'month':base.grain||'month';}
    else if(channelComparison){for(const key of ['platform','geography','customer_segment','product_ref','entity_query','comparison_type','comparison_start_date','comparison_end_date','included_periods','event_name','event_count','filters','output_preference'])clear.push(key);set.requested_subject='channel_sales';set.metrics=['sales'];set.analysis_type='finance';set.tool_route='get_general_sales_analysis';set.channel_breakdown=true;set.grain=/\b(?:monthly|by month)\b/i.test(text)?'month':'month';}
    if(namedMonths.length===2&&namedYears.length===2&&namedMonths[0]===namedMonths[1]&&/\b(?:versus|vs\.?|compared? (?:with|to))\b/i.test(text)){const pairs=[...lower.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/g)].map(x=>({month:MONTHS[x[1]],year:Number(x[2])})).sort((a,b)=>b.year-a.year),toPeriod=x=>({start_date:`${x.year}-${String(x.month).padStart(2,'0')}-01`,end_date:new Date(Date.UTC(x.year,x.month,0)).toISOString().slice(0,10)}),current=toPeriod(pairs[0]),comparisonPeriod=toPeriod(pairs[1]);Object.assign(set,current,{comparison_type:'explicit_period_comparison',comparison_start_date:comparisonPeriod.start_date,comparison_end_date:comparisonPeriod.end_date,partial_period:false});}
    if(namedMonths.length>1&&namedYears.length){const months=[...new Set(namedMonths)],years=[...new Set(namedYears)],range=lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?\s*(?:-|–|—|through|to)\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/);if(range){const startYear=Number(range[2]||range[4]),endYear=Number(range[4]),startMonth=MONTHS[range[1]],endMonth=MONTHS[range[3]],expanded=[];for(let cursor=new Date(Date.UTC(startYear,startMonth-1,1)),last=Date.UTC(endYear,endMonth-1,1);cursor.getTime()<=last;cursor.setUTCMonth(cursor.getUTCMonth()+1))expanded.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth()+1).padStart(2,'0')}`);set.included_periods=expanded;}else set.included_periods=years.flatMap(year=>months.map(month=>`${year}-${String(month).padStart(2,'0')}`));set.requested_subject='calendar_period_comparison';set.comparison_type='independent_calendar_months';set.grain='month';set.start_date=`${Math.min(...years)}-${String(Math.min(...months)).padStart(2,'0')}-01`;const lastYear=Math.max(...years),lastMonth=Math.max(...months);set.end_date=new Date(Date.UTC(lastYear,lastMonth,0)).toISOString().slice(0,10);set.requested_end_period=`${lastYear}-${String(lastMonth).padStart(2,'0')}`;for(const key of ['tool_route','event_name','event_count'])clear.push(key);}
    if(focusedWooConversion&&set.included_periods){set.requested_subject='woo_traffic_conversion';set.metrics=['conversion'];set.analysis_type='ecommerce';set.platform='woo';set.channel='online';set.tool_route='get_woocommerce_device_conversion';for(const key of ['currencies','geography','customer_segment','product_ref','report_section','event_name','event_count','channel_breakdown','filters'])clear.push(key);}
    if(explicitDeviceConversion||retainedDeviceConversion){set.requested_subject='device_conversion';set.metrics=['conversion'];set.analysis_type='ecommerce';set.channel='online';set.grain='month';set.tool_route='get_governed_device_conversion';for(const key of ['currencies','geography','customer_segment','product_ref','report_section','event_name','event_count','channel_breakdown','filters','platform'])clear.push(key);}
    if((explicitDeviceConversion||retainedDeviceConversion)&&/\bthis year(?:'s)?\b/i.test(text)&&/\blast year(?:'s)?\b/i.test(text)){const today=new Date(now),year=today.getUTCFullYear(),md=new Date(Date.UTC(year-1,today.getUTCMonth(),today.getUTCDate()));set.start_date=`${year}-01-01`;set.end_date=today.toISOString().slice(0,10);set.requested_end_period=String(year);set.comparison_type='matching_elapsed_year_on_year';set.comparison_start_date=`${year-1}-01-01`;set.comparison_end_date=md.toISOString().slice(0,10);set.partial_period=true;}
    if(/\bblack\s+friday\b/i.test(text)){set.contextual_event_mentions=['Black Friday'];if(excludedBlackFriday)set.exclusions=[...base.exclusions,'black friday'];}if(excludedMonthNumbers.size)set.exclusions=[...new Set([...(set.exclusions||base.exclusions),...[...excludedMonthNumbers].map(month=>Object.entries(MONTHS).find(([,number])=>number===month)?.[0])])];
    // A named evidence subject is a replacement, not a continuation of an
    // incompatible platform comparison. Keep reusable dates/currency only.
    const subjectSignals=[/\b(?:sales|revenue)\b/i,/\b(?:shipping\s+)?(?:countries|country|destinations?)\b/i,/\bcustomers?\b/i,/\bconv(?:ersion|erison)\b/i].filter(pattern=>pattern.test(text)).length;
    const focusedPeriodSubject=!set.included_periods||subjectSignals<=1;
    const countrySales=focusedPeriodSubject&&/\b(?:online\s+)?sales\b[\s\S]{0,60}\b(?:by|per|breakdown (?:by|of))\s+(?:shipping\s+)?(?:countries|country|destinations?)\b|\b(?:countries|country|destinations?)\b[\s\S]{0,60}\b(?:online\s+)?sales\b/i.test(text);
    const ordinarySales=!set.included_periods&&(/\b(?:online|shopify)\s+sales\b|\bsales\s+(?:this|last)\s+(?:month|year)\b/i.test(text));
    const explicitSubject=namedProduct||channelComparison?null:countrySales?'shipping_countries':explicitSalesBaseline||ordinarySales?'sales':focusedPeriodSubject&&/\b(?:shipping|delivery)\s+(?:countries|country|destinations?)\b/i.test(text)?'shipping_countries':focusedPeriodSubject&&/\bsearch\s+console\b|\borganic\s+(?:search|clicks?|impressions?)\b/i.test(text)?'search_console':focusedPeriodSubject&&/\bcustomers?\b/i.test(text)?'customers':null;
    if(explicitSubject){for(const key of ['tool_route','platform','comparison_type','comparison_start_date','comparison_end_date','geography','customer_segment','product_ref','report_section','advisory_topic','journey_intent','entry_product_classification','subsequent_product_classification','event_name','event_count'])clear.push(key);set.requested_subject=explicitSubject;set.metrics=[explicitSubject];set.analysis_type=explicitSubject==='customers'?'customers':explicitSubject==='sales'?'finance':'ecommerce';if(explicitSubject==='sales'){set.tool_route='get_shopify_operational_sales_baseline';set.channel_breakdown=true;clear.push('channel','currencies');}else if(explicitSubject==='shipping_countries'){set.tool_route='get_online_country_sales';set.geography='direct_shipping_country';set.channel='online';}else if(explicitSubject==='customers')set.tool_route='get_shopify_customer_kpis';else if(explicitSubject==='search_console')set.tool_route='get_search_console_evidence';}
    const explicitPlatformComparison=/\b(?:shopify|native shopify)\b[\s\S]*\b(?:woocommerce|woo)\b|\b(?:woocommerce|woo)\b[\s\S]*\bshopify\b/i.test(text)&&/\b(?:compare|comparison|versus|vs\.?|with)\b/i.test(text)&&/\b(?:sales|revenue|orders?)\b/i.test(text);
    if(explicitPlatformComparison){for(const key of ['tool_route','geography','customer_segment','product_ref','report_section','included_periods'])clear.push(key);set.requested_subject='platform_sales';set.analysis_type='finance';set.metrics=['sales','refunds'];set.platform='shopify+woo';set.channel='online';set.channel_breakdown=false;set.comparison_type='explicit_platform_periods';set.filters=['exclude_pos','exclude_matrixify'];}
    const historicalEvent=!excludedBlackFriday&&!set.included_periods&&/\bblack\s+friday\b/i.test(text)&&/\b(?:last|previous|recent|compare|comparison|overview|sales?|years?)\b/i.test(text);
    if(historicalEvent){const count=lower.match(/\blast\s+(\d{1,2})\s+(?:black\s+friday\s+)?(?:sales?|years?)\b/);set.event_name='Black Friday';set.event_count=Math.max(1,Math.min(Number(count?.[1]||3),5));set.tool_route='compare_historical_events';set.metrics=['sales','refunds','customers','products','ecommerce_performance'];set.analysis_type='ecommerce';set.channel='online';clear.push('start_date','end_date','requested_end_period','comparison_start_date','comparison_end_date');}
    else if(base.tool_route==='compare_historical_events'&&/\blast\s+(\d{1,2})\s+years?\b/i.test(text)){set.event_count=Math.max(1,Math.min(Number(text.match(/\blast\s+(\d{1,2})\s+years?\b/i)[1]),5));}
    const advisory=isStockClearanceAdvisory(text,base);
    if(advisory){set.request_kind='advisory';set.advisory_topic='stock_clearance';}
    const countryProducts=/\b(?:top\s+(?:ten|10)\s+)?(?:locations?|countries)\b[\s\S]*\bonline sales\b[\s\S]*\b(?:top\s+(?:ten|10)\s+)?products?\b|\bonline sales\b[\s\S]*\b(?:locations?|countries)\b[\s\S]*\bproducts?\b/i.test(text);
    if(countryProducts){set.tool_route='get_shopify_online_country_products';set.geography='direct_shipping_country';set.channel='online';}
    const categorySales=/\b(?:sunglasses|jewellery)\b[\s\S]*\b(?:sales|revenue)\b|\b(?:sales|revenue)\b[\s\S]*\b(?:sunglasses|jewellery)\b/i.test(text);
    if(categorySales){set.tool_route='get_governed_category_sales';set.metrics=['sales'];set.analysis_type='finance';}
    if(/\b(?:include|add).*woocommerce|\bwoocommerce\b.*\b(?:all )?online sales\b/i.test(text) && base.geography){set.tool_route='get_online_country_sales';set.platform='woo+shopify';set.channel='online';}
    const customerOrderInterval=/\b(?:average|mean|median)\b[\s\S]*\b(?:time|days?)\b[\s\S]*\bbetween\b[\s\S]*\b(?:online )?orders?\b[\s\S]*\b(?:same|each|per)\b[\s\S]*\bcustomer\b|\b(?:time|days?)\b[\s\S]*\bbetween consecutive (?:online )?orders?\b/i.test(text);
    if(customerOrderInterval){set.tool_route='get_average_customer_order_interval';set.metrics=['customer_order_interval'];set.analysis_type='customers';set.channel='online';}
    const viewsBeforePurchase=/\b(?:average|mean)\b[\s\S]*\bproducts?\b[\s\S]*\bviews?\b[\s\S]*\b(?:before (?:buying|purchase)|before .*buys?)\b/i.test(text);
    if(viewsBeforePurchase||base.tool_route==='get_product_views_before_purchase'&&/^(?:and |what about |show |break |compare|why|coverage)/i.test(lower)){set.tool_route='get_product_views_before_purchase';set.metrics=['product_views_before_purchase'];set.analysis_type='ecommerce';set.start_date='2026-01-01';set.end_date='2026-09-30';set.requested_end_period='2026-09-30';set.partial_period=true;set.comparison_type='last_woocommerce_year_before_migration';set.comparison_start_date='2024-11-20';set.comparison_end_date='2025-11-19';}
    const journey=/\b(?:first (?:observed )?(?:purchase|order)|bought? (?:after|next)|buy (?:after|next)|second (?:purchase|order)|third (?:purchase|order)|nth order|repeat (?:purchase )?rate|within \d+ days?|downstream|acquisition products?|customers? buy (?:after|next))\b/.test(lower);
    if(journey||base.analysis_type==='customer_journey'&&/^(?:okay[, ]+)?(?:which|what|within|on|exclude)\b/.test(lower)){set.metrics=['customer_journey'];set.analysis_type='customer_journey';set.journey_intent='purchase_sequence';const isFollowUp=base.analysis_type==='customer_journey';if(/collaboration/.test(lower)&&!isFollowUp)set.entry_product_classification='collaboration';else if(/\brings?\b/.test(lower)&&!isFollowUp)set.entry_product_classification='ring';else if(/\bclothing\b/.test(lower)&&!isFollowUp)set.entry_product_classification='clothing';if(/\bjewellery\b/.test(lower)){set.subsequent_product_classification='jewellery';set.include_unclassified_products=true}const excluded=[...lower.matchAll(/\bexclude\s+([^,.?]+?)(?=\s+(?:and|but|from|what|which)\b|[,.?]|$)/g)].map(m=>m[1].trim()).filter(Boolean);if(excluded.length)set.excluded_product_titles=[...base.excluded_product_titles,...excluded.map(x=>x.replace(/\b\w/g,c=>c.toUpperCase()))];if(/which collaboration/.test(lower))set.journey_group_by='collaboration_name';else if(/acquisition products?/.test(lower))set.journey_group_by='entry_product';else if(/each year separately|by (?:cohort )?year|annual cohorts?/.test(lower))set.journey_group_by='cohort_year_downstream_product';else if(/what|top|products?|items?/.test(lower))set.journey_group_by=base.journey_group_by==='cohort_year_downstream_product'?'cohort_year_downstream_product':'downstream_product';const seq=lower.match(/\b(second|third) (?:purchase|order)\b/);if(seq){const n=seq[1]==='second'?2:3;set.minimum_order_sequence=n;set.maximum_order_sequence=n}const days=lower.match(/\bwithin (30|60|90|365) days?\b/);if(days)set.within_days=+days[1]}
    else if(!explicitSubject&&!viewsBeforePurchase&&/\brefunds?\b/.test(lower)) set.metrics=['refunds'],set.analysis_type='finance';
    else if(!explicitSubject&&!viewsBeforePurchase&&/\bsales|revenue\b/.test(lower)) set.metrics=['sales'],set.analysis_type='finance';
    else if(!explicitSubject&&!viewsBeforePurchase&&/\bcustomers?\b/.test(lower)) set.metrics=['customers'],set.analysis_type='customers';
    else if(!explicitSubject&&!viewsBeforePurchase&&!productChoiceFollowup&&/\bproducts?\b/.test(lower)) set.metrics=['products'],set.analysis_type='products';
    for(const [pattern,grain] of [[/\bdaily\b/,'day'],[/\bweekly\b/,'week'],[/\bmonthly\b/,'month'],[/\bquarterly\b/,'quarter'],[/\byearly|annually\b/,'year']]) if(pattern.test(lower)) set.grain=grain;
    if(/each year separately|by (?:cohort )?year|annual cohorts?/.test(lower))set.grain='year';
    for(const currency of CURRENCIES) if(new RegExp(`\\b${currency}\\b`,'i').test(text)) set.currencies=[currency];
    if(/all currencies/i.test(text)) clear.push('currencies');
    if(/all channels/i.test(text)){clear.push('channel');set.channel_breakdown=false}
    else if(/split .*online.*(?:in ?store|pos)|split .*(?:in ?store|pos).*online/i.test(lower)) {clear.push('channel');set.channel_breakdown=true}
    else if(/(?:online only|just online)/i.test(lower)) set.channel='online',set.channel_breakdown=false;
    else if(/(?:in ?store|pos) only/i.test(lower)) set.channel='instore',set.channel_breakdown=false;
    if(/\b(?:graph|chart)(?:\s+(?:that|it))?\b/i.test(lower)) set.output_preference='chart';
    if(/^\s*(?:why|what (?:caused|explains))\b/i.test(text)){set.explanation_requested=true;set.output_preference='explanation';if(base.tool_route!=='get_governed_category_sales'&&(base.requested_subject==='channel_sales'||base.requested_subject==='sales'||/\b(?:sales|revenue)\b/i.test(text))){set.tool_route='get_general_sales_analysis';set.requested_subject='channel_sales';set.metrics=['sales'];set.analysis_type='finance';if(/\bonline\b/i.test(text)){set.channel='online';set.channel_breakdown=false;}}}
    const top=lower.match(/top\s+(\d{1,3})/);if(top){set.limit=Math.min(+top[1],100);set.sort='descending'}
    if(/exclude pos/i.test(lower)) set.filters=[...base.filters.filter(x=>x!=='exclude_pos'),'exclude_pos'];
    if(/include pos|clear (?:the )?filters?/i.test(lower)) clear.push('filters');
    if(!viewsBeforePurchase&&!['get_product_views_before_purchase','compare_historical_events'].includes(set.tool_route))Object.assign(set,period(text,now)||{});
    if(!base.currencies.length&&!set.currencies&&set.analysis_type==='finance'&&!['get_shopify_online_country_products','get_online_country_sales','get_governed_category_sales','get_shopify_operational_sales_baseline'].includes(set.tool_route||base.tool_route)&&!advisory) set.currencies=['GBP'];
  }
  const effectiveClear=clear.filter(key=>!Object.hasOwn(set,key));const next={...base,...set};if(next.analysis_type==='customer_journey'){next.first_order_semantic=next.first_order_semantic||'first_observed_ever';if(next.start_date){next.cohort_entry_start=next.start_date;next.cohort_entry_end=next.end_date;next.observation_end=next.end_date;}}for(const key of effectiveClear) next[key]=emptyAnalysisContext()[key];
  const missing=[];if(next.metrics.length&&!next.start_date&&next.tool_route!=='compare_historical_events'&&!['advisory','knowledge_save','policy_definition'].includes(next.request_kind)) missing.push('start_date','end_date');
  next.unresolved_required_fields=[...new Set(missing)];
  const ready=next.metrics.length>0&&(next.tool_route==='compare_historical_events'||Boolean(next.start_date&&next.end_date));
  const changed=Object.keys(set).filter(k=>JSON.stringify(base[k])!==JSON.stringify(next[k]));
  const retained=ANALYSIS_CONTEXT_FIELDS.filter(k=>!changed.includes(k)&&!effectiveClear.includes(k)&&JSON.stringify(next[k])!==JSON.stringify(emptyAnalysisContext()[k]));
  return {context:validateAnalysisContext(next),transition:{continuation,set:changed,clear:[...new Set(effectiveClear)],retain:retained,missing_required_fields:next.unresolved_required_fields,ready_to_execute:ready,applies_to_message:!unrelated}};
}

export function initializeFromReportContext(existing, report={}){
  const allowed={...existing,report_section:report.report_section||null,start_date:report.current_period?.start_date,end_date:report.current_period?.end_date,comparison_start_date:report.comparison_period?.start_date,comparison_end_date:report.comparison_period?.end_date,comparison_type:report.comparison_type||null,currencies:report.selected_currencies||[],metrics:(report.relevant_metric_identifiers||[]).filter(x=>METRICS.has(x))};
  return validateAnalysisContext(allowed);
}
export function analysisScope(context){const c=validateAnalysisContext(context);if(!c.metrics.length)return null;return [c.metrics.join('/'),c.grain,c.start_date&&`${c.start_date}–${c.end_date}`,c.currencies.join('/'),c.channel_breakdown?'online vs instore':c.channel||'all channels'].filter(Boolean).join(' · ')}
export function clarificationFor(context){const c=validateAnalysisContext(context);if(c.unresolved_required_fields.includes('start_date')){if(c.tool_route==='get_shopify_online_country_products')return 'What date range would you like? I’ll keep each currency in a separate ranking unless you specify one.';if(c.analysis_type!=='finance')return 'What date range would you like?';return `What date range would you like? I’ll use ${c.currencies[0]||'GBP'} unless you specify another currency.`;}return null}
