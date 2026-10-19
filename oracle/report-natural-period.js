const MONTHS = {jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12};
const iso=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))?value:null;
function parseReportPeriod(text, now){
  const lower=text.toLowerCase().replace(/\b(?:exclude|excluding|without)\b[^.;\n]*/g,clause=>/20\d{2}-\d{2}-\d{2}\s+(?:to|through)|\d{1,2}\s*[–—-]\s*\d{1,2}\s+[a-z]+/.test(clause)?'':clause),localDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now)),today=new Date(`${localDay}T00:00:00Z`),todayIso=localDay;
  const counts={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
  const relative=lower.match(/\b(?:last|past)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(completed\s+)?(days?|months?)\b/);
  if(relative){
    const count=counts[relative[1]]||Number(relative[1]),completed=Boolean(relative[2]);
    if(!Number.isInteger(count)||count<1||count>(relative[3].startsWith('day')?3660:36))return {invalid:true};
    if(relative[3].startsWith('day')){
      const end=new Date(+today-(completed?86400000:0)),start=new Date(+end-(count-1)*86400000);
      return {start_date:start.toISOString().slice(0,10),end_date:end.toISOString().slice(0,10),requested_end_period:end.toISOString().slice(0,10),partial_period:!completed};
    }
    const start=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-count+(completed?0:1),1)),end=completed?new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),0)):today;
    return {start_date:start.toISOString().slice(0,10),end_date:end.toISOString().slice(0,10),requested_end_period:completed?end.toISOString().slice(0,7):'now',partial_period:!completed};
  }
  // Rolling windows include the runtime London day, matching governed
  // month-to-date cutoffs. Calendar weeks are completed Monday–Sunday.
  const shift=days=>new Date(+today+days*86400000).toISOString().slice(0,10);
  const window=(start,end,partial=false)=>({start_date:start,end_date:end,requested_end_period:end,partial_period:partial});
  if(/\b(?:in (?:the )?last week|(?:past|last) (?:seven|7) days|past week)\b/.test(lower))return window(shift(-6),todayIso,true);
  if(/\blast week\b/.test(lower)){const mondayOffset=(today.getUTCDay()+6)%7;return window(shift(-mondayOffset-7),shift(-mondayOffset-1));}
  const weekday=lower.match(/\bsince last (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if(weekday){const target=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].indexOf(weekday[1]),distance=(today.getUTCDay()-target+7)%7||7;return window(shift(-distance),todayIso,true);}
  // Resolve report roles before scanning incidental dates in exclusions.
  const reportText=lower;
  const fields=reportText.match(/report start date:\s*(20\d{2}-\d{2}-\d{2})[\s\S]*?report end date:\s*(20\d{2}-\d{2}-\d{2})/);
  if(fields)return window(fields[1],fields[2]);
  const monthNames=Object.keys(MONTHS).join('|');
  const namedRange=reportText.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})(?:\\s+(20\\d{2}))?\\s*(?:–|—|-|to|through)\\s*(\\d{1,2})\\s+(${monthNames})\\s+(20\\d{2})\\b`));
  const namedDate=(d,m,y)=>`${y}-${String(MONTHS[m]).padStart(2,'0')}-${d.padStart(2,'0')}`;
  if(namedRange)return window(namedDate(namedRange[1],namedRange[2],namedRange[3]||namedRange[6]),namedDate(namedRange[4],namedRange[5],namedRange[6]));
  const completed=reportText.match(new RegExp(`\\b(\\d{1,2})\\s+(${monthNames})\\s+(20\\d{2})\\s+(?:to|through)\\s+(?:yesterday|(?:the )?latest completed day)\\b`));
  if(completed)return window(namedDate(completed[1],completed[2],completed[3]),shift(-1));
  const explicitIso=lower.match(/\b(20\d{2}-\d{2}-\d{2})\s*(?:to|through|–|—)\s*(20\d{2}-\d{2}-\d{2})\b/);if(explicitIso)return{start_date:explicitIso[1],end_date:explicitIso[2],partial_period:false};
  const namedDay=lower.match(/\b(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/);if(namedDay){const d=`${namedDay[3]}-${String(MONTHS[namedDay[2]]).padStart(2,'0')}-${namedDay[1].padStart(2,'0')}`;if(!Number.isNaN(Date.parse(`${d}T00:00:00Z`))&&new Date(`${d}T00:00:00Z`).toISOString().slice(0,10)===d)return window(d,todayIso,true);return {invalid:true};}
  const singleIso=lower.match(/\b(20\d{2}-\d{2}-\d{2})\b/);if(singleIso){if(!Number.isNaN(Date.parse(`${singleIso[1]}T00:00:00Z`))&&new Date(`${singleIso[1]}T00:00:00Z`).toISOString().slice(0,10)===singleIso[1])return window(singleIso[1],todayIso,true);return {invalid:true};}
  if(/\bthis year(?:'s)?\b/.test(lower)&&/\blast year(?:'s)?\b/.test(lower)){const y=today.getUTCFullYear(),priorEnd=new Date(Date.UTC(y-1,today.getUTCMonth(),today.getUTCDate())).toISOString().slice(0,10);return{start_date:`${y}-01-01`,end_date:todayIso,requested_end_period:String(y),partial_period:true,comparison_type:'matching_elapsed_year_on_year',comparison_start_date:`${y-1}-01-01`,comparison_end_date:priorEnd};}
  const fromNamedToNow=lower.match(/\bfrom\s+(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\s+to\s+(?:now|today)\b/);
  if(fromNamedToNow){const start=`${fromNamedToNow[3]}-${String(MONTHS[fromNamedToNow[2]]).padStart(2,'0')}-${String(+fromNamedToNow[1]).padStart(2,'0')}`;return {start_date:start,end_date:todayIso,requested_end_period:'now',partial_period:true}}
  const numeric=lower.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\s*(?:-|–|to)\s*(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/);
  if(numeric){const isoDate=(d,m,y)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;const start=isoDate(+numeric[1],+numeric[2],numeric[3]),end=isoDate(+numeric[4],+numeric[5],numeric[6]);if(iso(start)&&iso(end)&&start<=end)return {start_date:start,end_date:end,requested_end_period:end,partial_period:false}}
  const names=Object.keys(MONTHS).join('|'),ranges=[...lower.matchAll(new RegExp(`\\b(${names})(?:\\s+(20\\d{2}))?\\s*(?:-|–|—|through|to)\\s*(${names})\\s+(20\\d{2})\\b`,'g'))];
  if(ranges.length){const dates=ranges.map(match=>{const sy=Number(match[2]||match[4]),sm=MONTHS[match[1]],ey=Number(match[4]),em=MONTHS[match[3]],monthEnd=new Date(Date.UTC(ey,em,0)).toISOString().slice(0,10);return{start_date:`${sy}-${String(sm).padStart(2,'0')}-01`,end_date:monthEnd>todayIso?todayIso:monthEnd,requested_end_period:`${ey}-${String(em).padStart(2,'0')}`,partial_period:monthEnd>todayIso}}).filter(x=>x.start_date<=x.end_date);if(dates.length)return{...dates[0],...(dates[1]?{comparison_start_date:dates[1].start_date,comparison_end_date:dates[1].end_date}: {})}}
  const found=[...lower.matchAll(/(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})/g)];
  if(found.length===2&&/\b(?:compare|between|versus|vs\.?|with|compared? (?:with|to))\b/.test(lower)){const values=found.map(x=>({month:MONTHS[x[1]],year:Number(x[2])})).sort((a,b)=>b.year-a.year||b.month-a.month),range=x=>({start_date:`${x.year}-${String(x.month).padStart(2,'0')}-01`,end_date:new Date(Date.UTC(x.year,x.month,0)).toISOString().slice(0,10)}),current=range(values[0]),comparison=range(values[1]);return{...current,requested_end_period:current.start_date.slice(0,7),partial_period:false,comparison_type:'explicit_period_comparison',comparison_start_date:comparison.start_date,comparison_end_date:comparison.end_date};}
  if(found.length){const first=found[0],last=found.at(-1),sm=MONTHS[first[1]],sy=+first[2],em=MONTHS[last[1]],ey=+last[2],monthEnd=new Date(Date.UTC(ey,em,0)).toISOString().slice(0,10);return {start_date:`${sy}-${String(sm).padStart(2,'0')}-01`,end_date:monthEnd>todayIso?todayIso:monthEnd,requested_end_period:`${ey}-${String(em).padStart(2,'0')}`,partial_period:monthEnd>todayIso}}
  const yearOnly=lower.match(/(?:just |about |from |in |for )?(20\d{2})(?!\s*[-–to]+\s*(?:20)?\d)/);
  if(yearOnly){const y=+yearOnly[1], end=`${y}-12-31`;return {start_date:`${y}-01-01`,end_date:end>todayIso&&y===today.getUTCFullYear()?todayIso:end,requested_end_period:String(y),partial_period:end>todayIso}}
  if(/last year/.test(lower)){const y=today.getUTCFullYear()-1;return {start_date:`${y}-01-01`,end_date:`${y}-12-31`,requested_end_period:String(y),partial_period:false}}
  if(/\b(?:this year|year to date|ytd)\b/.test(lower)){const y=today.getUTCFullYear();return {start_date:`${y}-01-01`,end_date:todayIso,requested_end_period:String(y),partial_period:true}}
  const monthStart=(year,month)=>`${year}-${String(month+1).padStart(2,'0')}-01`,monthEnd=(year,month)=>new Date(Date.UTC(year,month+1,0)).toISOString().slice(0,10);
  if(/\bthis month\b/.test(lower)&&/\blast month\b/.test(lower)){
    const prior=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-1,1)),end=monthEnd(prior.getUTCFullYear(),prior.getUTCMonth());
    return {start_date:monthStart(today.getUTCFullYear(),today.getUTCMonth()),end_date:todayIso,requested_end_period:todayIso.slice(0,7),partial_period:true,comparison_type:'explicit_period_comparison',comparison_start_date:monthStart(prior.getUTCFullYear(),prior.getUTCMonth()),comparison_end_date:/\bmatching elapsed\b/.test(lower)?end.slice(0,8)+String(Math.min(today.getUTCDate(),Number(end.slice(8)))).padStart(2,'0'):end};
  }
  if(/\bthis month\b/.test(lower))return{start_date:monthStart(today.getUTCFullYear(),today.getUTCMonth()),end_date:todayIso,requested_end_period:todayIso.slice(0,7),partial_period:true};
  if(/\blast month\b/.test(lower)){const d=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-1,1));return{start_date:monthStart(d.getUTCFullYear(),d.getUTCMonth()),end_date:monthEnd(d.getUTCFullYear(),d.getUTCMonth()),requested_end_period:monthStart(d.getUTCFullYear(),d.getUTCMonth()).slice(0,7),partial_period:false};}
  const rollingYears=lower.match(/\b(?:last|past)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(completed\s+)?years?\b/);
  if(rollingYears){
    const count=counts[rollingYears[1]]||Number(rollingYears[1]);if(!Number.isInteger(count)||count<1||count>10)return {invalid:true};
    const y=today.getUTCFullYear()-count,completed=Boolean(rollingYears[2]);
    const day=Math.min(today.getUTCDate(),new Date(Date.UTC(y,today.getUTCMonth()+1,0)).getUTCDate());
    const start=completed?`${y}-01-01`:new Date(Date.UTC(y,today.getUTCMonth(),day)).toISOString().slice(0,10);
    return {start_date:start,end_date:completed?`${today.getUTCFullYear()-1}-12-31`:todayIso,requested_end_period:completed?String(today.getUTCFullYear()-1):'now',partial_period:!completed};
  }
  return null;
}


export function reportPeriodResolution(text, now=Date.now(), {referenceYear=null}={}){
  if(/^(?:(?:just|only|for|in|during|what about|how about)\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)[.!]?$/i.test(text.trim()))text=`${text.trim().replace(/[.!]$/,'')} ${referenceYear||new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Europe/London'}).format(new Date(now))}`;
  const resolved=parseReportPeriod(text,now);
  if(!resolved)return {period:null,invalid:false};
  const valid=d=>/^\d{4}-\d{2}-\d{2}$/.test(d||'')&&Number.isFinite(Date.parse(d))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
  if(resolved.invalid||!valid(resolved.start_date)||!valid(resolved.end_date)||resolved.start_date>resolved.end_date)return {period:null,invalid:true};
  if(resolved.comparison_start_date&&(!valid(resolved.comparison_start_date)||!valid(resolved.comparison_end_date)||resolved.comparison_start_date>resolved.comparison_end_date))return {period:null,invalid:true};
  const cutoff=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  return {period:{...resolved,date_cutoff:cutoff,current_day_included:resolved.start_date<=cutoff&&resolved.end_date>=cutoff},invalid:false};
}

export function naturalReportPeriod(text,now=Date.now(),options={}){return reportPeriodResolution(text,now,options).period;}
