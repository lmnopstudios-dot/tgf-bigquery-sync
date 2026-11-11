// London calendar dates, not elapsed hours. Clamp to the last day when the
// destination month is shorter (for example 30 November -> 28 February).
import {offsetMonth} from '../public/oracle/tw-supplier-intent.js';

const DAY=86400000;
export const calendarDayOffset=(d,n)=>new Date(Date.parse(d)+n*DAY).toISOString().slice(0,10);
const dayCount=(a,b)=>(Date.parse(b)-Date.parse(a))/DAY;
export const twDateValid=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&calendarDayOffset(d,0)===d;
export const twUnits=n=>Number.isSafeInteger(n)&&n>=0;
export const TW_LEAD_MONTHS=3;
export const TW_COVER_MONTHS=1;
export function calendarMonthOffset(date,count){
  const month=offsetMonth(date.slice(0,7),count);
  const last=calendarDayOffset(offsetMonth(month,1)+'-01',-1).slice(8);
  return month+'-'+(date.slice(8)>last?last:date.slice(8));
}

export function twPlanningDates(orderDate){
  const arrival=calendarMonthOffset(orderDate,TW_LEAD_MONTHS);
  const coverEnd=calendarMonthOffset(arrival,TW_COVER_MONTHS);
  return {arrival,coverEnd,coverThrough:calendarDayOffset(coverEnd,-1)};
}

export function twMayDeadline(shelfDate,bufferDays){
  if(!twDateValid(shelfDate))return null;
  const ready=calendarDayOffset(shelfDate,-(bufferDays??0));
  let orderBy=calendarMonthOffset(ready,-TW_LEAD_MONTHS);
  // A clamped arrival can make additional dates in the order month viable.
  while(calendarMonthOffset(calendarDayOffset(orderBy,1),TW_LEAD_MONTHS)<=ready)
    orderBy=calendarDayOffset(orderBy,1);
  return orderBy;
}

export function twBuyPlan({cutoff,dailyDemand,usable,inputs={},catalogueComplete=true}){
  const {arrival,coverEnd,coverThrough}=twPlanningDates(cutoff);
  const inbound=inputs.inboundReviewedOn===cutoff&&Array.isArray(inputs.confirmedInbound)&&
    inputs.confirmedInbound.every(r=>twDateValid(r?.dueDate)&&twUnits(r?.units))
    ?inputs.confirmedInbound.filter(r=>r.dueDate>=cutoff&&r.dueDate<coverEnd):null;
  const before=inbound?.filter(r=>r.dueDate<arrival)??[];
  const after=inbound?.filter(r=>r.dueDate>=arrival)??[];
  const qty=rows=>rows.reduce((n,r)=>n+r.units,0);
  const confirmedBackorders=inputs.backordersReviewedOn===cutoff&&twUnits(inputs.confirmedBackordersNotInAvailable)
    ?inputs.confirmedBackordersNotInAvailable:null;
  const dailyKnown=Number.isFinite(dailyDemand)&&dailyDemand>=0;
  const canProject=dailyKnown&&Number.isFinite(usable);
  const preDemand=dailyKnown?dailyDemand*dayCount(cutoff,arrival):null;
  const target=dailyKnown?dailyDemand*dayCount(arrival,coverEnd):null;
  let remaining=canProject?Math.max(0,usable):null,short=canProject?0:null;
  if(canProject){
    let from=cutoff;
    // Shortfalls before a later receipt are counted as likely lost sales,
    // not allowed to draw inventory below zero and carry into the buy.
    for(const {dueDate,units} of [...before,{dueDate:arrival,units:0}].sort((a,b)=>a.dueDate.localeCompare(b.dueDate))){
      const net=remaining-dailyDemand*dayCount(from,dueDate);
      short+=Math.max(0,-net);
      remaining=Math.max(0,net)+units;
      from=dueDate;
    }
  }
  const pack=twUnits(inputs.packSize)&&inputs.packSize>0?inputs.packSize:1;
  const needed=canProject&&catalogueComplete?Math.max(0,target-remaining-qty(after)+(confirmedBackorders??0)):null;
  return {arrival,coverEnd,coverThrough,preDemand,target,remaining,short,confirmedBackorders,
    inboundBefore:inbound?qty(before):null,inboundAfter:inbound?qty(after):null,
    laterCoverInbound:after.some(r=>r.dueDate>arrival),
    suggested:needed==null?null:Math.ceil(needed/pack)*pack};
}
