// Shared, dependency-free intent and calendar contract for browser and server.
export const kpiIntent=text=>/\b(?:kpi|key performance indicators?)\s+(?:tracking\s+)?(?:dashboard|report|tracking)\b/i.test(String(text||''));
const fail=()=>{throw Object.assign(Error('Invalid KPI scope'),{code:'KPI_INVALID_SCOPE'});};
export const dayAdd=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export const londonDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function validDay(d){return /^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;}
export function monthAdd(d,n){const [y,m,a]=d.split('-').map(Number),first=new Date(Date.UTC(y,m-1+n,1)),last=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();return `${first.toISOString().slice(0,7)}-${String(Math.min(a,last)).padStart(2,'0')}`;}
export function validateKpiScope(s){if(!s||!['combined','online','instore','unknown'].includes(s.channel)||!['all','uk','international','unknown'].includes(s.geography)||s.currency!==null&&!/^[A-Z]{3}$/.test(s.currency))fail();return {channel:s.channel,geography:s.geography,currency:s.currency};}
export function kpiRequest(text,now=Date.now()){
 if(!kpiIntent(text))return null;
 const today=londonDay(now),month=today.slice(0,7)+'-01';let start=monthAdd(month,-1),end=dayAdd(month,-1);
 const dates=String(text).match(/\b\d{4}-\d{2}-\d{2}\b/g)||[];
 const named=String(text).match(/\bfor\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
 if(dates.length){if(dates.length!==2)fail();[start,end]=dates;}
 else if(named){const m=['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(named[1].toLowerCase())+1;start=`${named[2]}-${String(m).padStart(2,'0')}-01`;end=dayAdd(monthAdd(start,1),-1);}
 else if(/\b(?:for|from|through|since|today|yesterday|last|past|this)\b/i.test(String(text).replace(/\b(?:online|UK|international|GBP|USD|POS)\b/gi,'')))fail();
 if(!validDay(start)||!validDay(end)||start>end||end>=today||(Date.parse(end)-Date.parse(start))/86400000>1095)fail();
 if(new Set(String(text).match(/\b(?:GBP|USD|EUR|JPY)\b/g)||[]).size>1||/\b(?:exclude|excluding|campaign|products?|category|only customers)\b/i.test(text))fail();
 const scope=validateKpiScope({channel:/\bonline\b/i.test(text)&&/\bPOS\b|\bin[ -]?store\b/i.test(text)?'combined':/\bunknown channel\b|\bchannel unknown\b/i.test(text)?'unknown':/\bPOS\b|\bin[ -]?store\b/i.test(text)?'instore':/\bonline only\b|\bchannel online\b/i.test(text)?'online':'combined',geography:/\binternational\b/i.test(text)?'international':/\bUK\b/i.test(text)?'uk':/\bunknown geography\b/i.test(text)?'unknown':'all',currency:String(text).match(/\b(GBP|USD|EUR|JPY)\b/)?.[1]??null});
 return {start_date:start,end_date:end,kpi_scope:scope,date_cutoff:today};
}
export function kpiPeriods(start,end,now){
 const days=(Date.parse(end)-Date.parse(start))/86400000+1,today=londonDay(now),month=today.slice(0,7)+'-01';
 const whole=start.endsWith('-01')&&end===dayAdd(monthAdd(start,1),-1);
 const primary=[{id:'selected',label:'Selected period',start_date:start,end_date:end},{id:'previous',label:'Previous equivalent period',start_date:whole?monthAdd(start,-1):dayAdd(start,-days),end_date:dayAdd(start,-1)},{id:'year',label:'Matching prior-year dates',start_date:monthAdd(start,-12),end_date:monthAdd(end,-12)}];
 const trends=Array.from({length:12},(_,i)=>{const s=monthAdd(month,i-12);return {id:'month:'+s,label:s.slice(0,7),start_date:s,end_date:dayAdd(monthAdd(s,1),-1)};});
 const mtdEnd=dayAdd(today,-1),mtd=month<=mtdEnd?[{id:'mtd',label:'Current MTD through yesterday',start_date:month,end_date:mtdEnd},{id:'mtd_previous',label:'Prior month same elapsed days (clamped)',start_date:monthAdd(month,-1),end_date:monthAdd(mtdEnd,-1)},{id:'mtd_year',label:'Prior year same elapsed days (clamped)',start_date:monthAdd(month,-12),end_date:monthAdd(mtdEnd,-12)}]:[];
 return [...primary,...trends,...mtd];
}
