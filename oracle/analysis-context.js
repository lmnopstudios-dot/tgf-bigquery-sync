import { campaignContextPatch, validateCampaignRequest } from './campaign-context.js';
import {currentStockScope} from './current-stock.js';
import {socialContextPatch,validateSocialScope} from './social-context.js';
import { classifyKlaviyoQuestion } from './klaviyo-email.js';
import { naturalReportPeriod as period } from './report-natural-period.js';
import { isProductReportRequest, resolveProductReportConfig, validateProductReportConfig, productReportClarification } from './product-report-config.js';
import { isProductPriorityRequest, priorityDates } from './product-priority.js';
import { isStockClearanceAdvisory } from './advisory-intent.js';

const FIELDS = new Set([
  'analysis_type','metrics','start_date','end_date','requested_end_period','grain','comparison_type',
  'comparison_start_date','comparison_end_date','currencies','channel','channel_breakdown','location',
  'platform','geography','customer_segment','product_ref','filters','sort','limit','report_section',
  'output_preference','partial_period','date_cutoff','current_day_included','unresolved_required_fields'
  ,'tool_route','request_kind','advisory_topic'
  ,'journey_intent','entry_product_classification','subsequent_product_classification','excluded_product_titles','include_unclassified_products','first_order_semantic','cohort_entry_start','cohort_entry_end','observation_end','minimum_order_sequence','maximum_order_sequence','within_days','journey_group_by'
  ,'event_name','event_count'
  ,'requested_subject','included_periods','exclusions','contextual_event_mentions','placement_context'
  ,'campaign_request','failed_subject_switch'
  ,'product_report','email_report_kind','social_scope'
  ,'entity_query','explanation_requested','pending_product_candidates'
]);
const GRAINS = new Set(['day','week','month','quarter','year']);
const CURRENCIES = new Set(['GBP','USD','JPY','EUR']);
const METRICS = new Set(['sales','refunds','customers','products','search_console','shipping_countries','ecommerce_performance','customer_journey','customer_order_interval','product_views_before_purchase','conversion','email_attribution','meta_ads','instagram','tiktok']);
export const ANALYSIS_TOOL_ROUTES = Object.freeze(['get_shopify_inventory_by_location','get_meta_performance','get_instagram_performance','get_tiktok_performance','get_shopify_online_country_products','get_online_country_sales','get_shopify_customer_kpis','get_search_console_evidence','get_average_customer_order_interval','get_governed_category_sales','get_product_views_before_purchase','compare_historical_events','get_shopify_operational_sales_baseline','get_woocommerce_device_conversion','get_governed_device_conversion','get_general_sales_analysis','get_product_sales_analysis','export_product_priorities','get_klaviyo_email_performance','get_klaviyo_click_purchase_opportunities','compare_klaviyo_email_with_shopify_referrer']);
const TOOL_ROUTES = new Set(ANALYSIS_TOOL_ROUTES);
const MONTHS = {jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};

export const ANALYSIS_CONTEXT_FIELDS = Object.freeze([...FIELDS]);
export function emptyAnalysisContext(){return {analysis_type:null,metrics:[],start_date:null,end_date:null,requested_end_period:null,grain:null,comparison_type:null,comparison_start_date:null,comparison_end_date:null,currencies:[],channel:null,channel_breakdown:false,location:null,platform:null,geography:null,customer_segment:null,product_ref:null,filters:[],sort:null,limit:null,report_section:null,output_preference:null,partial_period:false,date_cutoff:null,current_day_included:false,unresolved_required_fields:[],tool_route:null,request_kind:null,advisory_topic:null,journey_intent:null,entry_product_classification:null,subsequent_product_classification:null,excluded_product_titles:[],include_unclassified_products:false,first_order_semantic:null,cohort_entry_start:null,cohort_entry_end:null,observation_end:null,minimum_order_sequence:null,maximum_order_sequence:null,within_days:null,journey_group_by:null,event_name:null,event_count:null,requested_subject:null,included_periods:[],exclusions:[],contextual_event_mentions:[],placement_context:null,entity_query:null,explanation_requested:false,pending_product_candidates:[],product_report:null,email_report_kind:null,social_scope:null,failed_subject_switch:null,campaign_request:null}}

