import {londonDay} from './tw-supplier-intent.js';
export function eyewearReportIntent(message){
  const text=String(message??'').trim();
  return /^cutler (?:and|&) gross stock and sales report[.!]?$/i.test(text)||
    /\bcutler\s+(?:and|&)\s+gross\b/i.test(text)&&/\b(?:eyewear|sunglasses|glasses)\b/i.test(text)&&
    /\b(?:report|review)\b/i.test(text)&&/\b(?:sales|sold)\b/i.test(text)&&/\bsquare\b/i.test(text)&&/\bwoocommerce\b/i.test(text);
}
export function eyewearReportPeriod(now){
  const today=londonDay(now);
  const d=new Date(today+'T00:00:00Z'), y=d.getUTCFullYear()-3,m=d.getUTCMonth();
  const day=Math.min(d.getUTCDate(),new Date(Date.UTC(y,m+1,0)).getUTCDate());
  return {start_date:new Date(Date.UTC(y,m,day)).toISOString().slice(0,10),
    end_date:new Date(d.valueOf()-86400000).toISOString().slice(0,10)};
}
