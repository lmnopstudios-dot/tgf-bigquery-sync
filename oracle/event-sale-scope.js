import {messageIntent} from './message-intent.js';
export function validateEventSaleScope(v){
 if(v==null)return null;
 if(!v||Object.keys(v).some(k=>!['years','channels','products'].includes(k))||!Array.isArray(v.years)||!v.years.length||v.years.length>5||v.years.some(y=>!Number.isInteger(y)||y<2000||y>2100)||!Array.isArray(v.channels)||!v.channels.length||v.channels.some(c=>!['online','instore'].includes(c))||typeof v.products!=='boolean')throw Object.assign(Error('Invalid event sale scope'),{code:'INVALID_ANALYSIS_CONTEXT'});
 return {years:[...new Set(v.years)].sort((a,b)=>b-a),channels:[...new Set(v.channels)].sort(),products:v.products};
}
export function eventSaleScopePatch(message,base,now){
 const intent=messageIntent(message),t=intent.instruction;
 if(intent.blocked||/\b(?:exclude|excluding|except|outside|not)\b[\s\S]{0,45}\b(?:sale|friday|promotion)\b|context only|as context/i.test(t))return null;
 if(/\b(?:customers?|conversion|sessions?|traffic|visitors?|search console|klaviyo|retention|inventory|stock)\b/i.test(t))return null;
 if(/\b(?:UK|US|USA|Japan|shipping|destination|Shopify|WooCommerce|rings?|pendants?|GBP|USD|JPY|EUR)\b/i.test(t))return null;
 const named=/\bblack\s+friday\b/i.test(t);
 const continuation=base?.event_scope&&/\b(?:last year|year before|20\d{2}|products?|units|refunds|online|in[ -]?store|breakdown|break down)\b/i.test(t)&&!/\b(?:customers?|conversion|shipping|countries|stock|inventory|search console|klaviyo)\b/i.test(t);
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
 return validateEventSaleScope({years,channels,products:/\bproducts?|units\b/i.test(t)||Boolean(base?.event_scope?.products)});
}
