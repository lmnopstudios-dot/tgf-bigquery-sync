import { localDateAt } from './knowledge-dates.js';

const MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
const scalar=x=>x?.value??x;
const validDate=x=>/^\d{4}-\d{2}-\d{2}$/.test(x||'')&&Number.isFinite(Date.parse(`${x}T00:00:00Z`))&&new Date(`${x}T00:00:00Z`).toISOString().slice(0,10)===x;
const addDay=x=>new Date(Date.parse(`${x}T00:00:00Z`)+86400000).toISOString().slice(0,10);
const overlap=(a,p)=>a.effective_from<=p.end_date&&a.effective_to>=p.start_date;
const datesIn=p=>{const out=[];for(let d=p.start_date;validDate(d)&&d<=p.end_date;d=addDay(d))out.push(d);return out;};
const wording=e=>`${e.title||''} ${e.content??e.description??''} ${(e.tags||[]).join(' ')}`;
const canonical=s=>String(s).toLowerCase().replace(/early may/g,'may').replace(/bank[- ]holiday/g,'bank holiday').replace(/\b(?:promotions?|promos?|discounts?|offers?)\b/g,'sale').replace(/[^a-z0-9 ]/g,' ');
const words=s=>canonical(s).split(/\s+/).filter(w=>w&&!['the','a','an','sale','event','in','on','for','of','this','year','account','with','without'].includes(w));
export function promotionIntent(text) {
  // Keep the requested event's words, rather than a catalogue of sale titles.
  const named=String(text).match(/\b(?:account(?:ing)? for|tak(?:e|ing) into account|adjust(?:ed)? for|exclud(?:e|ing)|without|allow(?:ing)? for)\s+(?:the\s+)?([^.!?;]{1,120}?(?:sale|promotion|promo|offer|discount|bank holiday|black friday)(?:\s+event)?)(?=\b|[.!?;])/i);
  if(named)return named[1].trim();
  return String(text).match(/\b(?:(?:[a-z]+\s+){0,3})(?:bank holiday|black friday|summer|winter|spring|christmas)\s+(?:sale|promotion|offer)\b/i)?.[0]?.trim()||null;
}
export function onlinePromotion(e) {
  const text=wording(e),tags=(e.tags||[]).map(x=>String(x).toLowerCase());
  if(/\b(?:in[ -]?store|retail|pos)\s+only\b|\bnot (?:available )?online\b/i.test(text))return false;
  if(tags.some(t=>['online','ecommerce'].includes(t))||/\bonline\b/i.test(text))return true;
  return false; // Online applicability needs positive governed evidence.
}
function narrativeDates(text) {
  const out=[];
  const pattern=new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})\\s+(20\\d{2})\\b`,'gi');
  for(const m of text.matchAll(pattern)){
    const date=`${m[3]}-${String(MONTHS.indexOf(m[2].toLowerCase())+1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    if(validDate(date))out.push({date,index:m.index,end:m.index+m[0].length,quote:m[0]});
  }
  for(const m of text.matchAll(/\b20\d{2}-\d{2}-\d{2}\b/g))if(validDate(m[0]))out.push({date:m[0],index:m.index,end:m.index+m[0].length,quote:m[0]});
  return out.sort((a,b)=>a.index-b.index);
}
/** Read-only, bounded interpretation of explicit evidence. Never infer a year,
 * timezone or an ambiguous midnight endpoint. Preserve source bytes for replay. */
