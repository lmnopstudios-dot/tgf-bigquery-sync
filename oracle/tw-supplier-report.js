import {twBuyPlan,twMayDeadline,TW_LEAD_MONTHS} from './tw-supplier-planning.js';
import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from './product-priority-storage.js';
import {londonDay,offsetMonth} from '../public/oracle/tw-supplier-intent.js';

const CHANNELS=['Online Store','POS'];
const POOL=['Kings Cross','Shoreditch','Soho','Online Ready to Ship'];
const SOCIAL='Facebook & Instagram';
const DAY=86400000;
const days=(start,end)=>Array.from({length:Math.max(0,Math.round((Date.parse(end)-Date.parse(start))/DAY))},(_,i)=>new Date(Date.parse(start)+i*DAY).toISOString().slice(0,10));
const addDays=(date,n)=>new Date(Date.parse(date)+n*DAY).toISOString().slice(0,10);
const dateOk=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const known=n=>Number.isSafeInteger(n)&&n>=0;
const round=n=>Math.round(n*100)/100;
const EVENTS=[
  {name:'Black Friday',start:'2025-11-27',end:'2025-12-01',channels:['Online Store']},
  {name:'May Bank Holiday',start:'2026-05-01',end:'2026-05-05',channels:CHANNELS},
  {name:'Black Friday',start:'2026-11-05',end:'2026-11-09',channels:CHANNELS}
];
const SHEETS=['Order recommendations','Monthly sales','Stock by location','Seasonal demand','May top-up','Coverage'];

export function twSupplierSettings(raw){
  if(!raw)return {};
  try{
    const s=JSON.parse(raw);
    const windows=(s.verifiedWindows||[]).filter(w=>dateOk(w.start)&&dateOk(w.end)&&w.start<w.end&&Array.isArray(w.channels)&&w.channels.every(c=>CHANNELS.includes(c)));
    const futureEvents=(s.futureEvents||[]).filter(w=>dateOk(w.start)&&dateOk(w.end)&&w.start<w.end&&days(w.start,w.end).length<=14&&EVENTS.some(e=>e.name===w.name));
    const ids=(s.sellableLocationIds||[]).filter(v=>typeof v==='string'&&/^gid:\/\/shopify\/Location\/\d+$/.test(v));
    const mayPlan=s.mayPlan&&dateOk(s.mayPlan.requiredShelfDate)?{
      requiredShelfDate:s.mayPlan.requiredShelfDate,
      receivingBufferDays:known(s.mayPlan.receivingBufferDays)&&s.mayPlan.receivingBufferDays<=90?s.mayPlan.receivingBufferDays:null
    }:null;
    const variants=Object.fromEntries(Object.entries(s.variants||{}).filter(([id,v])=>/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)&&v&&typeof v==='object')
      .map(([id,v])=>[id,{confirmedInbound:Array.isArray(v.confirmedInbound)?v.confirmedInbound.map(r=>({dueDate:r?.dueDate,units:r?.units})):null,
        inboundReviewedOn:v.inboundReviewedOn,confirmedBackordersNotInAvailable:v.confirmedBackordersNotInAvailable,
        backordersReviewedOn:v.backordersReviewedOn,packSize:v.packSize,participates:Array.isArray(v.participates)?v.participates:null}]));
    return {verifiedWindows:windows,futureEvents,sellableLocationIds:ids,mayPlan,variants};
  }catch{return {invalid:true};}
}

