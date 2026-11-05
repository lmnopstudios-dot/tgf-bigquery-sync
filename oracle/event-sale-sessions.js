import {resolveExplicitSalePeriods} from './explicit-sale-periods.js';
import {resolveShopifySaleWindows} from './shopify-sale-windows.js';
import {storedTemporal} from './event-presentation.js';
const day=value=>storedTemporal(value)?.slice(0,10);
const nextDay=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const clock=(h,m,ap)=>{let hour=Number(h);if(ap){if(hour<1||hour>12)return null;hour=hour%12+(ap.toLowerCase()==='pm'?12:0);}if(hour>23||Number(m||0)>59)return null;return `${String(hour).padStart(2,'0')}:${String(m||0).padStart(2,'0')}:00`;};
export const sessionStore=r=>r.location_name||r.store||(/\b(?:TGF\s+)?(?:Kings Cross|Shoreditch|Soho|East)\b/i.exec(r.title+' '+(r.content||r.description||''))?.[0]?.replace(/^TGF\s+/i,'').trim())||null;
export function sessionChannel(r){
 if(['online','instore'].includes(r.channel))return r.channel;
 const title=r.title||'',text=title+' '+(r.content||r.description||'')+' '+(r.tags||[]).join(' ');
 if(/\bonline\b/i.test(title)&&! /\bin[ -]?store\b/i.test(title))return 'online';
 if(sessionStore(r)||/\bin[ -]?store\b|\bphysical\b/i.test(title))return 'instore';
 if(/\bonline\b/i.test(text)&&! /\b(?:not|no|excluding)\s+(?:available\s+)?online\b/i.test(text))return 'online';
 return /\bin[ -]?store\b|\bphysical\b/i.test(text)?'instore':null;
}
/** Interpret only explicit clock bounds. Bare midnight is unresolved: the
 * knowledge DATE end alone does not establish start versus end of that day. */
