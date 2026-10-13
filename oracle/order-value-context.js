import { naturalReportPeriod } from './report-natural-period.js';
import { validateNumericOperation } from './numeric-distribution.js';
import { requestedAnalyticalOperations } from './requested-operations.js';
import { dailySalesContextPatch } from './analytical-refinement.js';

export function orderValueContextPatch(base,text,now) {
  const requested=requestedAnalyticalOperations(text),retained=base.tool_route==='get_order_value_analysis';
  const clarificationReply=retained&&base.unresolved_required_fields?.length&&/\b(?:UK|United Kingdom|GB|US|FR|DE|JP|GBP|USD|EUR|JPY)\b/i.test(text);
  const follow=clarificationReply||retained&&/^(?:try|show|export|download|just|only|exclude|excluding|include|for|in|use|retry|chart|graph|end of|start of|beginning of)\b/i.test(text);
  if(!requested&&!follow)return null;
  if(!requested&&/\b(?:campaign|conversion|inventory|stock|customers|product sales)\b/i.test(text))return null;
  // Reuse calendar/promotion refinement and pending clarification semantics.
  const dailyBase={...(retained?base:{native_metrics:[],dimensions:[],currencies:[],filters:[],exclusions:[],included_periods:[],unresolved_required_fields:[]}),requested_subject:'sales',tool_route:'get_daily_sales_analysis',native_metrics:['orders'],channel:'online'};
  const calendar=dailySalesContextPatch(dailyBase,text,now)?.patch||{};
  const dates=naturalReportPeriod(text.replace(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:sale|promotion)\b/gi,''),now,{referenceYear:retained?base.start_date?.slice(0,4):null});
  if(dates)Object.assign(calendar,dates);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  const previous=retained?base.numeric_operation:null;
  const trial=text.match(/\btry\s+£?\s*(\d+(?:\.\d+)?)/i);
  // Parse monetary roles separately: band edges must never become thresholds.
  const bandClause=text.match(/(?:£\s*(\d+(?:\.\d+)?)\s+(?:order[ -]?value\s+)?bands?\s+from\s+£\s*(\d+(?:\.\d+)?)\s+to\s+£\s*(\d+(?:\.\d+)?))/i)
    ||text.match(/bands?\s+(?:of|in)\s+£\s*(\d+(?:\.\d+)?)\s+from\s+£\s*(\d+(?:\.\d+)?)\s+to\s+£\s*(\d+(?:\.\d+)?)/i);
  let edges;
  if(bandClause){
    const [step,start,end]=bandClause.slice(1).map(Number);
    if(step<=0||start>=end||Math.ceil((end-start)/step)>97)throw Error('Invalid numeric band range');
    edges=[0,...Array.from({length:Math.ceil((end-start)/step)},(_,i)=>start+i*step),end];
    edges=[...new Set(edges)];
  }
  const scenarioInput=bandClause?text.replace(bandClause[0],''):text;
  const policy=scenarioInput.match(/(?:shipping|delivery)\s+(?:costs?|charge(?:s)?(?: is)?)\s*£\s*(\d+(?:\.\d+)?)\s+below\s*£\s*(\d+(?:\.\d+)?)/i)
    ||scenarioInput.match(/(?:currently|current(?:ly)?\s+(?:shipping|delivery)(?:\s+charge)?(?:\s+is)?)\s*£\s*(\d+(?:\.\d+)?)\s+below\s*£\s*(\d+(?:\.\d+)?)/i);
  const baseline=scenarioInput.match(/\bthreshold\s*£\s*(\d+(?:\.\d+)?)/i)
    ||scenarioInput.match(/(?:free[ -]?(?:shipping|delivery)|(?:shipping|delivery)\s+(?:threshold|minimum))\s+(?:at\s+)?£\s*(\d+(?:\.\d+)?)/i)
    ||scenarioInput.match(/£\s*(\d+(?:\.\d+)?)\s+(?:free[ -]?)?(?:shipping|delivery)\s+threshold/i);
  const scenarioText=scenarioInput.match(/\b(?:compare(?:d)?(?:\s+(?:with|to))?|versus|vs|try|threshold scenarios?|from(?=\s*£))\b([^.;\n]{0,300})/i)?.[1]?.split(/\b(?:assuming|under|with unchanged|show|recorded|hypothetical|illustrative)\b/i)[0]||'';
  const fee=scenarioInput.match(/\b(?:hypothetical|assumed|assume|assuming|illustrative)[^.;£]{0,40}£\s*(\d+(?:\.\d+)?)/i)||scenarioInput.match(/(?:shipping|delivery)\s*£\s*(\d+(?:\.\d+)?)\s+below/i);
  const scenarioValues=[...new Set([...scenarioText.matchAll(/£\s*(\d+(?:\.\d+)?)/g)].map(m=>Number(m[1])))];
  const baseValue=Number(policy?.[2]||baseline?.[1]||previous?.baseline||scenarioValues[0]||250);
  const operation=validateNumericOperation({...previous,...(edges?{edges}:{}),...(policy?{assumed_charge:Number(policy[1]),baseline:baseValue}:baseline?{baseline:baseValue}:{}),...(requested?{enrich_products:requested.operations.includes('optional_product_enrichment')||Boolean(previous?.enrich_products)}:{}),...(!previous&&!policy&&!baseline&&scenarioValues.length>1?{baseline:baseValue}:{}),...(fee?{assumed_charge:Number(fee[1])}:{}),...(trial?{thresholds:[Number(trial[1])]}:requested&&scenarioValues.length?{thresholds:[...new Set([baseValue,...scenarioValues])]}:{}),...(/\b(?:observed|order) total\b/i.test(text)?{basis:'observed_total'}:/\bsubtotal\b/i.test(text)?{basis:'observed_subtotal'}:{})});
  const patch={...(retained?base:{}),...calendar,requested_subject:'order_values',metrics:['orders'],native_metrics:[],analysis_type:'finance',tool_route:'get_order_value_analysis',numeric_operation:operation,requested_operations:requested?.operations||(retained?base.requested_operations:[])||[],dimensions:['numeric_band'],grain:'day',platform:retained?base.platform:calendar.platform||'shopify',source_store:retained?base.source_store:null,channel:retained?base.channel:calendar.channel||'online',channel_breakdown:retained?base.channel_breakdown:false,geography:requested?.population.shipping_destination||(retained?base.geography:null)||null,currencies:calendar.currencies?.length?calendar.currencies:requested?.population.currency?[requested.population.currency]:(retained?base.currencies:[])||[],time_zone:'Europe/London',ranking_metric:null,ranking_direction:null,start_date:calendar.start_date||(retained?base.start_date:`${today.slice(0,4)}-01-01`),end_date:calendar.end_date||(retained?base.end_date:yesterday),date_cutoff:today,current_day_included:false,promotion_context:calendar.promotion_context||(retained?base.promotion_context:null)||(requested?.promotion_query?{query:requested.promotion_query,treatment:'compare_excluding'}:null)};
  // Population qualifiers are independent of whether the calendar refinement recognizes the prose.
  if(/\bonline\b/i.test(text)){patch.channel='online';patch.channel_breakdown=false;}
  if(/\bshopify\b/i.test(text)&&!/\b(?:woocommerce|woo)\b/i.test(text))patch.platform='shopify';
  if(/\b(?:woocommerce|woo)\b/i.test(text))patch.platform=/\bshopify\b/i.test(text)?'all':'woo';
  if(/\b(?:all|both|across)\s+(?:platforms?|stores?|sources?)\b/i.test(text))patch.platform='all';
  if(/\b(?:pos|in[ -]?store)\b/i.test(text)&&!/\b(?:exclude|excluding|without)\s+(?:pos|in[ -]?store)\b/i.test(text)){patch.channel=/\bonline\b/i.test(text)?null:'instore';patch.channel_breakdown=patch.channel===null;}
  if(/\bsquare\b/i.test(text))patch.platform=/\b(?:shopify|woocommerce|woo)\b/i.test(text)?'all':'square';
  const sourceRequest=text.replace(/\b(?:do not|don't|never|without|not)\s+(?:combine|combined|pool|pooled|merge)\b[^.;\n]*/gi,'');
  if(/\b(?:combine|combined|pool|pooled|merge)\b[^.;\n]{0,120}\b(?:platforms?|stores?|sources?|shopify|woocommerce|woo|square)\b/i.test(sourceRequest))patch.filters=[...new Set([...(patch.filters||[]),'combined_source_population'])];
  const currency=text.match(/\b(GBP|USD|EUR|JPY)\b/i);if(currency)patch.currencies=[currency[1].toUpperCase()];
  if(/\b(?:UK|United Kingdom)\b/i.test(text))patch.geography='GB';
  const direct=text.match(/\b(?:use|country|destination)\s+(GB|US|FR|DE|JP)\b/i)||text.match(/\b(GB|US|FR|DE|JP)\s+(?:GBP|USD|EUR|JPY)\b/i);if(direct)patch.geography=direct[1].toUpperCase();
  if(requested?.charge_domain&&patch.geography==='GB'&&!patch.currencies.length)patch.currencies=['GBP'];
  if(patch.end_date>=today)patch.end_date=yesterday;
  patch.unresolved_required_fields=[...(!patch.geography?['geography']:[]),...(!patch.currencies.length?['currencies']:[])];
  return {patch,continuation:retained};
}
