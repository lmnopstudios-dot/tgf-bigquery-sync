import { promotionIntent } from './promotion-context.js';
import { naturalReportPeriod } from './report-natural-period.js';

export const requestedDimensions=text=>/\b(?:weekdays?|days? of (?:the )?week)\b/i.test(text)?['weekday']:null;

export function validatePromotionContext(value) {
  if(value==null)return null;
  if(!value||typeof value.query!=='string'||!value.query.trim()||value.query.length>160||!['compare_excluding','include'].includes(value.treatment))throw Error('Invalid promotion context');
  const supplied_periods=(value.supplied_periods||[]).map(p=>{
    for(const d of [p.start_date,p.end_date])if(!/^\d{4}-\d{2}-\d{2}$/.test(d||'')||new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)!==d)throw Error('Invalid promotion dates');
    if(p.start_date>p.end_date)throw Error('Invalid promotion window');
    return {start_date:p.start_date,end_date:p.end_date};
  });
  if(supplied_periods.length>10)throw Error('Too many promotion windows');
  if(value.pending_endpoint_date&&!/^\d{4}-\d{2}-\d{2}$/.test(value.pending_endpoint_date))throw Error('Invalid pending endpoint date');
  if(value.endpoint_choice&&!['start_of_day','end_of_day'].includes(value.endpoint_choice))throw Error('Invalid promotion endpoint');
  if(value.endpoint_zone&&!['GMT','UTC','BST'].includes(value.endpoint_zone))throw Error('Invalid endpoint timezone');
  if(value.calendar_instruction!=null&&(typeof value.calendar_instruction!=='string'||value.calendar_instruction.length>2000))throw Error('Invalid calendar instruction');
  return {...(value.endpoint_zone?{endpoint_zone:value.endpoint_zone}:{}),...(value.calendar_instruction?{calendar_instruction:value.calendar_instruction}:{}),pending_endpoint_date:value.pending_endpoint_date||null,endpoint_choice:value.endpoint_choice||null,pending_endpoint:Boolean(value.pending_endpoint),query:value.query,treatment:value.treatment,pending_dates:Boolean(value.pending_dates),supplied_periods};
}
/** Independent grouping, measure, date and output refinements for an existing sales subject. */
export function dailySalesContextPatch(base,text,now) {
  const weekday=Boolean(requestedDimensions(text));
  const fresh=weekday&&/\b(?:sales|revenue|orders)\b/i.test(text)&&!/\b(?:sales|revenue) (?:of|for)\b|\b(?:campaigns?|klaviyo|conversion|customers?|flows?)\b/i.test(text);
  const regroup=weekday&&['sales','channel_sales'].includes(base.requested_subject)&&/^(?:by|group|break|show)\b/i.test(text)&&!fresh;
  const retained=base.tool_route==='get_daily_sales_analysis';
  const refine=retained&&(/^(?:online[.!]?$|in[ -]?store[.!]?$|by |sort |rank |include |exclude |excluding |just |only |for |in |export |download |chart |graph |retry |try again)/i.test(text)||base.promotion_context?.pending_endpoint&&/\b(?:start|beginning|end) of (?:the |that )?(?:day|\d{1,2} [a-z]+|[a-z]+ \d{1,2})\b/i.test(text)||base.promotion_context?.pending_dates&&/\b20\d{2}-\d{2}-\d{2}\b/.test(text)||naturalReportPeriod(text,now)&&/^(?:what about |how about |just |only |for |in |during )?(?:this |last |past |since |20\d{2}|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(text));
  if(!fresh&&!refine&&!regroup)return null;
  // Explicit subjects always belong to the existing governed subject handlers.
  if(!fresh&&/\b(?:campaigns?|klaviyo|customers?|conversion|products?|inventory|stock|countries|country|pendants?|rings?)\b/i.test(text))return null;
  const continuation=(retained&&!fresh)||regroup;
  const patch=continuation?{...base}:{};
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const yesterday=new Date(Date.parse(`${today}T00:00:00Z`)-86400000).toISOString().slice(0,10);
  // Promotion names are context, never implicit date-window instructions.
  const intent=promotionIntent(text);
  const promotion=intent?[intent]:null;
  const endpointAttempt=retained&&base.promotion_context?.pending_endpoint&&text.match(/\b(start|beginning|end) of (?:the |that )?(day|\d{1,2} [a-z]+(?: 20\d{2})?|[a-z]+ \d{1,2}(?: 20\d{2})?)\b/i);
  const endDate=base.promotion_context?.pending_endpoint_date;
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  const namedEnd=endDate?`${Number(endDate.slice(8))} ${months[Number(endDate.slice(5,7))-1]}`:null;
  const endpointReply=endpointAttempt&&(endpointAttempt[2].toLowerCase()==='day'||namedEnd&&[namedEnd,`${namedEnd} ${endDate.slice(0,4)}`].includes(endpointAttempt[2].toLowerCase()))?endpointAttempt:null;
  if(endpointReply)patch.promotion_context={...base.promotion_context,endpoint_choice:endpointReply[1].toLowerCase()==='end'?'end_of_day':'start_of_day',pending_endpoint:false,pending_dates:false};
  const dateText=promotion?text.replace(promotion[0],''):text;
  const supplied=text.match(/\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|–|—)\s*(20\d{2}-\d{2}-\d{2})\b/);
  const promotionReply=retained&&base.promotion_context&&supplied&&(base.promotion_context.pending_dates||/\b(?:sale|promotion)\b/i.test(text));
  let dates=promotionReply||endpointAttempt?null:naturalReportPeriod(dateText,now,{referenceYear:continuation?base.start_date?.slice(0,4):null});
  if(promotionReply)patch.promotion_context={...base.promotion_context,pending_dates:false,supplied_periods:[{start_date:supplied[1],end_date:supplied[2]}]};
  if(continuation&&!dates&&/^just\s+[a-z]+[.!]?$/i.test(text))dates=naturalReportPeriod(`${text.replace(/[.!]$/,'')} ${base.start_date?.slice(0,4)||today.slice(0,4)}`,now);
  if(dates&&dates.end_date>=today)dates={...dates,end_date:yesterday,current_day_included:false};
  Object.assign(patch,{requested_subject:'sales',analysis_type:'finance',metrics:['sales'],tool_route:'get_daily_sales_analysis',native_metrics:continuation&&base.native_metrics.length?base.native_metrics:['net_sales','orders'],dimensions:['weekday'],grain:'day',time_zone:'Europe/London',platform:'shopify',channel:continuation?base.channel:null,channel_breakdown:false,ranking_metric:continuation&&base.ranking_metric?base.ranking_metric:/\borders\b/i.test(text)&&!/\b(?:sales|revenue)\b/i.test(text)?'average_orders_per_day':'average_sales_per_day',ranking_direction:continuation?base.ranking_direction||'desc':'desc',...(dates||{}),date_cutoff:continuation&&!dates?base.date_cutoff:today,current_day_included:false});
  if(!dates&&continuation&&patch.end_date>=today)patch.end_date=yesterday;
  if(/\b(?:woocommerce|woo)\b/i.test(text))patch.platform='woo';
  if(/\bonline\b/i.test(text))patch.channel='online';
  if(/\b(?:pos|in[ -]?store)\b/i.test(text)&&!/\b(?:exclude|excluding|without)\s+(?:pos|in[ -]?store)\b/i.test(text))patch.channel=/\bonline\b/i.test(text)?null:'instore';
  if(promotion&&!promotionReply&&!/\b(?:include|add)\b[\s\S]{0,25}\b(?:sale|promotion)\b/i.test(text))patch.promotion_context={query:promotion[0].toLowerCase(),treatment:'compare_excluding'};
  if(/\binclude (?:the )?(?:sale|promotion) (?:again|too)\b/i.test(text)&&base.promotion_context)patch.promotion_context={...base.promotion_context,treatment:'include'};
  if(/\b(?:by|rank (?:by)?|sort (?:by)?)\s+orders\b/i.test(text))patch.ranking_metric='average_orders_per_day';
  if(/\b(?:by|rank (?:by)?|sort (?:by)?)\s+(?:sales|revenue)\b/i.test(text))patch.ranking_metric='average_sales_per_day';
  if(/\b(?:export|download|spreadsheet|xlsx)\b/i.test(text))patch.output_preference='xlsx';
  if(/\b(?:chart|graph)\b/i.test(text)&&!/\b(?:export|download|spreadsheet|xlsx)\b/i.test(text))patch.output_preference='chart';
  if(/\bby month\b/i.test(text))patch.dimensions=['month'];
  const unsupportedMetric=text.match(/\b(gross sales|total sales|refunds|discounts|profit)\b/i);
  if(unsupportedMetric)patch.native_metrics=[unsupportedMetric[1].toLowerCase().replaceAll(' ','_'),'orders'];
  if(!promotion&&!promotionReply&&/\b(?:exclude|excluding|without)\s+(?!pos\b|(?:the )?(?:sale|promotion)\b|(?:may )?bank holiday sale\b)([a-z]+)\b/i.test(text))patch.exclusions=[text.match(/\b(?:exclude|excluding|without)\s+([a-z]+)\b/i)[1].toLowerCase()];
  if(/\b(?:products?|category|categories|countries|country|pendants?|rings?|earrings?)\b/i.test(text))patch.filters=['additional_population_filter_unresolved'];
  if(/\b(?:least|lowest|ascending|asc)\b/i.test(text))patch.ranking_direction='asc';
  const currency=text.match(/\b(GBP|USD|JPY|EUR)\b/i);if(currency)patch.currencies=[currency[1].toUpperCase()];
  patch.unresolved_required_fields=[...(!patch.start_date||!patch.end_date?['start_date','end_date']:[]),...(!patch.channel?['channel']:[])];
  return {patch,continuation};
}