export function buildTwWorkbookRows({context,today,inventory,snapshot=null,sales,settings={},failures=[]}){
  const cutoff=context.end_date, end=addDays(cutoff,1), live=cutoff===today;
  const validSnapshot=snapshot?.verified===true&&snapshot.date===cutoff&&
    Number.isFinite(Date.parse(snapshot.inventory?.as_of))&&londonDay(snapshot.inventory.as_of)===cutoff;
  const stock=live?inventory:validSnapshot?snapshot.inventory:null;
  const month=cutoff.slice(0,7),last=live?offsetMonth(month,-1):offsetMonth(end.slice(0,7),-1);
  const months=Array.from({length:12},(_,i)=>{const m=offsetMonth(last,i-11);return {label:m,start:m+'-01',end:offsetMonth(m,1)+'-01'};});
  // The current day is never counted as a completed trading day.
  const periods=[...months,...(last!==month?[{label:month+' MTD',start:month+'-01',end}]:[])];
  const historical=EVENTS.filter(e=>e.start<end&&e.end>context.start_date).map(e=>({...e,end:e.end>end?end:e.end}));
  const newestBlackFriday=historical.filter(e=>e.name==='Black Friday'&&e.end>offsetMonth(month,-1)+'-01').at(-1);
  const actualDays=new Map(),units=new Map();
  for(const r of sales||[]){
    if(r.kind==='coverage')actualDays.set(r.day+'|'+r.channel,r);
    if(r.kind==='sales'){
      const n=Number(r.units);
      if(r.units==null||!known(n))throw Error('TW_INVALID_SALES_UNITS');
      units.set([r.day,r.channel,r.variant_id].join('|'),n);
    }
  }
  const certified=(day,channel)=>(settings.verifiedWindows||[]).some(w=>w.start<=day&&day<w.end&&w.channels?.includes(channel));
  const dayComplete=(day,channel)=>{
    const r=actualDays.get(day+'|'+channel);
    return day<today&&sales!=null&&certified(day,channel)&&!Number(actualDays.get(day+'|Unknown')?.eligible_orders||0)&&(!r||
      Number(r.eligible_orders)===Number(r.orders_with_lines)&&!Number(r.unattributed_lines)&&!Number(r.invalid_quantity_lines));
  };
  // Reconciled observations can support a provisional run rate, but only
  // reviewed days can prove zero. Unresolved quantities stay out of units.
  const observedDay=(d,c)=>{
    const r=actualDays.get(d+'|'+c);
    return d<today&&sales!=null&&(r?Number(r.eligible_orders)>0&&Number(r.eligible_orders)===Number(r.orders_with_lines):certified(d,c));
  };
  const forecastStart=months.at(-3).start;
  const forecastEnd=live?today:end;
  const ordinaryDays=c=>days(forecastStart,forecastEnd).filter(d=>!EVENTS.some(e=>e.channels.includes(c)&&e.start<=d&&d<e.end));
  const sampleDays=Object.fromEntries(CHANNELS.map(c=>[c,ordinaryDays(c).filter(d=>observedDay(d,c))]));
  const minimumEvidence=CHANNELS.every(c=>months.slice(-3).every(m=>{
    const expected=ordinaryDays(c).filter(d=>m.start<=d&&d<m.end).length;
    return expected>0&&sampleDays[c].filter(d=>m.start<=d&&d<m.end).length>=Math.ceil(expected*.8);
  }));
  const verifiedForecast=CHANNELS.every(c=>ordinaryDays(c).every(d=>dayComplete(d,c)));
  const coveredDays=days(context.start_date,end).filter(d=>CHANNELS.every(c=>observedDay(d,c)));
  const latestCovered=coveredDays.at(-1)||null;
  const coverageGapDays=latestCovered==null?null:days(addDays(latestCovered,1),live?today:end).length;
  const selected=[];
  const identities=new Set();
  for(const p of inventory?.products||[])for(const v of p.variants){
    if(!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(v.id)||identities.has(v.id))throw Error('TW_INVALID_VARIANT_ID');
    identities.add(v.id);selected.push({p,v});
  }
  const tabs=Object.fromEntries(SHEETS.map(k=>[k,[]]));
  const coverage=tabs.Coverage;
  for(const p of periods)for(const channel of [...CHANNELS,SOCIAL,'Other','Unknown']){
    const dates=days(p.start,p.end),observed=dates.map(d=>actualDays.get(d+'|'+channel)).filter(Boolean);
    const total=k=>sales==null?null:observed.reduce((s,r)=>s+Number(r[k]??0),0);
    const orders=total('eligible_orders'),withLines=total('orders_with_lines');
    coverage.push({period:p.label,channel,start:p.start,end_exclusive:p.end,days:dates.length,
      partial_current_day:live&&dates.includes(today),reconciled_observation_days:dates.filter(d=>observedDay(d,channel)).length,verified_days:dates.filter(d=>dayComplete(d,channel)).length,eligible_orders_observed:orders,orders_with_lines:withLines,
      orders_without_lines:orders==null?null:orders-withLines,unattributed_lines:total('unattributed_lines'),
      confirmed_non_tw_lines_without_variant:total('non_tw_lines_without_variant'),
      confirmed_tw_lines_without_variant:total('tw_lines_without_variant'),
      lines_outside_current_tw:total('outside_selection_lines'),invalid_quantity_lines:total('invalid_quantity_lines')});
  }
  coverage.push({status:'Sales cutoff and latest reconciled completed date',cutoff_date:cutoff,
    latest_reconciled_date:latestCovered,completed_days_after_latest_reconciled_date:coverageGapDays,partial_current_day:live,
    stock_observed_at:stock?.as_of??null});
  if(settings.invalid)coverage.push({status:'Reviewed supplier settings could not be parsed; planning inputs withheld.'});
  for(const note of failures)coverage.push({status:note});
  coverage.push({status:'Zeros require a reviewed source coverage window and reconciliation with eligible finance orders. Observed units in incomplete periods are lower bounds. Latest reconciled date is not a certificate of source completeness or uninterrupted history.'},
    {status:'Sales are original line units on native successful orders; cancelled orders and known Matrixify imports excluded. Returns, historical stock, receipts, stockout days and sell-through have no verified binding.'},
    {status:'Catalogue tags reflect report run time. Historical stock requires a verified snapshot for the selected date. Available stock is not reduced by committed stock a second time.'},
    {status:'Facebook & Instagram observed units are shown separately and excluded from the Online Store + POS forecast and totals. Missing variant IDs on confirmed non-TW catalogue products are counted separately. Other unresolved lines still block verification.'},
    {status:'Provisional demand requires reconciled observations on at least 80% of ordinary days in each of the last three completed months per channel. Current-day sales are shown but excluded from the run rate. Unresolved sales are omitted; unverified absence is not zero demand.'},
    {status:'Lead time is fixed at three calendar months. The current buy covers ordinary demand for three months from arrival. May uplift is separate. Inbound dates, unreflected customer backorders, pack sizes and May shelf date require reviewed inputs.'});
  const mayEvent=(settings.futureEvents||[]).filter(e=>e.name==='May Bank Holiday'&&e.start>cutoff)
    .sort((a,b)=>a.start.localeCompare(b.start))[0];
  const mayShelf=settings.mayPlan?.requiredShelfDate;
  const mayBuffer=settings.mayPlan?.receivingBufferDays??null;
  const mayOrderBy=mayShelf&&(!mayEvent||mayShelf<=mayEvent.start)?twMayDeadline(mayShelf,mayBuffer):null;
  const locations=stock?.locations||[];
  const stockVariants=new Map((stock?.products||[]).flatMap(p=>p.variants.map(v=>[v.id,v])));
  const locationComplete=stock?.population?.locations_complete===true;
  const catalogueComplete=inventory?.population?.catalogue_complete===true&&!inventory.failures?.some(f=>f.stage==='variants');
  const sumStock=(ls,required=true)=>required&&ls.length&&ls.every(l=>Number.isSafeInteger(l.available))?ls.reduce((n,l)=>n+l.available,0):null;
  const poolMatches=POOL.map(name=>locations.filter(l=>l.name?.trim().toLowerCase()===name.toLowerCase()));
  const stockId=new Set(poolMatches.every(group=>group.length===1)?poolMatches.map(group=>group[0].id):[]);
  // An explicit reviewed pool remains supported, but cannot supply a missing snapshot.
  if(!stockId.size&&settings.sellableLocationIds?.length)
    for(const id of settings.sellableLocationIds)stockId.add(id);
  const signalFor=(p,channel,id,excludeEvents=false)=>{
    const dates=days(p.start,p.end).filter(d=>!excludeEvents||!EVENTS.some(e=>e.channels.includes(channel)&&e.start<=d&&d<e.end));
    const observed=dates.map(d=>units.get([d,channel,id].join('|'))).filter(n=>n!==undefined);
    const complete=dates.length>0&&dates.every(d=>dayComplete(d,channel));
    return {days:dates.length,complete,units:observed.length?observed.reduce((a,b)=>a+b,0):complete?0:null};
  };
  for(const {p,v} of selected){
    const id=v.id, label={product:p.title,variant:v.title,options:v.selectedOptions?.map(o=>o.name+': '+o.value).join('; ')||null,sku:v.sku||null,variant_id:id};
    const saleSlices=[
      {label:'Pre-sale October (19–31 Oct 2026)',start:'2026-10-19',end:'2026-11-01'},
      {label:'Pre-sale November (1–4 Nov 2026)',start:'2026-11-01',end:'2026-11-05'},
      {label:'Black Friday (5–8 Nov 2026)',start:'2026-11-05',end:'2026-11-09'},
      ...(newestBlackFriday&&newestBlackFriday.end<end?[{label:'Post-sale through cutoff',start:newestBlackFriday.end,end}]:[])
    ].filter(p=>p.start<end&&p.end>context.start_date).map(p=>({...p,end:p.end>end?end:p.end}));
    const variantMonths=[];
    for(const period of [...periods,...saleSlices]){
      const [online,pos,social]=[...CHANNELS,SOCIAL].map(c=>signalFor(period,c,id));
      variantMonths.push({...label,period:period.label,online_units:online.units,pos_units:pos.units,facebook_instagram_observed_units:social.units,
        observed_total_units:online.units==null&&pos.units==null?null:(online.units??0)+(pos.units??0),
        returns:null,partial_current_day:live&&period.start<=today&&today<period.end,coverage:online.complete&&pos.complete?'verified':'partial or unavailable'});
    }
    tabs['Monthly sales'].push(...variantMonths);
    const level=(stockVariants.get(id)?.locations||[]).map(l=>({...l,workshop:/\bworkshops?\b/i.test(l.location_name||'')}));
    const combined=sumStock(level,locationComplete&&level.length===locations.length);
    const usableLevels=level.filter(l=>!l.workshop&&stockId.has(l.location_id));
    const usable=sumStock(usableLevels,locationComplete&&stockId.size===usableLevels.length);
    const stockRow={...label,period:live?'Current':cutoff,stock_observed_at:stock?.as_of??null,combined_available:combined,usable_available:usable,
      workshop_available:sumStock(level.filter(l=>l.workshop),locationComplete),opening_available:null,closing_available:null,receipts:null,stockout_days:null,sell_through:null};
    for(const l of level)stockRow['Available · '+l.location_name+' · '+l.location_id.split('/').at(-1)]=l.available??null;
    tabs['Stock by location'].push(stockRow);
    for(const month of months)tabs['Stock by location'].push({...label,period:month.label,
      opening_available:null,closing_available:null,receipts:null,stockout_days:null,sell_through:null,
      coverage:'Historical inventory and receipts unavailable'});
    const recent=months.slice(-3);
    const inputs=settings.variants?.[id]||{};
    const unitsFor=(c,ds)=>ds.reduce((n,d)=>n+(units.get([d,c,id].join('|'))??0),0);
    const sampleTotal=CHANNELS.reduce((n,c)=>n+unitsFor(c,sampleDays[c]),0);
    const dailyRates=Object.fromEntries(CHANNELS.map(c=>[c,sampleDays[c].length?unitsFor(c,sampleDays[c])/sampleDays[c].length:null]));
    const demand=minimumEvidence&&(sampleTotal>0||verifiedForecast)
      ?CHANNELS.reduce((n,c)=>n+dailyRates[c]*30.4375,0):null;
    const ordinaryBeforeSale=CHANNELS.map(c=>signalFor({start:forecastStart,end:newestBlackFriday?.start??end},c,id,true).units);
    const soldDuring=newestBlackFriday?CHANNELS.filter(c=>newestBlackFriday.channels.includes(c)).map(c=>signalFor(newestBlackFriday,c,id).units):[];
    const postSale=newestBlackFriday&&newestBlackFriday.end<end
      ?CHANNELS.map(c=>signalFor({start:newestBlackFriday.end,end},c,id).units):[];
    const observedTotal=xs=>xs.some(n=>n!=null)?xs.reduce((n,x)=>n+(x??0),0):null;
    const buy=twBuyPlan({cutoff,dailyDemand:demand==null?null:demand/30.4375,usable,inputs,catalogueComplete});
    const historicalRows=historical.map(e=>{
      const breakdown=e.channels.map(c=>signalFor(e,c,id)), complete=breakdown.every(s=>s.complete);
      const eventUnits=breakdown.some(s=>s.units!=null)?breakdown.reduce((n,s)=>n+(s.units??0),0):null;
      const ordinaryUnits=demand==null?null:e.channels.reduce((n,c)=>n+dailyRates[c],0)*days(e.start,e.end).length;
      return {...label,event:e.name,start:e.start,end_exclusive:e.end,observed_units:eventUnits,
        ordinary_monthly_units:demand==null?null:round(demand),
        ordinary_units_for_window:ordinaryUnits==null?null:round(ordinaryUnits),
        estimated_incremental_units:complete&&ordinaryUnits!=null?round(Math.max(0,eventUnits-ordinaryUnits)):null,
        coverage:complete?'verified lines; stockouts unknown':'partial; review last observed volume'};
    });
    tabs['Seasonal demand'].push(...historicalRows);
    const previousMay=historicalRows.filter(r=>r.event==='May Bank Holiday').at(-1);
    const participation=Array.isArray(inputs.participates)?inputs.participates.includes('May Bank Holiday'):null;
    const uplift=participation===true&&mayEvent&&previousMay?.estimated_incremental_units!=null
      ?previousMay.estimated_incremental_units*days(mayEvent.start,mayEvent.end).length/days(previousMay.start,previousMay.end_exclusive).length:null;
    tabs['May top-up'].push({...label,prior_may_observed_units:previousMay?.observed_units??null,
      participation_confirmed:participation,required_shelf_date:mayShelf??null,receiving_buffer_days:mayBuffer,
      order_by:mayOrderBy,deadline_passed:mayOrderBy?mayOrderBy<cutoff:null,
      provisional_incremental_units:uplift==null?null:Math.ceil(uplift),
      review:[!mayShelf?'Set the required shelf date':!mayOrderBy?'Shelf date must be no later than the sale start':null,
        mayBuffer==null?'Receiving buffer unknown; deadline has no buffer':null,
        !mayEvent?'May sale dates unconfirmed':null,participation==null?'Variant participation unconfirmed':null,
        participation===true&&uplift==null?'Comparable May uplift unavailable':null,'Separate top-up; excluded from current buy'].filter(Boolean).join('; ')});
    const flags=['Provisional: based on identifiable ordinary sales','Historical stockouts and variant launch dates unverified'];
    if(!verifiedForecast)flags.push('Unverified days or unresolved lines; no zero demand inferred');
    if(coverageGapDays>0||latestCovered==null)flags.push('Completed-day sales coverage has a trailing gap');
    if(live)flags.push('Current-day sales are partial');
    if(!live&&!stock)flags.push('No verified inventory snapshot for cutoff');
    if(demand==null)flags.push('Demand coverage insufficient');
    if(usable==null)flags.push('Usable stock unverified');
    if(buy.inboundBefore==null)flags.push('Dated inbound unverified; none deducted');
    if(buy.confirmedBackorders==null)flags.push('Customer backorders unverified; none added');
    if(buy.laterCoverInbound)flags.push('Check timing of inbound after arrival');
    if(buy.short>0)flags.push('Likely shortage before delivery; excluded from buy');
    if(usable<0)flags.push('Negative stock treated as zero; check actual customer commitments');
    if(!catalogueComplete)flags.push('Catalogue incomplete');
    const rounded=n=>n==null?null:round(n);
    tabs['Order recommendations'].push({...label,...Object.fromEntries(recent.map(m=>{
      const found=variantMonths.find(r=>r.period===m.label);
      return [m.label+' observed units',found?.observed_total_units??null];
    })),ordinary_observed_units_excluding_post_sale:observedTotal(ordinaryBeforeSale),
      black_friday_observed_units:observedTotal(soldDuring),post_sale_observed_units:observedTotal(postSale),
      forecast_online_observed_days:sampleDays['Online Store'].length,forecast_pos_observed_days:sampleDays.POS.length,
      stock_observed_at:stock?.as_of??null,average_monthly_ordinary_demand:rounded(demand),usable_stock:usable,
      supplier_lead_months:TW_LEAD_MONTHS,
      'Before delivery · Expected arrival':buy.arrival,
      'Before delivery · Ordinary demand':rounded(buy.preDemand),
      'Before delivery · Confirmed inbound':buy.inboundBefore,
      'Before delivery · Projected stock at arrival':rounded(buy.remaining),
      'Before delivery · Likely short units':rounded(buy.short),
      'Supplier buy · Ordinary cover through':buy.coverThrough,
      'Supplier buy · Ordinary units after arrival':rounded(buy.target),
      'Supplier buy · Confirmed inbound':buy.inboundAfter,
      'Supplier buy · Confirmed customer backorders':buy.confirmedBackorders,
      suggested_units:buy.suggested,review:flags.join('; ')});
  }
  const priority=r=>(r.black_friday_observed_units??0)>0&&r.usable_stock!=null&&r.usable_stock<=3;
  tabs['Order recommendations'].sort((a,b)=>Number(priority(b))-Number(priority(a))||
    (b.black_friday_observed_units??0)-(a.black_friday_observed_units??0)||a.variant_id.localeCompare(b.variant_id));
  return {tabs,variants:selected.length,catalogueComplete,coverage,latestCovered,coverageGapDays,stockAsOf:stock?.as_of??null,
    recommended:tabs['Order recommendations'].filter(r=>r.suggested_units!=null).length};
}

