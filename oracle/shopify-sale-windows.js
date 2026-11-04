import {saleInstant,nextSaleDay} from './sale-window-time.js';
const date=r=>String(r?.value||r||'').slice(0,10);
const ch=r=>r.channel==='pos'?'instore':['online','instore'].includes(r.channel)?r.channel:/\bonline\b/i.test(r.title)&&! /\bPOS\b/i.test(r.title)?'online':/\bPOS\b|in[ -]?store/i.test(r.title)?'instore':null;
const channels=r=>{const single=ch(r);if(single)return [single];const text=r.title+' '+(r.content||r.description||'');return [...(/\bonline\b/i.test(text)?['online']:[]),...(/\bin[ -]?stores?\b|\bPOS\b/i.test(text)&&!/online[ -]only|physical stores did not participate/i.test(text)?['instore']:[])];};
const clock=(h,m,ap)=>`${String(ap?Number(h)%12+(ap.toLowerCase()==='pm'?12:0):Number(h)).padStart(2,'0')}:${m||'00'}:00`;
export function resolveShopifySaleWindows(items,scope,asOf){
 const request=scope.shopify_window,start=request.start_date,end=request.end_date;
 const records=items.filter(r=>r.kind==='event'&&r.status==='confirmed'&&!r.superseded_by&&date(r.effective_from??r.start_date)<=end&&date(r.effective_to??r.end_date)>=start&&(/bank.?holiday/i.test(request.name)?/bank.?holiday/i.test(r.title+' '+(r.tags||[]).join(' ')):/sale/i.test(r.title)));
 const requested={id:'request:shopify-sale-window',kind:'request',status:'confirmed',title:request.name,content:'Explicit requested calendar dates; stored opening/closing hours are used only when unambiguous.',effective_from:start,effective_to:end,source_reference:'current user request',source_type:'user_request',recorded_at:asOf};
 const windows=[];
 for(const channel of scope.channels){
  const calendar={start_at:saleInstant(start),end_exclusive:saleInstant(nextSaleDay(end))};
  const sessions=[],limitations=[],seen=[];
  let issue=null;
  for(const r of records.filter(r=>channels(r).includes(channel))){
   const text=r.content||r.description||'',zone=r.timezone||(/\bGMT\b/i.test(text)?'GMT':'Europe/London');
   let a=r.start_at?.value||r.start_at,b=r.end_exclusive?.value||r.end_exclusive;
   if(!a||!b){
    let from=r.start_time,to=r.end_time;
    const range=text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\s*[-–—]\s*(\d{1,2}):(\d{2})\s*(am|pm)?\b/i)||text.match(/\b(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*[-–—]\s*(\d{1,2}):?(\d{2})?\s*(am|pm)\b/i);
    if(range){from=clock(range[1],range[2],range[3]||range[6]);to=clock(range[4],range[5],range[6]);}
    const narrative=verb=>text.match(new RegExp('\\b(?:'+verb+')\\s+(?:\\d{1,2}\\s+[a-z]+(?:\\s+20\\d{2})?\\s+)?(?:at\\s+)?(\\d{1,2})(?::(\\d{2})\\s*(am|pm)?|\\s*(am|pm))','i'));
    const begins=narrative('from|starts?|opens?'),ends=narrative('until|through|ends?|closes?');
    if(!from&&begins)from=clock(begins[1],begins[2],begins[3]||begins[4]);
    if(!to&&ends)to=clock(ends[1],ends[2],ends[3]||ends[4]);
    if(/\bGMT\b/i.test(text)&&/\bBST\b/i.test(text)&&from&&to)issue='SALE_SOURCE_TIMEZONE_AMBIGUOUS';
    if(from&&to&&/\b(?:daily|each day|every day)\b/i.test(text)){
     for(let d=[date(r.effective_from??r.start_date),start].sort().at(-1);d<=[date(r.effective_to??r.end_date),end].sort()[0];d=nextSaleDay(d)){
      if(d<start||d>end)continue;
      try{const sa=saleInstant(d,from,zone),sb=saleInstant(d,to,zone);if(sb<=sa)throw Error();sessions.push({start_at:sa,end_exclusive:sb,location_name:r.location_name||r.store||null,knowledge_id:r.id});}catch{issue='SALE_INVALID_CLOCK_BOUNDS';}
     }
     continue;
    }
    if(from&&to){try{a=saleInstant(date(r.effective_from??r.start_date),from,zone);b=saleInstant(date(r.effective_to??r.end_date),to,zone);}catch(e){issue=e.code;}}
    else if(from||to)issue='SALE_EXACT_CLOCK_BOUNDS_INCOMPLETE';
   }
   if(a&&b){
    if(!/Z$|[+-]\d{2}:\d{2}$/.test(a)||!/Z$|[+-]\d{2}:\d{2}$/.test(b)||!Number.isFinite(Date.parse(a))||!Number.isFinite(Date.parse(b))||Date.parse(b)<=Date.parse(a)){issue='SALE_INVALID_CLOCK_BOUNDS';continue;}
    a=new Date(Math.max(Date.parse(a),Date.parse(calendar.start_at))).toISOString().replace('.000Z','Z');b=new Date(Math.min(Date.parse(b),Date.parse(calendar.end_exclusive))).toISOString().replace('.000Z','Z');
    if(b<=a)continue;
    const location_name=r.location_name||r.store||null;
    if(seen.some(s=>s.location_name===location_name&&(s.start_at!==a||s.end_exclusive!==b)&&s.start_at<b&&a<s.end_exclusive))issue='SALE_KNOWLEDGE_WINDOWS_CONFLICT';
    const session={start_at:a,end_exclusive:b,location_name,knowledge_id:r.id};seen.push(session);sessions.push(session);
   }else limitations.push(`Record ${r.id}: exact opening and closing instants are not both recorded; the explicit requested calendar range is retained.`);
  }
  if(records.some(r=>/midnight/i.test(r.content||r.description||'')&&!r.end_exclusive&&!r.end_time))limitations.push('Stored midnight wording is ambiguous and does not establish exact channel hours. The requested inclusive Europe/London dates govern this section; no GMT midnight interpretation was guessed.');
  const ordered=[...sessions].sort((a,b)=>a.start_at.localeCompare(b.start_at));for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length&&ordered[j].start_at<ordered[i].end_exclusive;j++){const a=ordered[i],b=ordered[j];if(a.location_name===b.location_name&&(a.start_at!==b.start_at||a.end_exclusive!==b.end_exclusive))issue='SALE_KNOWLEDGE_WINDOWS_CONFLICT';}
  if(channel==='instore'&&sessions.some(s=>s.location_name)&&sessions.some(s=>!s.location_name))issue='SALE_POS_SESSION_POPULATION_AMBIGUOUS';
  const bounds=sessions.length?{start_at:sessions.map(s=>s.start_at).sort()[0],end_exclusive:sessions.map(s=>s.end_exclusive).sort().at(-1)}:calendar;
  windows.push({id:`shopify-sale:${start}:${end}:${channel}`,name:request.name,year:Number(start.slice(0,4)),channel,location_name:null,source_selection:'shopify',shopify_channel:channel,start_date:start,end_date:end,timezone:request.timezone,timezone_provenance:'explicit user request; IANA Europe/London including daylight saving',...bounds,time_precision:sessions.length?'clock':'requested_calendar',intraday:Boolean(sessions.length),time_basis:sessions.length?'documented channel-specific sessions intersected with requested calendar range':'explicit inclusive calendar dates; local midnight boundaries, not a guessed GMT cutoff',...(sessions.length?{sale_sessions:sessions}:{}),...(issue?{time_issue:issue}:{}),knowledge_entries:records.length?records:[requested],limitations,product_limit:request.product_limit,pos_population:request.pos_population});
 }
 return {windows,issues:[],requested_calendar:{start_date:start,end_date:end,timezone:request.timezone}};
}