export function sessionBounds(r,{endpointChoice=null}={}){
 const text=r.content||r.description||'',start=day(r.effective_from??r.start_date),end=day(r.effective_to??r.end_date)||start;
 const base={start_date:start,end_date:end,timezone:r.timezone||'Europe/London',timezone_provenance:r.timezone?'knowledge metadata':/\bGMT\b/i.test(text)?'knowledge narrative GMT; November London UTC+00:00':'Europe/London reporting convention; source timezone unrecorded'};
 if(r.start_at&&r.end_exclusive){const a=Date.parse(r.start_at),b=Date.parse(r.end_exclusive);if(Number.isFinite(a)&&b>a&&/Z$|[+-]\d{2}:\d{2}$/.test(r.start_at)&&/Z$|[+-]\d{2}:\d{2}$/.test(r.end_exclusive))return {...base,start_at:new Date(a).toISOString(),end_exclusive:new Date(b).toISOString(),intraday:true,time_precision:'clock',time_basis:'structured knowledge instants'};}
 const ranges=[...text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:[-–—]|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)];
 let from=r.start_time||null,to=r.end_time||null;
 if(ranges.length===1){const m=ranges[0];from=clock(m[1],m[2],m[3]||m[6]);to=clock(m[4],m[5],m[6]);if(!m[3]&&Number(m[1])===12&&m[6].toLowerCase()==='pm')from='12:00:00';}
 if(!from){const m=text.match(/\b(?:from|starts?|opens?|at)\s+(?:\d{1,2}\s+\w+\s+(?:20\d{2}\s+)?)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);if(m)from=clock(m[1],m[2],m[3]);}
 const midnight=/\bmidnight\b/i.test(text);
 if(midnight){
  const explicit=text.match(/\b(?:midnight\s+(?:GMT\s+|UTC\s+)?(?:at\s+)?(?:the\s+)?(start|beginning|end)\s+of|(?:start|beginning|end)\s+of[^.;\n]{0,45}\bmidnight\b)/i);
  if(!explicit&&!endpointChoice)return {...base,intraday:true,time_issue:'AMBIGUOUS_MIDNIGHT_ENDPOINT',endpoint_wording:text};
  const endOfDay=explicit?/\bend\b/i.test(explicit[0]):endpointChoice==='end_of_day';base.endpoint_provenance=explicit?'explicit source wording':'request-scoped user clarification; original source unchanged';to='00:00:00';base.endpoint_date=endOfDay?nextDay(end):end;
 }
 if(!from&&!to&&!/\b\d{1,2}:\d{2}\b|\d\s*(?:am|pm)\b/i.test(text))return {...base,intraday:false,time_precision:'date_only',start_at:`${start}T00:00:00Z`,end_exclusive:`${nextDay(end)}T00:00:00Z`,time_basis:'documented calendar dates only; sale hours unrecorded'};
 if(!from||!to)return {...base,intraday:true,time_issue:'MISSING_EXACT_CLOCK_BOUNDS'};
 from=from.length===5?from+':00':from;to=to.length===5?to+':00':to;
 // This binding supports explicit UTC/GMT or London winter instants. Other
 // offsets require a source timestamp instead of an inferred timezone.
 if(base.timezone!=='Europe/London'&&!['UTC','GMT'].includes(base.timezone)||/\bBST\b/i.test(text))return {...base,intraday:true,time_issue:'UNSUPPORTED_SOURCE_TIMEZONE'};
 const a=`${start}T${from}Z`,b=`${base.endpoint_date||end}T${to}Z`;
 const isWinter=d=>['11','12','01','02'].includes(d?.slice(5,7));
 if(!isWinter(start)||!isWinter(end)||!Number.isFinite(Date.parse(a))||Date.parse(b)<=Date.parse(a))return {...base,intraday:true,time_issue:'INVALID_OR_UNSUPPORTED_CLOCK_BOUNDS'};
 return {...base,start_at:a,end_exclusive:b,intraday:true,time_precision:'clock',time_basis:'explicit knowledge clock bounds; half-open [start,end)'};
}
export function resolveSaleSessions(items,scope,asOf){
 if(scope.periods)return resolveExplicitSalePeriods(scope,asOf);
 if(scope.source_policy==='shopify-native-sale-v1')return resolveShopifySaleWindows(items,scope,asOf);
 const windows=[],issues=[],groups=new Map();
 for(const r of items){
  const start=day(r.effective_from??r.start_date),year=Number(start?.slice(0,4));
  if(r.kind!=='event'||r.status!=='confirmed'||r.superseded_by||!scope.years.includes(year)||! /black[ -]+friday/i.test(r.title+' '+(r.tags||[]).join(' ')))continue;
  const channel=sessionChannel(r);if(!channel||!scope.channels.includes(channel))continue;
  const location=channel==='instore'?sessionStore(r):null,bounds=sessionBounds(r,{endpointChoice:scope.endpoint_choice});
  if(!bounds.start_date||!bounds.end_date||bounds.end_date>=asOf)continue;
  const session=r.session_id||r.session||(/\b(?:VIP|early access|public|morning|evening)\b/i.exec(r.title)?.[0]?.toLowerCase())||null;
  const selectedSource=scope.source_policy==='bf-2024-2025-v1'?(channel==='instore'?'square':year===2025?'shopify':year===2024?'woo':null):null;
  const w={source_selection:selectedSource,id:`${channel}:${r.id}`,name:r.title,year,channel,location_name:location,session,session_identity:r.session_id||r.session||null,...bounds,knowledge_entries:[r]};
  // An explicit session label may span different dates. Without one, distinct
  // dates/non-overlapping hours are independent sessions, not conflicting rows.
  const key=JSON.stringify([year,channel,location?.toLowerCase()||'unspecified',session||'unlabelled']);
  const rows=groups.get(key)||[];rows.push(w);groups.set(key,rows);
 }
 for(const rows of groups.values()){
  const conflicted=new Set();
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
   const a=rows[i],b=rows[j];if(a.channel==='instore'&&(!a.location_name||!b.location_name))continue;const same=a.start_at===b.start_at&&a.end_exclusive===b.end_exclusive&&a.start_date===b.start_date&&a.end_date===b.end_date;
   const overlap=a.start_at&&b.start_at?Date.parse(a.start_at)<Date.parse(b.end_exclusive)&&Date.parse(b.start_at)<Date.parse(a.end_exclusive):a.start_date<=b.end_date&&b.start_date<=a.end_date;
   if(!same&&(a.session_identity&&a.session_identity===b.session_identity||overlap)){conflicted.add(a.id);conflicted.add(b.id);}
  }
  if(conflicted.size)issues.push({type:'ambiguous',year:rows[0].year,channel:rows[0].channel,location_name:rows[0].location_name,session:rows[0].session,event_ids:rows.filter(w=>conflicted.has(w.id)).flatMap(w=>w.knowledge_entries.map(r=>r.id)),candidates:rows.filter(w=>conflicted.has(w.id)).map(w=>({id:w.knowledge_entries[0].id,title:w.name,store:w.location_name,session:w.session,start_date:w.start_date,end_date:w.end_date,start_at:w.start_at,end_exclusive:w.end_exclusive})),reason:'Conflicting confirmed windows for the same store/session'});
  const unique=new Map();for(const w of rows.filter(w=>!conflicted.has(w.id))){const k=JSON.stringify([w.channel==='instore'&&!w.location_name?w.id:null,w.start_at,w.end_exclusive,w.start_date,w.end_date,w.time_issue]);if(unique.has(k))unique.get(k).knowledge_entries.push(...w.knowledge_entries);else unique.set(k,w);}windows.push(...unique.values());
 }
 for(const year of scope.years)for(const channel of scope.channels)if(!windows.some(w=>w.year===year&&w.channel===channel))issues.push({type:'unavailable',year,channel,event_ids:items.filter(r=>Number(day(r.effective_from??r.start_date)?.slice(0,4))===year).map(r=>r.id),reason:channel==='instore'&&items.some(r=>Number(day(r.effective_from??r.start_date)?.slice(0,4))===year&&/physical stores did not participate/i.test(r.content||r.description||''))?'Confirmed records explicitly exclude physical-store participation; no in-store campaign window is established':channel==='online'?'No confirmed positively online event resolved; in-store IDs and calendar dates cannot supply an online window':'No confirmed store/session window resolved'});
 return {windows,issues};
}
