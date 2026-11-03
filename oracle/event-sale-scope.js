import {messageIntent} from './message-intent.js';
export function validateEventSaleScope(v){
 if(v==null)return null;
 if(!v||Object.keys(v).some(k=>!['years','channels','products','source_policy','endpoint_choice'].includes(k))||!Array.isArray(v.years)||!v.years.length||v.years.length>5||v.years.some(y=>!Number.isInteger(y)||y<2000||y>2100)||!Array.isArray(v.channels)||!v.channels.length||v.channels.some(c=>!['online','instore'].includes(c))||typeof v.products!=='boolean')throw Object.assign(Error('Invalid event sale scope'),{code:'INVALID_ANALYSIS_CONTEXT'});
 if(v.source_policy!=null&&v.source_policy!=='bf-2024-2025-v1'||v.endpoint_choice!=null&&!['start_of_day','end_of_day'].includes(v.endpoint_choice))throw Object.assign(Error('Invalid event source or endpoint selection'),{code:'INVALID_ANALYSIS_CONTEXT'});
 return {...(v.source_policy?{source_policy:v.source_policy}:{}),...(v.endpoint_choice?{endpoint_choice:v.endpoint_choice}:{}),years:[...new Set(v.years)].sort((a,b)=>b-a),channels:[...new Set(v.channels)].sort(),products:v.products};
}
export function eventSaleScopePatch(message,base,now){
 const intent=messageIntent(message),t=intent.instruction;
 if(intent.blocked||/\b(?:exclude|excluding|except|outside|not)\b[\s\S]{0,45}\b(?:sale|friday|promotion)\b|context only|as context/i.test(t))return null;
 if(/\b(?:customers?|conversion|sessions?|traffic|visitors?|search console|klaviyo|retention|inventory|stock)\b/i.test(t))return null;
 const sourceSlot=year=>{const matches=[...t.matchAll(/\b20\d{2}\b/g)],m=matches.find(m=>m[0]===String(year));if(!m)return '';const next=matches.find(x=>x.index>m.index);return t.slice(m.index,next?.index).split(/[\n.;]/)[0];};
 const sourceRecipe=/Shopify/i.test(sourceSlot(2025))&&!/WooCommerce/i.test(sourceSlot(2025))&&/WooCommerce/i.test(sourceSlot(2024))&&!/Shopify/i.test(sourceSlot(2024))&&/Square/i.test(t);
 if(!sourceRecipe&&/\b(?:UK|US|USA|Japan|shipping|destination|Shopify|WooCommerce|rings?|pendants?|GBP|USD|JPY|EUR)\b/i.test(t))return null;
 const named=/\bblack\s+friday\b/i.test(t);
 const continuation=base?.event_scope&&/\b(?:last year|year before|20\d{2}|products?|units|refunds|online|in[ -]?store|breakdown|break down|midnight|end of|start of)\b/i.test(t)&&!/\b(?:customers?|conversion|shipping|countries|stock|inventory|search console|klaviyo)\b/i.test(t);
 if(!named&&!continuation)return null;
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
 return validateEventSaleScope({...(years.every(y=>[2024,2025].includes(y))?{source_policy:'bf-2024-2025-v1'}:{}),...(endpoint_choice?{endpoint_choice}:{}),years,channels,products:/\bproducts?|units\b/i.test(t)||Boolean(base?.event_scope?.products)});
}