export async function assertTwArtifact(a){
  const bytes=Buffer.from(a.xlsx_base64||'','base64');
  if(a.envelope?.kind!=='tw_supplier_report'||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('TW_INVALID_ARTIFACT');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);
  const required=a.envelope.planning_version===2?SHEETS:SHEETS.filter(name=>name!=='May top-up');
  if(required.some(name=>!wb.getWorksheet(name))||wb.getWorksheet(SHEETS[0]).rowCount!==a.envelope.variant_count+1)throw Error('TW_INVALID_WORKBOOK');
}
export function createTwSupplierReportService({readInventory,readSales,readSnapshot,artifactStore,settings={},now=Date.now}){
  return async(message,options)=>{
    const {analysisContext:context,exportOwner,requestId,signal,deadlineAt}=options;
    if(!exportOwner||!requestId)return {answer:'The TW report needs an authenticated Oracle chat export.',tools:[],analysis_unavailable:true};
    const id=priorityArtifactId(exportOwner,requestId);
    let saved=await artifactStore.get(id,exportOwner);
    if(saved&&(saved.request!==message||saved.envelope?.start_date!==context.start_date||saved.envelope?.end_date!==context.end_date))throw Error('TW_EXPORT_REQUEST_CONFLICT');
    if(!saved){
      const runTime=options.now??now(),today=londonDay(runTime),live=context.end_date===today,failures=[];
      let inventory=null,sales=null,snapshot=null;
      try{inventory=await readInventory({signal,catalogueOnly:!live,deadlineAt:deadlineAt?Math.min(deadlineAt,Date.now()+120000):Date.now()+120000});}
      catch{failures.push('Shopify catalogue or inventory read failed.');}
      if(inventory?.failures?.length)failures.push('Catalogue or inventory is partial: '+[...new Set(inventory.failures.map(f=>f.stage))].join(', '));
      const variantIds=(inventory?.products||[]).flatMap(p=>p.variants.map(v=>v.id));
      const catalogueAudit=inventory?.population?.audit||[];
      const twProductIds=catalogueAudit.filter(p=>p.eligible===true).map(p=>p.product_id);
      const nonTwProductIds=catalogueAudit.filter(p=>p.exclusion==='required_tag_missing').map(p=>p.product_id);
      if(!live&&readSnapshot)try{snapshot=await readSnapshot({date:context.end_date,variantIds,signal,deadlineAt});}
      catch{failures.push('Historical inventory snapshot read failed.');}
      const endExclusive=addDays(context.end_date,1);
      try{sales=await readSales({start:context.start_date,endExclusive,observedThrough:new Date(runTime).toISOString(),variantIds,twProductIds,nonTwProductIds,signal,deadlineAt});}
      catch{failures.push('Shopify finance or retained line-item query failed.');}
      const report=buildTwWorkbookRows({context,today,inventory,snapshot,sales,settings,failures});
      const wb=new ExcelJS.Workbook();
      for(const name of SHEETS){
        const sheet=wb.addWorksheet(name),rows=report.tabs[name],columns=[...new Set(rows.flatMap(Object.keys))];
        sheet.columns=(columns.length?columns:['status']).map(k=>({key:k,header:k,width:k==='review'||k==='status'?62:22}));
        for(const row of rows)sheet.addRow(row);
        sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];
        if(rows.length)sheet.autoFilter={from:'A1',to:sheet.getRow(1).getCell(sheet.columnCount).address};
      }
      const bytes=Buffer.from(await wb.xlsx.writeBuffer());
      const period={start_date:context.start_date,end_date:context.end_date};
      const periods=report.coverage.filter(r=>CHANNELS.includes(r.channel));
      const incomplete=periods.filter(r=>r.verified_days<r.days).length;
      const envelope={kind:'tw_supplier_report',planning_version:2,subject:'tw_supplier_stock',...period,periods:[period],
        variant_count:report.variants,recommended_count:report.recommended,unverified_channel_periods:incomplete,
        catalogue_complete:report.catalogueComplete,failures,as_of:report.stockAsOf,latest_reconciled_sales_date:report.latestCovered,sales_gap_days:report.coverageGapDays};
      const answer=`TW supplier stock report: ${period.start_date} to ${period.end_date}, inclusive (London). ${live?'Today is partial.':'Historical stock is blank unless a verified snapshot is available.'} Latest completed date with reconciled Online Store and POS observations: ${report.latestCovered||'unavailable'}; completed days after that through cutoff: ${report.coverageGapDays??'unknown'}. ${report.variants} variants; ${report.recommended} with a provisional or supported order quantity. Supplier lead time: three calendar months. May promotional uplift is shown separately. ${incomplete} channel periods have incomplete or unverified sales coverage. Receipts, stockout days, returns and sell-through are unavailable from the verified bindings. ${failures.join(' ')} See Coverage in the workbook.`;
      saved={request:message,envelope,answer,filename:'oracle-tw-supplier-stock.xlsx',sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')};
      await assertTwArtifact(saved);
      signal?.throwIfAborted();await options.assertLease?.();
      await artifactStore.put(id,exportOwner,saved);
      saved=await artifactStore.get(id,exportOwner);
    }
    await assertTwArtifact(saved);
    return {answer:saved.answer,tools:['get_tw_supplier_stock_report'],partial:true,evidence:saved.envelope,
      artifact:{id,filename:saved.filename,row_count:saved.envelope.variant_count,download_url:`${options.downloadBase||'/api/oracle/exports'}/${id}`}};
  };
}
