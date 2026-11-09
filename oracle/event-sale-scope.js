import {explicitSalePeriods,explicitPhasedSale,isPhasedSale,validatePhasedSale,validateSalePeriods} from './explicit-sale-periods.js';
import {explicitShopifySaleScope,validateShopifySaleWindow} from './sale-window-scope.js';
import {messageIntent} from './message-intent.js';
export function validateEventSaleScope(v){
 if(v==null)return null;
 if(!v||Object.keys(v).some(k=>!['years','channels','products','source_policy','endpoint_choice','unsupported_fields','unsupported_sources','shopify_window','periods','sessions'].includes(k))||!Array.isArray(v.years)||!v.years.length||v.years.length>5||v.years.some(y=>!Number.isInteger(y)||y<2000||y>2100)||!Array.isArray(v.channels)||!v.channels.length||v.channels.some(c=>!['online','instore',...(['shopify-native-sale-v1','explicit-sale-periods-v1'].includes(v.source_policy)?['unknown']:[])].includes(c))||typeof v.products!=='boolean')throw Object.assign(Error('Invalid event sale scope'),{code:'INVALID_ANALYSIS_CONTEXT'});
 if(v.source_policy!=null&&!['bf-2024-2025-v1','shopify-native-sale-v1','explicit-sale-periods-v1'].includes(v.source_policy)||v.endpoint_choice!=null&&!['start_of_day','end_of_day'].includes(v.endpoint_choice))throw Object.assign(Error('Invalid event source or endpoint selection'),{code:'INVALID_ANALYSIS_CONTEXT'});
 if(v.source_policy==='shopify-native-sale-v1')validateShopifySaleWindow(v.shopify_window);else if(v.shopify_window!=null)throw Object.assign(Error('Unbound sale window'),{code:'INVALID_ANALYSIS_CONTEXT'});
 if(v.source_policy==='explicit-sale-periods-v1'){
  const periods=validateSalePeriods(v.periods);
  const phased=isPhasedSale(periods);
  if(phased)validatePhasedSale(periods);
  if(v.sessions!=null&&(!phased||v.sessions!==true))throw Object.assign(Error('Unbound session metrics'),{code:'INVALID_ANALYSIS_CONTEXT'});
  if(v.products!==phased||JSON.stringify([...new Set(periods.map(p=>Number(p.start_date.slice(0,4))))].sort())!==JSON.stringify([...v.years].sort())||JSON.stringify([...new Set(periods.flatMap(p=>p.channels))].sort())!==JSON.stringify([...v.channels].sort()))throw Object.assign(Error('Unbound period populations'),{code:'INVALID_ANALYSIS_CONTEXT'});
 }else if(v.periods!=null||v.sessions!=null)throw Object.assign(Error('Unbound explicit periods'),{code:'INVALID_ANALYSIS_CONTEXT'});
 const fields=['geography','currency','product_population','behavioural_metrics'];
 if(v.unsupported_fields!=null&&(!Array.isArray(v.unsupported_fields)||v.unsupported_fields.some(f=>!fields.includes(f))))throw Object.assign(Error('Invalid event capability fields'),{code:'INVALID_ANALYSIS_CONTEXT'});
 if(v.unsupported_sources!=null&&(!Array.isArray(v.unsupported_sources)||v.unsupported_sources.length>10||v.unsupported_sources.some(s=>!s||Object.keys(s).some(k=>!['year','channel','source'].includes(k))||!v.years.includes(s.year)||!['online','instore'].includes(s.channel)||!['shopify','woo','square'].includes(s.source))))throw Object.assign(Error('Invalid event source request'),{code:'INVALID_ANALYSIS_CONTEXT'});
 return {...(v.sessions?{sessions:true}:{}),...(v.periods?{periods:validateSalePeriods(v.periods)}:{}),...(v.shopify_window?{shopify_window:validateShopifySaleWindow(v.shopify_window)}:{}),...(v.unsupported_fields?.length?{unsupported_fields:[...new Set(v.unsupported_fields)]}:{}),...(v.unsupported_sources?.length?{unsupported_sources:v.unsupported_sources.map(s=>({...s}))}:{}),...(v.source_policy?{source_policy:v.source_policy}:{}),...(v.endpoint_choice?{endpoint_choice:v.endpoint_choice}:{}),years:[...new Set(v.years)].sort((a,b)=>b-a),channels:[...new Set(v.channels)].sort(),products:v.products};
}
export function eventSaleScopePatch(message,base,now){
 const intent=messageIntent(message),t=intent.instruction;
 if(intent.blocked||/\b(?:exclude|excluding|except|outside|not)\s+(?:a\s+|the\s+)?black\s+friday\b|context only|as context/i.test(t))return null;
 const periods=explicitPhasedSale(t)||explicitSalePeriods(t);
 if(periods)return validateEventSaleScope({source_policy:'explicit-sale-periods-v1',periods,years:[...new Set(periods.map(p=>Number(p.start_date.slice(0,4))))],channels:[...new Set(periods.flatMap(p=>p.channels))],products:isPhasedSale(periods),...(isPhasedSale(periods)&&/\b(?:sessions?|conversion)\b/i.test(t)?{sessions:true}:{})});
 const explicit=explicitShopifySaleScope(t,base);if(explicit)return validateEventSaleScope(explicit);
 const top=base?.event_scope?.shopify_window&&t.match(/^(?:please\s+)?(?:(?:show|list)\s+)?(?:the\s+)?top\s+(\d{1,3})\s+products?(?:\s+per\s+(?:channel|currency)|[.!\s])*$/i);
 if(top)return validateEventSaleScope({...base.event_scope,shopify_window:{...base.event_scope.shopify_window,product_limit:Number(top[1])},products:true});
 const named=/\bblack\s+friday\b/i.test(t);
 const business=/\b(?:sales|revenue|products?\s+sold|sale\s+(?:windows?|periods?|sessions?))\b/i.test(t);
 const behavioural=/\b(?:conversion|traffic|visitors?|website\s+sessions?|visitor\s+sessions?|sessions?\s+(?:counts?|rates?))\b/i.test(t);
 // Sale sessions and visitor sessions have different grains. A business report
 // may retain an unsupported behavioural add-on without losing its event scope.
 if((behavioural&&!business)||/\b(?:customers?|search console|klaviyo|retention|inventory|stock)\b/i.test(t))return null;
 const continuation=base?.event_scope&&!base.event_scope.shopify_window&&/\b(?:last year|year before|20\d{2}|products?|units|refunds|online|in[ -]?store|breakdown|break down|midnight|end of|start of)\b/i.test(t);
 if(!named&&!continuation)return null;
 const unsupported_fields=[...(!named?base?.event_scope?.unsupported_fields||[]:[]),...(behavioural?['behavioural_metrics']:[]),...(/\b(?:UK|US|USA|Japan|shipping|destination)\b/i.test(t)?['geography']:[]),...(/\b(?:GBP|USD|JPY|EUR)\b/i.test(t)?['currency']:[]),...(/\b(?:rings?|pendants?)\b/i.test(t)?['product_population']:[])];
 // Keep the established latest-completed campaign discovery for legacy requests.
 if(named&&!/\b(?:20\d{2}|last year(?:s|'s|’s)?|year before|products?|in[ -]?store|POS)\b/i.test(t))return null;
 const currentYear=Number(new Intl.DateTimeFormat('en',{timeZone:'Europe/London',year:'numeric'}).format(new Date(now)));
 let years=[...t.matchAll(/\b(20\d{2})\b/g)].map(m=>Number(m[1]));
 if(!years.length&&/\blast year(?:s|'s|’s)?\b/i.test(t))years=/\byear before\b/i.test(t)?[currentYear-1,currentYear-2]:[currentYear-1];
 const count=t.match(/\b(?:last|latest)\s+(\d{1,2})\b/i);
 if(!years.length&&count)years=Array.from({length:Math.max(1,Math.min(5,Number(count[1])))},(_,i)=>currentYear-1-i);
 if(!years.length&&/\byear before\b/i.test(t)&&base?.event_scope)years=[...base.event_scope.years,Math.min(...base.event_scope.years)-1];
 if(!years.length)years=base?.event_scope?.years||[currentYear-1];
 const online=/\bonline\b/i.test(t),store=/\bin[ -]?store\b|\bPOS\b/i.test(t);
 const channels=online||store?[...(online?['online']:[]),...(store?['instore']:[])]:base?.event_scope?.channels||['online'];
 const endpoint_choice=base?.event_scope&&/\bend of (?:november|10|the 10)|11 november.*00:00/i.test(t)?'end_of_day':base?.event_scope&&/\bstart of (?:november|10|the 10)/i.test(t)?'start_of_day':base?.event_scope?.endpoint_choice;
 const requestedSources=[];
 const sourceName=s=>/^shopify$/i.test(s)?'shopify':/^square$/i.test(s)?'square':'woo';
 for(const clause of t.split(/[.;\n]/)){
  const sourceClause=clause.replace(/\b(online|POS|in[ -]?store)\s+(Shopify|WooCommerce|Square)\b/gi,'$2 $1');
  const ys=[...sourceClause.matchAll(/\b(20\d{2})\b/g)];
  for(const m of sourceClause.matchAll(/\b(Shopify|WooCommerce|Square)\s+(online(?:\s+store)?|POS|in[ -]?store)\b/gi)){
   const after=sourceClause.slice(m.index+m[0].length).match(/^\s+(?:in|for)\s+(20\d{2})\b/);
   const prior=ys.filter(y=>y.index<m.index).at(-1);
   const selected=after?[Number(after[1])]:prior?[Number(prior[1])]:ys.length===1?[Number(ys[0][1])]:years;
   for(const year of selected)requestedSources.push({year,channel:/^online/i.test(m[2])?'online':'instore',source:sourceName(m[1])});
  }
  const only=clause.match(/\b(Shopify|WooCommerce|Square)\s+only\b|\bonly\s+(Shopify|WooCommerce|Square)\b/i);
  if(only)for(const year of years)for(const channel of channels)requestedSources.push({year,channel,source:sourceName(only[1]||only[2])});
 }
 const unsupported_sources=[...(!named&&!requestedSources.length?base?.event_scope?.unsupported_sources||[]:[]),...requestedSources].filter(s=>years.includes(s.year)&&channels.includes(s.channel)&&s.source!==(s.channel==='instore'?'square':s.year===2025?'shopify':s.year===2024?'woo':s.source));
 return validateEventSaleScope({...(unsupported_fields.length?{unsupported_fields}:{}),...(unsupported_sources.length?{unsupported_sources:[...new Map(unsupported_sources.map(s=>[JSON.stringify(s),s])).values()]}:{}),...(years.every(y=>[2024,2025].includes(y))?{source_policy:'bf-2024-2025-v1'}:{}),...(endpoint_choice?{endpoint_choice}:{}),years,channels,products:/\bproducts?|units\b/i.test(t)||Boolean(base?.event_scope?.products)});
}