function contextValidationError(field,rule,message=`invalid ${field}`){const error=Object.assign(new Error(message),{code:'INVALID_ANALYSIS_CONTEXT',validation_field:field,validation_rule:rule});return error}

export const validSubject=value=>typeof value==='string'&&/^[a-z][a-z_]{0,99}$/.test(value);
const iso = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')) ? value : null;
export function validateAnalysisContext(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('analysis context must be an object');
  for(const key of Object.keys(value)) if(!FIELDS.has(key)) throw contextValidationError('unknown_field','recognized_field',`invalid analysis context field: ${key}`);
  const out={...emptyAnalysisContext()};
  if(value.analysis_type!=null&&!['finance','customers','products','ecommerce','customer_journey'].includes(value.analysis_type)) throw new Error('invalid analysis_type');
  out.analysis_type=value.analysis_type??null;
  if(value.failed_subject_switch!=null&&(!value.failed_subject_switch||typeof value.failed_subject_switch!=='object'||!validSubject(value.failed_subject_switch.attempted_subject)||!validSubject(value.failed_subject_switch.previous_subject)))throw contextValidationError('failed_subject_switch','supported_subjects');
  out.failed_subject_switch=value.failed_subject_switch?{attempted_subject:value.failed_subject_switch.attempted_subject,previous_subject:value.failed_subject_switch.previous_subject,attempted_year:Number.isInteger(value.failed_subject_switch.attempted_year)?value.failed_subject_switch.attempted_year:null}:null;
  out.campaign_request=validateCampaignRequest(value.campaign_request);
  out.social_scope=validateSocialScope(value.social_scope);
  out.email_report_kind=['campaign','flow','all'].includes(value.email_report_kind)?value.email_report_kind:null;
  out.product_report=value.product_report==null?null:validateProductReportConfig(value.product_report);
  out.metrics=[...new Set(value.metrics||[])].filter(x=>METRICS.has(x)).slice(0,8);
  for(const key of ['start_date','end_date','cohort_entry_start','cohort_entry_end','observation_end','comparison_start_date','comparison_end_date','date_cutoff']) {if(value[key]!=null&&!iso(value[key])) throw new Error(`invalid ${key}`);out[key]=value[key]??null}
  if(value.grain!=null&&!GRAINS.has(value.grain)) throw new Error('invalid grain'); out.grain=value.grain??null;
  out.requested_end_period=typeof value.requested_end_period==='string'?value.requested_end_period.slice(0,20):null;
  out.comparison_type=typeof value.comparison_type==='string'?value.comparison_type.slice(0,32):null;
  out.currencies=[...new Set(value.currencies||[])].filter(x=>CURRENCIES.has(x)).slice(0,4);
  out.channel=['online','instore'].includes(value.channel)?value.channel:null; out.channel_breakdown=Boolean(value.channel_breakdown);
  for(const key of ['location','platform','geography','customer_segment','product_ref','sort','report_section','output_preference']) out[key]=typeof value[key]==='string'?value[key].slice(0,100):null;
  out.filters=Array.isArray(value.filters)?value.filters.filter(x=>typeof x==='string'&&x.length<=100&&!/@|phone|email|customer[_ -]?id/i.test(x)).slice(0,12):[];
  out.limit=Number.isInteger(value.limit)&&value.limit>0&&value.limit<=100?value.limit:null;
  out.partial_period=Boolean(value.partial_period);out.current_day_included=Boolean(value.current_day_included);
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
  out.placement_context=typeof value.placement_context==='string'?value.placement_context.slice(0,300):null;
  out.entity_query=typeof value.entity_query==='string'?value.entity_query.slice(0,160):null;
  out.explanation_requested=Boolean(value.explanation_requested);
  out.pending_product_candidates=Array.isArray(value.pending_product_candidates)?value.pending_product_candidates.slice(0,8).map(candidate=>({product_ref:typeof candidate?.product_ref==='string'?candidate.product_ref.slice(0,240):'',catalogue_titles:Array.isArray(candidate?.catalogue_titles)?candidate.catalogue_titles.filter(x=>typeof x==='string').map(x=>x.slice(0,160)).slice(0,8):[],sources:Array.isArray(candidate?.sources)?candidate.sources.slice(0,12).map(source=>({source_platform:typeof source?.source_platform==='string'?source.source_platform.slice(0,32):null,source_store:typeof source?.source_store==='string'?source.source_store.slice(0,32):null,source_product_ref:typeof source?.source_product_ref==='string'?source.source_product_ref.slice(0,240):null})).filter(source=>source.source_product_ref):[],reporting_family_relationships:Array.isArray(candidate?.reporting_family_relationships)?candidate.reporting_family_relationships.filter(x=>typeof x==='string').map(x=>x.slice(0,160)).slice(0,8):[]})).filter(candidate=>candidate.product_ref):[];
  return out;
}


