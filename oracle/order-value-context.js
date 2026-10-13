import { validateNumericOperation } from './numeric-distribution.js';
import { requestedAnalyticalOperations } from './requested-operations.js';
import { dailySalesContextPatch } from './analytical-refinement.js';

export function orderValueContextPatch(base,text,now) {
  const requested=requestedAnalyticalOperations(text),retained=base.tool_route==='get_order_value_analysis';
  const follow=retained&&/^(?:try|show|export|download|just|only|exclude|excluding|include|for|in|use|retry|chart|graph|end of|start of|beginning of)\b/i.test(text);
  if(!requested&&!follow)return null;
  if(!requested&&/\b(?:campaign|conversion|inventory|stock|customers|product sales)\b/i.test(text))return null;
  // Reuse calendar/promotion refinement and pending clarification semantics.
  const dailyBase={...(retained?base:{native_metrics:[],dimensions:[],currencies:[],filters:[],exclusions:[],included_periods:[],unresolved_required_fields:[]}),requested_subject:'sales',tool_route:'get_daily_sales_analysis',native_metrics:['orders'],channel:'online'};
  const calendar=dailySalesContextPatch(dailyBase,text,now)?.patch||{};
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const previous=retained?base.numeric_operation:null;
  const trial=text.match(/\btry\s+£?\s*(\d+(?:\.\d+)?)/i);
  const policy=text.match(/(?:shipping|delivery)\s+(?:costs?|charge(?:s)?(?: is)?)\s*£\s*(\d+(?:\.\d+)?)\s+below\s*£\s*(\d+(?:\.\d+)?)/i);
  const baseline=text.match(/(?:current|existing|baseline)[^.;]{0,60}threshold\s*£\s*(\d+(?:\.\d+)?)/i);
  const scenarioText=text.match(/\b(?:compare|try|threshold scenarios?)\b([\s\S]{0,200})/i)?.[1]||'';
  const scenarioValues=[...new Set([...scenarioText.matchAll(/£\s*(\d+(?:\.\d+)?)/g)].map(m=>Number(m[1])))];
  const operation=validateNumericOperation({...previous,...(policy?{assumed_charge:Number(policy[1]),baseline:Number(policy[2])}:baseline?{baseline:Number(baseline[1])}:{}),...(requested&&!previous?{enrich_products:requested.operations.includes('optional_product_enrichment')}:{}),...(trial?{thresholds:[Number(trial[1])]}:requested&&scenarioValues.length>1?{thresholds:[...new Set([Number(policy?.[2]||baseline?.[1]||previous?.baseline||250),...scenarioValues])]}:{}),...(/\b(?:observed|order) total\b/i.test(text)?{basis:'observed_total'}:/\bsubtotal\b/i.test(text)?{basis:'observed_subtotal'}:{})});
  const patch={...(retained?base:{}),...calendar,requested_subject:'order_values',metrics:['orders'],native_metrics:[],analysis_type:'finance',tool_route:'get_order_value_analysis',numeric_operation:operation,dimensions:['numeric_band'],grain:'day',platform:calendar.platform||'shopify',source_store:retained?base.source_store:null,channel:calendar.channel||'online',channel_breakdown:false,geography:requested?.population.shipping_destination||(retained?base.geography:null)||null,currencies:calendar.currencies?.length?calendar.currencies:requested?.population.currency?[requested.population.currency]:(retained?base.currencies:[])||[],time_zone:'Europe/London',ranking_metric:null,ranking_direction:null,start_date:calendar.start_date||(retained?base.start_date:`${today.slice(0,4)}-01-01`),end_date:calendar.end_date||(retained?base.end_date:yesterday),date_cutoff:today,current_day_included:false,promotion_context:calendar.promotion_context||(retained?base.promotion_context:null)||(requested?.promotion_query?{query:requested.promotion_query,treatment:'compare_excluding'}:null)};
  const currency=text.match(/\b(GBP|USD|EUR|JPY)\b/i);if(currency)patch.currencies=[currency[1].toUpperCase()];
  const direct=text.match(/\b(?:use|country|destination)\s+(GB|US|FR|DE|JP)\b/i);if(direct)patch.geography=direct[1].toUpperCase();
  if(requested?.charge_domain&&patch.geography==='GB'&&!patch.currencies.length)patch.currencies=['GBP'];
  if(patch.end_date>=today)patch.end_date=yesterday;
  patch.unresolved_required_fields=[...(!patch.geography?['geography']:[]),...(!patch.currencies.length?['currencies']:[])];
  return {patch,continuation:retained};
}