export function interpretPromotionEvent(raw,{endpoint=null,endpointZone=null,timeZone='Europe/London'}={}) {
  const e={...raw,content:raw.content??raw.description??'',effective_from:scalar(raw.effective_from),effective_to:scalar(raw.effective_to)};
  const text=e.content,mentions=narrativeDates(text),phases=[];
  let finish=null,previousEnd=0,conflictingEnd=false;
  for(const m of mentions){
    const clause=text.slice(Math.max(text.lastIndexOf('.',m.index-1)+1,previousEnd),m.index).trim();previousEnd=m.end;
    if(/\b(?:ended?|ends?|until|through)\b/i.test(clause)||/\bto\s*$/i.test(clause)){if(finish&&finish.date!==m.date)conflictingEnd=true;finish={...m,clause};}
    else if(/\b(?:VIP|early access|subscribers)\b/i.test(clause))phases.push({phase:'vip',start_date:m.date,evidence:clause+' '+m.quote});
    else if(/\b(?:opened?|opens?|began|starts?|public|everyone|from|launched?)\b/i.test(clause))phases.push({phase:'public',start_date:m.date,evidence:clause+' '+m.quote});
  }
  const starts=phases.map(p=>p.start_date).sort(),structured=validDate(e.effective_from)&&validDate(e.effective_to||(e.date_precision==='day'?e.effective_from:null))&&['day','range'].includes(e.date_precision);
  const interpretation={version:1,original_effective_from:e.effective_from??null,original_effective_to:e.effective_to??null,original_date_precision:e.date_precision??null,source_record_id:e.id,source_type:e.source_type,source_reference:e.source_reference,source_content:text,time_zone:timeZone,phases,online_applicable:onlinePromotion(e),offer_evidence:text.split(/(?<=[.!?])\s+/).filter(s=>/\b(?:off|excluding|discount)\b/i.test(s)),basis:structured?'structured_dates':'explicit_narrative_dates'};
  if(conflictingEnd){interpretation.status='conflict';return {...e,interpretation};}
  let start=structured?e.effective_from:starts[0],end=structured?(e.effective_to||e.effective_from):finish?.date;
  if(starts.length&&structured&&starts[0]<start)start=starts[0]; // documented VIP access precedes the public structured range
  if(finish&&/\bmidnight\b/i.test(finish.clause)){
    const sourceZone=finish.clause.match(/\b(GMT|UTC|BST)\b/i)?.[1]?.toUpperCase();
    const zone=endpointZone||sourceZone;
    if(endpointZone){interpretation.source_endpoint_zone=sourceZone||null;interpretation.user_endpoint_zone=endpointZone;}
    const explicitStart=/\b(?:start|beginning) of\b/i.test(finish.clause),explicitEnd=/\b(?:end) of\b/i.test(finish.clause);
    const choice=explicitStart?'start_of_day':explicitEnd?'end_of_day':endpoint;
    interpretation.endpoint_wording=finish.clause+' '+finish.quote;interpretation.endpoint_zone=zone||null;
    interpretation.endpoint_options=['start_of_day','end_of_day'];
    interpretation.established_start=start||null;interpretation.established_end_date=finish.date;
    if(!choice||!zone){
      interpretation.status='temporal_unresolved';
      interpretation.clarification=zone?`Did “midnight ${zone} on ${finish.quote}” mean the start of ${finish.quote}, or the end of that day? ${zone==='GMT'?`GMT is UTC+00:00; Europe/London is ${new Intl.DateTimeFormat('en-GB',{timeZone,timeZoneName:'short'}).formatToParts(new Date(finish.date+'T12:00:00Z')).find(p=>p.type==='timeZoneName').value} on ${finish.date}. `:''}VIP/public dates and unadjusted sales are retained.`:`What timezone and start/end-of-day meaning applies to “midnight on ${finish.quote}”?`;
      return {...e,effective_from:start||null,effective_to:null,interpretation};
    }
    const instant=`${choice==='end_of_day'?addDay(finish.date):finish.date}T00:00:00${zone==='BST'?'+01:00':'Z'}`;
    // Half-open endpoint: a UTC midnight during BST affects the next local date
    // for one hour. Exclude every local day touched, including that partial day.
    end=localDateAt(Date.parse(instant)-1,timeZone).toISOString().slice(0,10);
    interpretation.endpoint_choice=choice;interpretation.end_exclusive=new Date(instant).toISOString();
    interpretation.disclosure=`${interpretation.endpoint_wording}${endpointZone?' (request-scoped timezone '+endpointZone+'; stored wording unchanged)':''}: ${choice.replaceAll('_',' ')} (${interpretation.end_exclusive}); whole ${timeZone} days touched through ${end} are excluded.`;
  }else if(finish&&structured&&finish.date!==end){interpretation.status='conflict';return {...e,interpretation};}
  if(!validDate(start)||!validDate(end)||start>end){interpretation.status='temporal_unresolved';interpretation.clarification='What confirmed start and end dates apply to this promotion?';return {...e,interpretation};}
  interpretation.status='confirmed';
  return {...e,effective_from:start,effective_to:end,date_precision:start===end?'day':'range',interpretation};
}
export async function retrievePromotionContext(service,request,period) {
  if(!service)return null;
  // Event-only governed retrieval avoids topic tags excluding relevant records.
  // Matching below uses the requested event and narrative, with exact overlap.
  if(service.searchKnowledge)return service.searchKnowledge({knowledge_type:'event',status:'confirmed',start_date:period.start_date,end_date:period.end_date,tags:[],text_terms:words(request.query).slice(0,12),limit:50});
  return service.getBusinessContext({...period,topics:['online','sales','promotion','campaign']});
}
export function resolvePromotionDates(response,request,period) {
  if(!request||request.treatment==='include')return {status:'not_requested',events:[],dates:[]};
  const empty=status=>({status,events:[],dates:[]});
  if(!request.supplied_periods?.length&&(!response||response.limited||response.truncated||response.has_more||response.items?.length>=50))return empty('retrieval_failed');
  const queryWords=words(request.query);
  const confirmed=(response?.items||[]).filter(e=>e.kind==='event'&&e.status==='confirmed'&&e.id&&e.source_type&&e.source_reference&&onlinePromotion(e)&&/\b(?:sale|promotion|promo|offer|discount|campaign)\b/i.test(wording(e))&&queryWords.every(w=>words(wording(e)).includes(w)));
  const events=confirmed.map(e=>interpretPromotionEvent(e,{endpoint:request.endpoint_choice,endpointZone:request.endpoint_zone})).filter(e=>{
    if(e.interpretation.status==='confirmed')return overlap(e,period);
    const start=e.interpretation.established_start||e.effective_from;
    const end=e.interpretation.established_end_date||scalar(e.effective_to);
    return !(validDate(start)&&start>period.end_date||validDate(end)&&addDay(end)<period.start_date);
  });
  // Separate phase records may have different ranges. Competing records for the
  // same phase/title must agree, rather than silently unioning conflicting dates.
  const groups=new Map();let conflict=events.some(e=>e.interpretation.status==='conflict');
  for(const e of events){const key=/\b(?:vip|early access)\b/i.test(e.title)||e.interpretation.phases.length&&e.interpretation.phases.every(p=>p.phase==='vip')?'vip':'public',range=`${e.effective_from}/${e.effective_to}`;if(groups.has(key)&&groups.get(key)!==range)conflict=true;groups.set(key,range);}
  if(conflict&&!request.calendar_instruction)return {status:'conflict',events,dates:[]};
  if(request.supplied_periods?.length){
    const supplied=request.supplied_periods.map((p,i)=>({id:`user-supplied-${i}`,title:request.query,effective_from:p.start_date,effective_to:p.end_date,source_type:'human_entered',source_reference:request.calendar_instruction?'User-selected comparison calendar days':'User-supplied confirmed sale dates'}));
    return {status:'confirmed',events:supplied,source_events:request.calendar_instruction?events.map(e=>({...e,interpretation:Object.fromEntries(Object.entries(e.interpretation).filter(([k])=>k!=='clarification'))})):confirmed,...(request.calendar_instruction?{comparison_treatment:'user_selected_calendar_days',instruction:request.calendar_instruction,...(conflict?{knowledge_conflict:true}:{})}:{}),dates:datesIn(period).filter(d=>supplied.some(e=>d>=e.effective_from&&d<=e.effective_to))};
  }
  if(!events.length)return empty('no_matching_confirmed_record');
  if(events.some(e=>e.interpretation.status!=='confirmed'))return {status:'temporal_unresolved',events,dates:[],clarification:events.find(e=>e.interpretation.clarification)?.interpretation.clarification};
  return {status:'confirmed',events,dates:datesIn(period).filter(d=>events.some(e=>d>=e.effective_from&&d<=e.effective_to))};
}

export function promotionStatusMessage(p) {
  return ({confirmed:'Confirmed promotion dates were established.',retrieval_failed:'Governed promotion knowledge retrieval failed or was incomplete.',no_matching_confirmed_record:'No matching confirmed online promotion record overlaps this period.',temporal_unresolved:'A matching confirmed promotion was retrieved, but its temporal interpretation is unresolved.',conflict:'Matching confirmed promotion records conflict; no exclusion interval was selected.',not_requested:'Promotion exclusions were not requested.'})[p.status];
}
