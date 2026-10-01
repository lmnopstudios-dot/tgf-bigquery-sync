export function parseMonth(value,name='month') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value || '')) throw new Error(`${name} must be YYYY-MM`);
  return value;
}
export function nextMonth(month) {
  parseMonth(month); const [year,number]=month.split('-').map(Number);
  return new Date(Date.UTC(year,number,1)).toISOString().slice(0,7);
}
export function previousMonth(month) {
  parseMonth(month); const [year,number]=month.split('-').map(Number);
  return new Date(Date.UTC(year,number-2,1)).toISOString().slice(0,7);
}
export function monthWindow(month) { return {start:`${parseMonth(month)}-01T00:00:00`,end:`${nextMonth(month)}-01T00:00:00`}; }
export function monthsBetween(from,through,limit) {
  parseMonth(from,'from'); parseMonth(through,'through');
  if(from>through) throw new Error('from must not be after through');
  const months=[]; for(let value=from;value<=through;value=nextMonth(value)){if(months.length>=limit)break;months.push(value);} return months;
}
export function londonMonth(now=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit'}).formatToParts(now).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return `${parts.year}-${parts.month}`;
}
