const DAY = 86_400_000;
const MONTHS = new Map(['january','february','march','april','may','june','july','august','september','october','november','december'].map((name,index)=>[name,index+1]));
const iso = date => date.toISOString().slice(0,10);
const addDays = (date, days) => new Date(date.getTime()+days*DAY);

export function localDateAt(timestamp, timeZone='Europe/London') {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return new Date(Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day)));
}

function explicitRange(text, reference) {
  const isoMatch=text.match(/\b(\d{4}-\d{2}-\d{2})\s*(?:to|through|until|[-–—])\s*(\d{4}-\d{2}-\d{2})\b/i);
  if(isoMatch)return {original_wording:isoMatch[0],effective_start:isoMatch[1],effective_end:isoMatch[2],precision:'range'};
  const named=text.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?\s*(?:to|through|until|[-–—])\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?\b/i);
  if(!named)return null;
  const endYear=Number(named[6]||named[3]||reference.getUTCFullYear()),startYear=Number(named[3]||endYear);
  const make=(year,month,day)=>iso(new Date(Date.UTC(year,MONTHS.get(month.toLowerCase())-1,Number(day))));
  return {original_wording:named[0],effective_start:make(startYear,named[2],named[1]),effective_end:make(endYear,named[5],named[4]),precision:'range'};
}

export function resolveKnowledgeDates(message, {timestamp=Date.now(),timeZone='Europe/London'}={}) {
  const text=String(message||''),today=localDateAt(timestamp,timeZone);
  let found=explicitRange(text,today);
  const phrase=pattern=>text.match(pattern)?.[0];
  if(!found){
    const wording=phrase(/\bnext week\b/i)||phrase(/\bthis week\b/i)||phrase(/\bthis month\b/i)||phrase(/\btomorrow\b/i)||phrase(/\btoday\b/i);
    if(wording){
      let start=today,end=today;
      if(/week/i.test(wording)){const monday=addDays(today,-((today.getUTCDay()+6)%7));start=/next/i.test(wording)?addDays(monday,7):monday;end=addDays(start,6);}
      else if(/month/i.test(wording)){start=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),1));end=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()+1,0));}
      else if(/tomorrow/i.test(wording))start=end=addDays(today,1);
      found={original_wording:wording,effective_start:iso(start),effective_end:iso(end),precision:start.getTime()===end.getTime()?'day':'range'};
    }
  }
  if(!found)return null;
  if(found.effective_start>found.effective_end)return {ambiguous:true,original_wording:found.original_wording,clarification:'What start and end dates should this campaign use?'};
  return {...found,time_zone:timeZone,message_timestamp:new Date(timestamp).toISOString()};
}

export function campaignDateClarification(message,resolution) {
  if(resolution?.ambiguous)return resolution.clarification;
  if(!resolution&&/\b(?:campaign|promotion|promo|pushing|launch)\b/i.test(String(message||''))&&/\b(?:soon|later|around|sometime|for a while)\b/i.test(String(message||'')))return 'What start and end dates should this campaign use?';
  return null;
}
