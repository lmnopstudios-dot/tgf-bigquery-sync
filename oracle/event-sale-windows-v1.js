// Frozen resolver for validating already-retained #414 evidence. Never executes providers.
import {resolveHistoricalEvents} from './historical-event-comparison.js';
import {storedTemporal,provenanceCode} from './event-presentation.js';
import {stableAnalyticalJSON} from './analytical-plan.js';
const code=e=>/^[A-Z0-9_]{1,70}$/.test(String(e?.code))?e.code:'EVENT_SECTION_FAILED';
const channel=r=>/^(?:online)$/i.test(r.channel)?'online':/^(?:pos|in[- ]?store|retail)$/i.test(r.channel)?'instore':'unknown';
const num=v=>v==null||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const value=(n,c)=>num(n)==null?'Unavailable':`${c||''} ${Number(n).toLocaleString('en-GB',{maximumFractionDigits:2})}`.trim();
const esc=s=>String(s??'Unavailable').replaceAll('|','\\|').replace(/[\r\n]/g,' ');
const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
export function resolveLegacyEventSaleWindows(items,scope,asOf){
 const windows=[],issues=[];
 for(const year of scope.years)for(const ch of scope.channels){
  const candidates=items.filter(r=>r.kind==='event'&&r.status!=='cancelled'&&!r.superseded_by&&/black[ -]+friday/i.test(r.title+' '+(r.tags||[]).join(' '))&&Number(storedTemporal(r.effective_from??r.start_date)?.slice(0,4))===year);
  const physical=r=>/\b(?:soho|tgf east|physical|in[ -]?store|shop)\b/i.test(r.title+' '+(r.content||r.description||''));
  let events=[];
  if(ch==='online'){
   const resolved=resolveHistoricalEvents(candidates.filter(r=>!physical(r)),{asOf,count:1});events=resolved.events.filter(e=>e.year===year);
   issues.push(...resolved.conflicts.map(x=>({...x,channel:ch,type:'ambiguous'})));
  }else{
   const grouped=new Map();for(const r of candidates.filter(physical)){
    const location=r.location_name||(/\b(?:soho|tgf east)\b/i.exec(r.title)?.[0])||null;
    const key=location?.toLowerCase()||'all';const group=grouped.get(key)||[];group.push(r);grouped.set(key,group);
   }
   for(const rows of grouped.values()){
    const confirmed=rows.filter(r=>r.status==='confirmed');
    if(new Set(confirmed.map(r=>[storedTemporal(r.effective_from??r.start_date),storedTemporal(r.effective_to??r.end_date)].join('/'))).size>1){issues.push({type:'ambiguous',year,channel:ch,event_ids:confirmed.map(r=>r.id),reason:'Conflicting confirmed store-sale windows'});continue;}
    const r=confirmed[0];if(!r)continue;
    const start=storedTemporal(r.effective_from??r.start_date),end=storedTemporal(r.effective_to??r.end_date);
    if(!valid(start)||!valid(end)||start>end)continue;
    events.push({id:r.id,name:r.title,year,start_date:start,end_date:end,location_name:r.location_name||(/\b(?:soho|tgf east)\b/i.exec(r.title)?.[0])||null,phases:[{id:r.id,start_date:start,end_date:end,description:r.content||r.description,timezone:r.timezone,provenance:{status:r.status,source_reference:r.source_reference,source_type:r.source_type,recorded_at:storedTemporal(r.recorded_at)}}]});
   }
  }
  if(!events.length)issues.push({type:'unavailable',year,channel:ch,reason:'No unambiguous confirmed channel sale window was resolved'});
  for(const e of events){
   if(e.end_date>=asOf){issues.push({type:'unavailable',year,channel:ch,reason:'Sale period is not completed'});continue;}
   const entries=e.phases.map(p=>items.find(r=>r.id===p.id)).filter(Boolean),descriptions=entries.map(r=>r.content||r.description||'').join(' ');
   windows.push({...e,id:`${ch}:${e.id}`,channel:ch,timezone:entries.find(r=>r.timezone)?.timezone||'Europe/London',timezone_provenance:entries.some(r=>r.timezone)?'knowledge metadata':'report convention; knowledge DATE metadata has no IANA timezone',intraday:/\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*(?:am|pm)\b|\b(?:midnight|noon)\b/i.test(descriptions),knowledge_entries:entries});
  }
 }
 return {windows,issues};
}
