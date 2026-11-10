const months='January February March April May June July August September October November December'.split(' ');
const named=/^tw supplier stock report(?:\s+(for|as of)\s+(.+?))?[.!]?$/i;
export function twSupplierIntent(message){
  const text=String(message??'').trim(), match=named.exec(text);
  if(match){
    if(!match[1])return {};
    if(match[1].toLowerCase()==='as of'){
      const value=match[2], parts=/^(\d{1,2}) (\w+) (20\d{2})$/.exec(value);
      const m=parts?months.findIndex(name=>name.toLowerCase()===parts[2].toLowerCase()):-1;
      const date=m>=0?parts[3]+'-'+String(m+1).padStart(2,'0')+'-'+parts[1].padStart(2,'0'):value;
      return /^20\d{2}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date?{date}:{invalid:true};
    }
    const m=/^(\w+)\s+(20\d{2})$/.exec(match[2]);
    const month=m?months.findIndex(name=>name.toLowerCase()===m[1].toLowerCase()):-1;
    return month<0?{invalid:true}:{month:m[2]+'-'+String(month+1).padStart(2,'0')};
  }
  if(/^(?:build|create|show|run)\b/i.test(text)&&/\bshopify\b/i.test(text)&&/\b(?:sales and stock report|monthly supplier stock-ordering report)\b/i.test(text)&&/\btagged exactly\s*[`'"]?tw\b/i.test(text)&&/\bvariant/i.test(text))return {};
  return null;
}

export const londonDay=now=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
export function offsetMonth(month,n){
  const [y,m]=month.split('-').map(Number);
  return new Date(Date.UTC(y,m-1+n,1)).toISOString().slice(0,7);
}
export function twSupplierScope(message,now){
  const intent=twSupplierIntent(message);
  if(!intent)return null;
  const today=londonDay(now),current=today.slice(0,7),month=intent.month;
  if(intent.invalid||month&&month>=current||intent.date&&intent.date>today)return {invalid:true};
  const end=month?new Date(Date.parse(offsetMonth(month,1)+'-01')-86400000).toISOString().slice(0,10):intent.date||today;
  const completed=month||(end<today&&new Date(Date.parse(end)+86400000).getUTCDate()===1?end.slice(0,7):offsetMonth(end.slice(0,7),-1));
  return {start_date:offsetMonth(completed,-11)+'-01',end_date:end,current_day_included:end===today};
}
