export const nextSaleDay=d=>new Date(Date.parse(d+'T00:00:00Z')+86400000).toISOString().slice(0,10);
// Resolve wall-clock times with the requested IANA timezone, including BST.
// Reject nonexistent or repeated instants instead of silently choosing an offset.
export function saleInstant(date,clock='00:00:00',zone='Europe/London'){
 const m=String(clock).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);if(!m||Number(m[1])>23||Number(m[2])>59||Number(m[3]||0)>59)throw Object.assign(Error('Invalid clock'),{code:'SALE_CLOCK_TIME_UNRESOLVED'});
 const target=`${date}T${m[1].padStart(2,'0')}:${m[2]}:${m[3]||'00'}`,naive=Date.parse(target+'Z');
 const f=new Intl.DateTimeFormat('sv-SE',{timeZone:zone==='GMT'?'UTC':zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const format=t=>f.format(new Date(t)).replace(' ','T');
 const possible=[-120,-60,0,60,120].map(m=>naive+m*60000).filter(t=>Number.isFinite(t)&&format(t)===target);
 if(possible.length!==1)throw Object.assign(Error('Unresolved source clock'),{code:'SALE_CLOCK_TIME_UNRESOLVED'});
 return new Date(possible[0]).toISOString().replace('.000Z','Z');
}
