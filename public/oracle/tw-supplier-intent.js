const months='January February March April May June July August September October November December'.split(' ');
const named=/^tw supplier stock report(?:\s+for\s+(.+?))?[.!]?$/i;
export function twSupplierIntent(message){
  const text=String(message??'').trim(), match=named.exec(text);
  if(match){
    if(!match[1])return {};
    const m=/^(\w+)\s+(20\d{2})$/.exec(match[1]);
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
  const current=londonDay(now).slice(0,7),month=intent.month||offsetMonth(current,-1);
  if(intent.invalid||month>=current)return {invalid:true};
  return {start_date:offsetMonth(month,-11)+'-01',end_date:new Date(Date.parse(offsetMonth(month,1)+'-01')-86400000).toISOString().slice(0,10)};
}