export function transitionAnalysisContext(existing, message, {now=Date.now(),reportContext=null}={}){
  let base=validateAnalysisContext(existing||{}); const text=String(message||'').trim(), lower=text.toLowerCase();
  if(/^(?:new (?:question|analysis)|forget that|start over)\b/i.test(text))return transitionAnalysisContext(emptyAnalysisContext(),text.replace(/^(?:new (?:question|analysis)|forget that|start over)\s*[:,.]?\s*/i,''),{now});
  if(reportContext) base=initializeFromReportContext(base,reportContext);
  const campaign=campaignContextPatch(base,text,now);
  if(campaign){const context=validateAnalysisContext({...emptyAnalysisContext(),...campaign.patch});return {context,transition:{continuation:campaign.continuation,set:ANALYSIS_CONTEXT_FIELDS.filter(k=>JSON.stringify(base[k])!==JSON.stringify(context[k])),clear:[],retain:campaign.continuation?['campaign_request','requested_subject','metrics']:[],missing_required_fields:[],ready_to_execute:true,applies_to_message:true}};}
  const stock=currentStockScope(text);
  if(stock){const context=validateAnalysisContext({...emptyAnalysisContext(),requested_subject:'current_stock',tool_route:'get_shopify_inventory_by_location',entity_query:stock.entity_query,location:stock.all_locations?null:stock.location});return {context,transition:{continuation:false,set:['requested_subject','tool_route','entity_query','location'],clear:ANALYSIS_CONTEXT_FIELDS.filter(k=>base[k]!=null&&context[k]==null),retain:[],missing_required_fields:[],ready_to_execute:true,applies_to_message:true}};}
  if(base.requested_subject==='current_stock'&&base.pending_product_candidates.length){
    const selection=text.match(/^(?:(?:use|choose|pick|select)\s+)?(?:choice\s+|option\s+)?#?(\d+)\s*[.!]?$/i);
    const candidate=selection?base.pending_product_candidates[Number(selection[1])-1]:base.pending_product_candidates.find(c=>c.product_ref===text||c.catalogue_titles.some(t=>t.toLowerCase()===lower));
    if(candidate){const context=validateAnalysisContext({...base,product_ref:candidate.product_ref,entity_query:candidate.catalogue_titles[0]||base.entity_query});return{context,transition:{continuation:true,set:['product_ref','entity_query'],clear:[],retain:[],missing_required_fields:[],ready_to_execute:true,applies_to_message:true}};}
  }
  const social=socialContextPatch(base,text,now);
  if(social){const context=validateAnalysisContext({...emptyAnalysisContext(),...social});context.unresolved_required_fields=context.start_date&&context.end_date?[]:['start_date','end_date'];return {context,transition:{continuation:base.requested_subject===context.requested_subject,set:ANALYSIS_CONTEXT_FIELDS.filter(k=>JSON.stringify(base[k])!==JSON.stringify(context[k])),clear:[],retain:[],missing_required_fields:context.unresolved_required_fields,ready_to_execute:!context.unresolved_required_fields.length,applies_to_message:true}};}
  if(isProductPriorityRequest(text)||isProductReportRequest(text,base.product_report)){
    const defaults=priorityDates(now),rolling=text.match(/\blast\s+(\d{1,4})\s+(?:completed\s+)?days?\b/i);
    let dates=period(text,now);
    if(rolling){const end=new Date(`${defaults.end_date}T00:00:00Z`),start=new Date(+end-(Number(rolling[1])-1)*86400000);dates={start_date:start.toISOString().slice(0,10),end_date:defaults.end_date};}
    const {config,continuation}=resolveProductReportConfig(text,{previous:base.product_report,period:dates,defaultPeriod:{start_date:defaults.start_date,end_date:defaults.end_date},now,priority:isProductPriorityRequest(text)||/\b(?:photography|content)\b.*\bpriority list\b/i.test(text)});
    const context=validateAnalysisContext({...emptyAnalysisContext(),analysis_type:'products',metrics:['products'],requested_subject:config.priority_preset?'product_priority':'product_report',tool_route:'export_product_priorities',channel:config.channel,platform:'shopify',output_preference:config.output_format,start_date:config.period.start_date,end_date:config.period.end_date,limit:config.population.limit,product_report:config});
    const changed=ANALYSIS_CONTEXT_FIELDS.filter(key=>JSON.stringify(base[key])!==JSON.stringify(context[key]));
    return{context,transition:{continuation,set:changed,clear:changed.filter(key=>context[key]==null),retain:ANALYSIS_CONTEXT_FIELDS.filter(key=>!changed.includes(key)),missing_required_fields:config.unresolved,ready_to_execute:!productReportClarification(config),applies_to_message:true}};
  }
  const emailRoute=/\b(?:comprehensive\s+)?ecommerce baseline\b/i.test(text)?null:classifyKlaviyoQuestion(text);
  if(emailRoute){
    const dates=period(text,now)||(base.start_date?{start_date:base.start_date,end_date:base.end_date,partial_period:base.partial_period}:{});
    const context=validateAnalysisContext({...emptyAnalysisContext(),...dates,requested_subject:'klaviyo_email',metrics:['email_attribution'],analysis_type:'ecommerce',platform:'klaviyo',grain:'month',email_report_kind:/\bcampaigns?\b/i.test(text)&&!/\bflows?\b/i.test(text)?'campaign':/\bflows?\b/i.test(text)&&!/\bcampaigns?\b/i.test(text)?'flow':'all',tool_route:emailRoute});
    const missing=context.start_date?[]:['start_date','end_date'];context.unresolved_required_fields=missing;
    return {context,transition:{continuation:false,set:ANALYSIS_CONTEXT_FIELDS.filter(k=>JSON.stringify(base[k])!==JSON.stringify(context[k])),clear:[],retain:[],missing_required_fields:missing,ready_to_execute:!missing.length,applies_to_message:true}};
  }
  if(/\bhow\s+(?:has|have|did)\s+.+?\s+(?:affected|effected|influenced|impacted)\b/i.test(text)){
    const context={...emptyAnalysisContext(),unresolved_required_fields:['requested_subject']};
    return {context,transition:{continuation:false,set:[],clear:ANALYSIS_CONTEXT_FIELDS,retain:[],missing_required_fields:['requested_subject'],ready_to_execute:false,applies_to_message:true}};
  }
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
    const retainedDeviceConversion=base.tool_route==='get_governed_device_conversion'&&/\b(?:conversion(?:\s+rates?)?|better|worse|changed|between|last year|year[- ]on[- ]year)\b/i.test(text);
    const productMatch=text.match(/\b(?:sales|revenue)\s+(?:breakdown\s+)?(?:of|for)\s+(.+?)(?=\s+(?:this|last)\s+(?:year|month|week)\b|\s+been\b|\s+since\b|\s+(?:in|over|during|for)\s+(?:the\s+)?(?:last|past|this)\b|\s+(?:in|for|during)\s+20\d{2}\b|[?.!]|$)/i);
    if(/\b(?:cross[ -]?sell|cart recommendation)\b/i.test(text)){set.placement_context=text.slice(0,300);if(/\bsince we\b/i.test(text))clear.push('start_date','end_date','date_cutoff','current_day_included','partial_period');}
    const candidateProduct=productMatch?.[1]?.trim().replace(/^(?:the\s+)?product\s+/i,'');
    const namedProduct=candidateProduct&&!/\b(?:shipping|countries|country|customers?|conversion)\b/i.test(text)&&!new RegExp(`^(?:${Object.keys(MONTHS).join('|')}|20\\d{2})\\b`,'i').test(candidateProduct)?candidateProduct:null;
    const channelComparison=!explicitSalesBaseline&&base.tool_route!=='get_governed_category_sales'&&(/\bonline\b[\s\S]{0,50}\b(?:in[ -]?store|retail|pos)\b|\b(?:in[ -]?store|retail|pos)\b[\s\S]{0,50}\bonline\b/i.test(text))&&/\b(?:sales|revenue)\b/i.test(text);
    if(namedProduct){for(const key of ['platform','geography','customer_segment','comparison_type','comparison_start_date','comparison_end_date','included_periods','event_name','event_count','filters','output_preference','product_ref','pending_product_candidates'])clear.push(key);set.requested_subject='product_sales';set.entity_query=namedProduct;set.metrics=['sales'];set.analysis_type='products';set.tool_route='get_product_sales_analysis';set.channel_breakdown=!base.channel;if(/\bonline\b/i.test(text)){set.channel='online';set.channel_breakdown=false;}set.grain=/\b(?:monthly|by month)\b/i.test(text)?'month':base.grain||'month';}
    else if(channelComparison){for(const key of ['platform','geography','customer_segment','product_ref','entity_query','comparison_type','comparison_start_date','comparison_end_date','included_periods','event_name','event_count','filters','output_preference'])clear.push(key);set.requested_subject='channel_sales';set.metrics=['sales'];set.analysis_type='finance';set.tool_route='get_general_sales_analysis';set.channel_breakdown=true;set.grain=/\b(?:monthly|by month)\b/i.test(text)?'month':'month';}
    if(namedMonths.length===2&&namedYears.length===2&&namedMonths[0]===namedMonths[1]&&/\b(?:versus|vs\.?|compared? (?:with|to))\b/i.test(text)){const pairs=[...lower.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/g)].map(x=>({month:MONTHS[x[1]],year:Number(x[2])})).sort((a,b)=>b.year-a.year),toPeriod=x=>({start_date:`${x.year}-${String(x.month).padStart(2,'0')}-01`,end_date:new Date(Date.UTC(x.year,x.month,0)).toISOString().slice(0,10)}),current=toPeriod(pairs[0]),comparisonPeriod=toPeriod(pairs[1]);Object.assign(set,current,{comparison_type:'explicit_period_comparison',comparison_start_date:comparisonPeriod.start_date,comparison_end_date:comparisonPeriod.end_date,partial_period:false});}
    if(namedMonths.length>1&&namedYears.length&&set.comparison_type!=='explicit_period_comparison'){const months=[...new Set(namedMonths)],years=[...new Set(namedYears)],range=lower.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?\s*(?:-|–|—|through|to)\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/);if(range){const startYear=Number(range[2]||range[4]),endYear=Number(range[4]),startMonth=MONTHS[range[1]],endMonth=MONTHS[range[3]],expanded=[];for(let cursor=new Date(Date.UTC(startYear,startMonth-1,1)),last=Date.UTC(endYear,endMonth-1,1);cursor.getTime()<=last;cursor.setUTCMonth(cursor.getUTCMonth()+1))expanded.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth()+1).padStart(2,'0')}`);set.included_periods=expanded;}else set.included_periods=years.flatMap(year=>months.map(month=>`${year}-${String(month).padStart(2,'0')}`));set.requested_subject='calendar_period_comparison';set.comparison_type='independent_calendar_months';set.grain='month';set.start_date=`${Math.min(...years)}-${String(Math.min(...months)).padStart(2,'0')}-01`;const lastYear=Math.max(...years),lastMonth=Math.max(...months);set.end_date=new Date(Date.UTC(lastYear,lastMonth,0)).toISOString().slice(0,10);set.requested_end_period=`${lastYear}-${String(lastMonth).padStart(2,'0')}`;for(const key of ['tool_route','event_name','event_count'])clear.push(key);}
    if(focusedWooConversion&&set.included_periods){set.requested_subject='woo_traffic_conversion';set.metrics=['conversion'];set.analysis_type='ecommerce';set.platform='woo';set.channel='online';set.tool_route='get_woocommerce_device_conversion';for(const key of ['currencies','geography','customer_segment','product_ref','report_section','event_name','event_count','channel_breakdown','filters'])clear.push(key);}
    if(explicitDeviceConversion){for(const key of ['comparison_type','comparison_start_date','comparison_end_date','included_periods','exclusions','output_preference','explanation_requested','failed_subject_switch'])clear.push(key);}
    if(explicitDeviceConversion||retainedDeviceConversion){set.requested_subject='device_conversion';set.metrics=['conversion'];set.analysis_type='ecommerce';set.channel='online';set.grain='month';set.tool_route='get_governed_device_conversion';for(const key of ['currencies','geography','customer_segment','product_ref','report_section','event_name','event_count','channel_breakdown','filters','platform','entity_query','pending_product_candidates','product_report'])clear.push(key);}
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
    else if(!namedProduct&&!explicitSubject&&!viewsBeforePurchase&&/\bsales|revenue\b/.test(lower)) set.metrics=['sales'],set.analysis_type='finance';
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
    if(!viewsBeforePurchase&&!['get_product_views_before_purchase','compare_historical_events'].includes(set.tool_route)){
      const dates=period(/\bsince we\b/i.test(text)&&set.placement_context?text.replace(/\bsince we\b[\s\S]*$/i,''):text,now);if(dates){Object.assign(set,dates);if(!dates.comparison_start_date&&!/\b(?:versus|vs|compare|comparison)\b/i.test(text))clear.push('comparison_type','comparison_start_date','comparison_end_date','included_periods');}
    }
    if(namedMonths.length===2&&/\b(?:between|compare|changed|versus|vs)\b/i.test(text)&&namedYears.length<=1){
      const year=Number(namedYears[0]||base.failed_subject_switch?.attempted_year||base.start_date?.slice(0,4)||new Date(now).getUTCFullYear()),ranges=namedMonths.map(m=>({start_date:`${year}-${String(m).padStart(2,'0')}-01`,end_date:new Date(Date.UTC(year,m,0)).toISOString().slice(0,10)}));
      Object.assign(set,ranges[1],{comparison_start_date:ranges[0].start_date,comparison_end_date:ranges[0].end_date,comparison_type:'explicit_period_comparison',requested_end_period:ranges[1].start_date.slice(0,7),partial_period:false,included_periods:[]});
    }
    if(base.failed_subject_switch&&['device_conversion','product_sales'].includes(base.failed_subject_switch.attempted_subject)&&['device_conversion','product_sales'].includes(base.failed_subject_switch.previous_subject)&&/\b(?:conversion|product sales)\b/i.test(text)){
      const selected=/\bconversion\b/i.test(text)?'device_conversion':'product_sales';set.requested_subject=selected;set.tool_route=selected==='device_conversion'?'get_governed_device_conversion':'get_product_sales_analysis';set.metrics=[selected==='device_conversion'?'conversion':'sales'];set.analysis_type=selected==='device_conversion'?'ecommerce':'products';clear.push('failed_subject_switch');if(selected==='device_conversion'){clear.push('social_scope','entity_query','product_ref','pending_product_candidates');set.channel='online';}
    }
    if(!base.currencies.length&&!set.currencies&&set.analysis_type==='finance'&&!['get_shopify_online_country_products','get_online_country_sales','get_governed_category_sales','get_shopify_operational_sales_baseline','get_general_sales_analysis','get_product_sales_analysis'].includes(set.tool_route||base.tool_route)&&!advisory) set.currencies=['GBP'];
  }
  const scopeOnly=Boolean(period(text,now)&&/^(?:(?:what about|how about|for|in|during)\s+)?(?:the\s+)?(?:last|this|past|since)\b/i.test(text))||(base.tool_route==='get_product_sales_analysis'&&/\b(?:choice|choose|product identit|stable reference)\b/i.test(text))||/^(?:by month|just online|online only|what about (?:last year|this year|20\d{2})|exclude\b|sort\b|add\b|graph\b|chart\b|why\b|what changed between\b|for\b|in\b|last year\b|this year\b)/i.test(text);
  if(base.metrics.length&&/^(?:how|what|which|can you|could you|show me)\b/i.test(text)&&Object.keys(set).every(k=>['metrics','analysis_type','start_date','end_date','requested_end_period','partial_period','grain','date_cutoff','current_day_included'].includes(k))&&!scopeOnly&&!unrelated){
    const context={...emptyAnalysisContext(),unresolved_required_fields:['requested_subject']};
    return {context,transition:{continuation:false,set:[],clear:ANALYSIS_CONTEXT_FIELDS,retain:[],missing_required_fields:['requested_subject'],ready_to_execute:false,applies_to_message:true}};
  }
  if(set.requested_subject&&set.requested_subject!==base.requested_subject)clear.push('campaign_request','social_scope','entity_query','product_ref','pending_product_candidates','explanation_requested','output_preference','failed_subject_switch','email_report_kind','placement_context');
  if(set.tool_route&&set.tool_route!=='export_product_priorities')clear.push('product_report');
  const effectiveClear=clear.filter(key=>!Object.hasOwn(set,key));const next={...base,...set};if(next.analysis_type==='customer_journey'){next.first_order_semantic=next.first_order_semantic||'first_observed_ever';if(next.start_date){next.cohort_entry_start=next.start_date;next.cohort_entry_end=next.end_date;next.observation_end=next.end_date;}}for(const key of effectiveClear) next[key]=emptyAnalysisContext()[key];
  const missing=[];if(next.metrics.length&&(!next.start_date||!next.end_date)&&next.tool_route!=='compare_historical_events'&&!['advisory','knowledge_save','policy_definition'].includes(next.request_kind)) {if(!next.start_date)missing.push('start_date');if(!next.end_date)missing.push('end_date');}
  if(next.start_date&&next.end_date){next.date_cutoff=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));next.current_day_included=next.start_date<=next.date_cutoff&&next.end_date>=next.date_cutoff;}
  next.unresolved_required_fields=[...new Set(missing)];
  const ready=!next.failed_subject_switch&&next.metrics.length>0&&(next.tool_route==='compare_historical_events'||Boolean(next.start_date&&next.end_date));
  const changed=Object.keys(set).filter(k=>JSON.stringify(base[k])!==JSON.stringify(next[k]));
  const retained=ANALYSIS_CONTEXT_FIELDS.filter(k=>!changed.includes(k)&&!effectiveClear.includes(k)&&JSON.stringify(next[k])!==JSON.stringify(emptyAnalysisContext()[k]));
  return {context:validateAnalysisContext(next),transition:{continuation,set:changed,clear:[...new Set(effectiveClear)],retain:retained,missing_required_fields:next.unresolved_required_fields,ready_to_execute:ready,applies_to_message:!unrelated}};
}

export function initializeFromReportContext(existing, report={}){
  const allowed={...existing,report_section:report.report_section||null,start_date:report.current_period?.start_date,end_date:report.current_period?.end_date,comparison_start_date:report.comparison_period?.start_date,comparison_end_date:report.comparison_period?.end_date,comparison_type:report.comparison_type||null,currencies:report.selected_currencies||[],metrics:(report.relevant_metric_identifiers||[]).filter(x=>METRICS.has(x))};
  return validateAnalysisContext(allowed);
}
export function analysisScope(context){if(context==null)return null;const c=validateAnalysisContext(context);if(c.requested_subject==='current_stock')return `Current stock · ${c.entity_query} · ${c.location||'all active locations'}`;if(!c.metrics.length)return null;return [c.metrics.join('/'),c.grain,c.start_date&&`${c.start_date}–${c.end_date}${c.comparison_start_date?` vs ${c.comparison_start_date}–${c.comparison_end_date}`:''}`,c.currencies.join('/'),c.channel_breakdown?'online vs instore':c.channel||'all channels'].filter(Boolean).join(' · ')}
export function clarificationFor(context){const c=validateAnalysisContext(context);if(c.campaign_request)return null;if(c.failed_subject_switch){if([c.failed_subject_switch.attempted_subject,c.failed_subject_switch.previous_subject].every(s=>['device_conversion','product_sales'].includes(s)))return 'Do you mean conversion rates or product sales for that comparison? The conversion request failed, so I will not reuse the previous product table.';return `Which subject do you mean: ${c.failed_subject_switch.attempted_subject.replaceAll('_',' ')} or ${c.failed_subject_switch.previous_subject.replaceAll('_',' ')}? The subject switch failed; please specify the analysis to retry.`;}if(c.unresolved_required_fields.includes('requested_subject'))return 'Which analysis do you mean? Please specify a supported subject such as sales, customers, product sales, device conversion, shipping countries or Klaviyo email attribution.';if(c.product_report)return productReportClarification(c.product_report);if(c.unresolved_required_fields.includes('start_date')||c.unresolved_required_fields.includes('end_date')){if(c.tool_route==='get_shopify_online_country_products')return 'What date range would you like? I’ll keep each currency in a separate ranking unless you specify one.';if(c.analysis_type!=='finance')return 'What date range would you like?';return `What date range would you like? I’ll use ${c.currencies[0]||'GBP'} unless you specify another currency.`;}return null}
