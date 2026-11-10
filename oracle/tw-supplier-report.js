import ExcelJS from 'exceljs';
import {createHash} from 'node:crypto';
import {priorityArtifactId} from './product-priority-storage.js';
import {londonDay,offsetMonth} from '../public/oracle/tw-supplier-intent.js';

const CHANNELS=['Online Store','POS'];
const SOCIAL='Facebook & Instagram';
const DAY=86400000;
const days=(start,end)=>Array.from({length:Math.max(0,Math.round((Date.parse(end)-Date.parse(start))/DAY))},(_,i)=>new Date(Date.parse(start)+i*DAY).toISOString().slice(0,10));
const addDays=(date,n)=>new Date(Date.parse(date)+n*DAY).toISOString().slice(0,10);
const dateOk=s=>typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const known=n=>Number.isSafeInteger(n)&&n>=0;
const round=n=>Math.round(n*100)/100;
const overlap=(a,b,c,d)=>a<d&&c<b;
const EVENTS=[
  {name:'Black Friday',start:'2025-11-27',end:'2025-12-01',channels:['Online Store']},
  {name:'May Bank Holiday',start:'2026-05-01',end:'2026-05-05',channels:CHANNELS},
  {name:'Black Friday',start:'2026-11-05',end:'2026-11-09',channels:CHANNELS}
];
const SHEETS=['Order recommendations','Monthly sales','Stock by location','Seasonal demand','Coverage'];

export function twSupplierSettings(raw){
  if(!raw)return {};
  try{
    const s=JSON.parse(raw);
    const windows=(s.verifiedWindows||[]).filter(w=>dateOk(w.start)&&dateOk(w.end)&&w.start<w.end&&Array.isArray(w.channels)&&w.channels.every(c=>CHANNELS.includes(c)));
    const futureEvents=(s.futureEvents||[]).filter(w=>dateOk(w.start)&&dateOk(w.end)&&w.start<w.end&&days(w.start,w.end).length<=14&&EVENTS.some(e=>e.name===w.name));
    const ids=(s.sellableLocationIds||[]).filter(v=>typeof v==='string'&&/^gid:\/\/shopify\/Location\/\d+$/.test(v));
    const variants=Object.fromEntries(Object.entries(s.variants||{}).filter(([id,v])=>/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id)&&v&&typeof v==='object')
      .map(([id,v])=>[id,{leadDays:known(v.leadDays)&&v.leadDays<=365?v.leadDays:null,
        confirmedInboundDueInTime:known(v.confirmedInboundDueInTime)&&dateOk(v.inboundReviewedOn)?v.confirmedInboundDueInTime:null,
        inboundReviewedOn:v.inboundReviewedOn,inboundHorizonEnd:v.inboundHorizonEnd,packSize:v.packSize,participates:Array.isArray(v.participates)?v.participates:null}]));
    return {verifiedWindows:windows,futureEvents,sellableLocationIds:ids,variants};
  }catch{return {invalid:true};}
}

export function buildTwWorkbookRows({context,today,inventory,sales,settings={},failures=[]}){
  const last=context.end_date.slice(0,7),mtd=today.slice(0,7)+'-01';
  const months=Array.from({length:12},(_,i)=>{const m=offsetMonth(last,i-11);return {label:m,start:m+'-01',end:offsetMonth(m,1)+'-01'};});
  const periods=[...months,{label:mtd.slice(0,7)+' MTD',start:mtd,end:today}];
  const historical=EVENTS.filter(e=>periods.some(p=>overlap(p.start,p.end,e.start,e.end)));
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
    return sales!=null&&certified(day,channel)&&!Number(actualDays.get(day+'|Unknown')?.eligible_orders||0)&&(!r||
      Number(r.eligible_orders)===Number(r.orders_with_lines)&&!Number(r.unattributed_lines)&&!Number(r.invalid_quantity_lines));
  };
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
      verified_days:dates.filter(d=>dayComplete(d,channel)).length,eligible_orders_observed:orders,orders_with_lines:withLines,
      orders_without_lines:orders==null?null:orders-withLines,unattributed_lines:total('unattributed_lines'),
      confirmed_non_tw_lines_without_variant:total('non_tw_lines_without_variant'),
      confirmed_tw_lines_without_variant:total('tw_lines_without_variant'),
      lines_outside_current_tw:total('outside_selection_lines'),invalid_quantity_lines:total('invalid_quantity_lines')});
  }
  if(settings.invalid)coverage.push({status:'Reviewed supplier settings could not be parsed; planning inputs withheld.'});
  for(const note of failures)coverage.push({status:note});
  coverage.push({status:'Zeros require a reviewed source coverage window and reconciliation with eligible finance orders. Observed units in incomplete periods are lower bounds.'},
    {status:'Sales are original line units on native successful orders; cancelled orders and known Matrixify imports excluded. Returns, historical stock, receipts, stockout days and sell-through have no verified binding.'},
    {status:'Current tag and location stock reflect report run time, including for a historical report month. Available stock is not reduced by committed stock a second time.'},
    {status:'Facebook & Instagram observed units are shown separately and excluded from the Online Store + POS forecast and totals. Missing variant IDs on confirmed non-TW catalogue products are counted separately. Other unresolved lines still block verification.'},
    {status:'Inbound, future promotions, lead times, supplier pack sizes and sellable location IDs require reviewed planning inputs.'});
  const locations=inventory?.locations||[];
  const locationComplete=inventory?.population?.locations_complete===true;
  const catalogueComplete=inventory?.population?.catalogue_complete===true&&!inventory.failures?.some(f=>f.stage==='variants');
  const sumStock=(ls,required=true)=>required&&ls.length&&ls.every(l=>Number.isSafeInteger(l.available))?ls.reduce((n,l)=>n+l.available,0):null;
  const stockId=new Set(settings.sellableLocationIds||[]);
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
      {label:'Black Friday (5–8 Nov 2026)',start:'2026-11-05',end:'2026-11-09'}
    ].filter(p=>periods.some(r=>r.start<=p.start&&p.end<=r.end));
    const variantMonths=[];
    for(const period of [...periods,...saleSlices]){
      const [online,pos,social]=[...CHANNELS,SOCIAL].map(c=>signalFor(period,c,id));
      variantMonths.push({...label,period:period.label,online_units:online.units,pos_units:pos.units,facebook_instagram_observed_units:social.units,
        observed_total_units:online.units==null&&pos.units==null?null:(online.units??0)+(pos.units??0),
        returns:null,coverage:online.complete&&pos.complete?'verified':'partial or unavailable'});
    }
    tabs['Monthly sales'].push(...variantMonths);
    const level=(v.locations||[]).map(l=>({...l,workshop:/\bworkshops?\b/i.test(l.location_name||'')}));
    const combined=sumStock(level,locationComplete&&level.length===locations.length);
    const usableLevels=level.filter(l=>!l.workshop&&stockId.has(l.location_id));
    const usable=sumStock(usableLevels,locationComplete&&stockId.size===usableLevels.length);
    const stockRow={...label,period:'Current',combined_available:combined,usable_available:usable,
      workshop_available:sumStock(level.filter(l=>l.workshop),locationComplete),opening_available:null,closing_available:null,receipts:null,stockout_days:null,sell_through:null};
    for(const l of level)stockRow['Available · '+l.location_name+' · '+l.location_id.split('/').at(-1)]=l.available??null;
    tabs['Stock by location'].push(stockRow);
    for(const month of months)tabs['Stock by location'].push({...label,period:month.label,
      opening_available:null,closing_available:null,receipts:null,stockout_days:null,sell_through:null,
      coverage:'Historical inventory and receipts unavailable'});
    const recent=months.slice(-3);
    const ordinary=recent.map(period=>CHANNELS.map(c=>signalFor(period,c,id,true)));
    const inputs=settings.variants?.[id]||{};
    const demand=ordinary.every(ch=>ch.every(s=>s.complete))
      ?ordinary.reduce((sum,ch,i)=>sum+ch.reduce((n,s)=>n+s.units/s.days*days(recent[i].start,recent[i].end).length,0),0)/3:null;
    const lead=known(inputs.leadDays)?inputs.leadDays:null;
    const arrival=addDays(today,lead??0),horizonMonth=offsetMonth(arrival.slice(0,7),3);
    const monthEnd=addDays(offsetMonth(horizonMonth,1)+'-01',-1);
    const horizonEnd=horizonMonth+'-'+(arrival.slice(8)>monthEnd.slice(8)?monthEnd.slice(8):arrival.slice(8));
    const historicalRows=historical.map(e=>{
      const breakdown=e.channels.map(c=>signalFor(e,c,id)), complete=breakdown.every(s=>s.complete);
      const eventUnits=breakdown.some(s=>s.units!=null)?breakdown.reduce((n,s)=>n+(s.units??0),0):null;
      const dailyRates=e.channels.map(c=>{
        const s=ordinary.map(ch=>ch[CHANNELS.indexOf(c)]);
        return s.every(x=>x.complete)?s.reduce((n,x)=>n+x.units,0)/s.reduce((n,x)=>n+x.days,0):null;
      });
      const ordinaryUnits=dailyRates.every(n=>n!=null)?dailyRates.reduce((a,b)=>a+b,0)*days(e.start,e.end).length:null;
      return {...label,event:e.name,start:e.start,end_exclusive:e.end,observed_units:eventUnits,
        ordinary_monthly_units:demand==null?null:round(demand),
        ordinary_units_for_window:ordinaryUnits==null?null:round(ordinaryUnits),
        estimated_incremental_units:complete&&ordinaryUnits!=null?round(Math.max(0,eventUnits-ordinaryUnits)):null,
        coverage:complete?'verified lines; stockouts unknown':'partial; review last observed volume'};
    });
    tabs['Seasonal demand'].push(...historicalRows);
    const upcoming=(settings.futureEvents||[]).filter(e=>overlap(today,horizonEnd,e.start,e.end)&&inputs.participates?.includes(e.name));
    let uplift=0,unresolvedEvent=false;
    for(const e of upcoming){
      const prev=historicalRows.filter(r=>r.event===e.name&&r.estimated_incremental_units!=null).at(-1);
      const eventDays=days(e.start,e.end).length;
      const includedDays=days(e.start>today?e.start:today,e.end<horizonEnd?e.end:horizonEnd).length;
      const extra=prev&&eventDays?prev.estimated_incremental_units*includedDays/eventDays:null;
      if(extra==null)unresolvedEvent=true;else uplift+=extra;
      tabs['Seasonal demand'].push({...label,event:e.name,start:e.start,end_exclusive:e.end,estimated_incremental_units:extra==null?null:round(extra),
        coverage:extra==null?'insufficient history; review':'provisional uplift; stockouts unknown',
        lead_time_risk:lead==null?null:addDays(today,lead)>e.start});
    }
    const flags=['Historical stockouts and variant launch dates unverified'];
    if(demand==null)flags.push('Demand coverage insufficient');
    if(usable==null)flags.push('Usable stock unverified');
    if(lead==null)flags.push('No lead-time allowance');
    const inbound=known(inputs.confirmedInboundDueInTime)&&inputs.inboundReviewedOn===today&&inputs.inboundHorizonEnd===horizonEnd?inputs.confirmedInboundDueInTime:null;
    if(inbound==null)flags.push('Check inbound; none deducted');
    if(!settings.futureEvents?.length||!Array.isArray(inputs.participates))flags.push('Future event participation or dates unverified; baseline only');
    if(unresolvedEvent)flags.push('Upcoming event uplift unavailable; review');
    if(!catalogueComplete)flags.push('Catalogue incomplete');
    const target=demand==null?null:demand*(3+(lead??0)/30.4375);
    const recommended=target==null||usable==null||unresolvedEvent||!catalogueComplete?null:
      Math.ceil(Math.max(0,target+uplift-Math.max(0,usable)-(inbound??0))/(known(inputs.packSize)&&inputs.packSize>0?inputs.packSize:1))*(known(inputs.packSize)&&inputs.packSize>0?inputs.packSize:1);
    tabs['Order recommendations'].push({...label,...Object.fromEntries(recent.map(m=>{
      const found=variantMonths.find(r=>r.period===m.label);
      return [m.label+' observed units',found?.observed_total_units??null];
    })),average_monthly_ordinary_demand:demand==null?null:round(demand),three_month_target:demand==null?null:round(3*demand),
      supplier_lead_days:lead,horizon_end_exclusive:horizonEnd,incremental_event_units:unresolvedEvent?null:round(uplift),usable_stock:usable,
      confirmed_inbound_due_in_time:inbound,months_of_cover:demand>0&&usable!=null?round(Math.max(0,usable)/demand):null,
      suggested_units:recommended,review:flags.join('; ')});
  }
  const recentActivity=new Map(tabs['Monthly sales'].filter(r=>r.period===last||r.period.endsWith(' MTD'))
    .map(r=>r.variant_id).map(id=>[id,0]));
  for(const r of tabs['Monthly sales'])if(r.period===last||r.period.endsWith(' MTD'))
    recentActivity.set(r.variant_id,(recentActivity.get(r.variant_id)||0)+(r.observed_total_units||0));
  tabs['Order recommendations'].sort((a,b)=>
    Number((recentActivity.get(b.variant_id)||0)>0&&b.usable_stock!=null&&b.usable_stock<=3)-
    Number((recentActivity.get(a.variant_id)||0)>0&&a.usable_stock!=null&&a.usable_stock<=3)||
    (recentActivity.get(b.variant_id)||0)-(recentActivity.get(a.variant_id)||0)||a.variant_id.localeCompare(b.variant_id));
  return {tabs,variants:selected.length,catalogueComplete,coverage,
    recommended:tabs['Order recommendations'].filter(r=>r.suggested_units!=null).length};
}

export async function assertTwArtifact(a){
  const bytes=Buffer.from(a.xlsx_base64||'','base64');
  if(a.envelope?.kind!=='tw_supplier_report'||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('TW_INVALID_ARTIFACT');
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);
  if(SHEETS.some(name=>!wb.getWorksheet(name))||wb.getWorksheet(SHEETS[0]).rowCount!==a.envelope.variant_count+1)throw Error('TW_INVALID_WORKBOOK');
}
export function createTwSupplierReportService({readInventory,readSales,artifactStore,settings={},now=Date.now}){
  return async(message,options)=>{
    const {analysisContext:context,exportOwner,requestId,signal,deadlineAt}=options;
    if(!exportOwner||!requestId)return {answer:'The TW report needs an authenticated Oracle chat export.',tools:[],analysis_unavailable:true};
    const id=priorityArtifactId(exportOwner,requestId);
    let saved=await artifactStore.get(id,exportOwner);
    if(saved&&(saved.request!==message||saved.envelope?.start_date!==context.start_date||saved.envelope?.end_date!==context.end_date))throw Error('TW_EXPORT_REQUEST_CONFLICT');
    if(!saved){
      const today=londonDay(options.now??now()),failures=[];
      let inventory=null,sales=null;
      try{inventory=await readInventory({signal,deadlineAt:deadlineAt?Math.min(deadlineAt,Date.now()+120000):Date.now()+120000});}
      catch{failures.push('Live catalogue and inventory read failed.');}
      if(inventory?.failures?.length)failures.push('Catalogue or inventory is partial: '+[...new Set(inventory.failures.map(f=>f.stage))].join(', '));
      const variantIds=(inventory?.products||[]).flatMap(p=>p.variants.map(v=>v.id));
      const catalogueAudit=inventory?.population?.audit||[];
      const twProductIds=catalogueAudit.filter(p=>p.eligible===true).map(p=>p.product_id);
      const nonTwProductIds=catalogueAudit.filter(p=>p.exclusion==='required_tag_missing').map(p=>p.product_id);
      const pastEnd=offsetMonth(context.end_date.slice(0,7),1)+'-01';
      try{sales=await readSales({start:context.start_date,endExclusive:today>pastEnd?today:pastEnd,completedEndExclusive:pastEnd,mtdStart:today.slice(0,7)+'-01',variantIds,twProductIds,nonTwProductIds,signal,deadlineAt});}
      catch{failures.push('Shopify finance or retained line-item query failed.');}
      const report=buildTwWorkbookRows({context,today,inventory,sales,settings,failures});
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
      const envelope={kind:'tw_supplier_report',subject:'tw_supplier_stock',...period,periods:[period],
        variant_count:report.variants,recommended_count:report.recommended,unverified_channel_periods:incomplete,
        catalogue_complete:report.catalogueComplete,failures,as_of:inventory?.as_of||null};
      const answer=`TW supplier stock report: ${period.start_date} to ${period.end_date}, plus current month through yesterday (London). ${report.variants} variants; ${report.recommended} with a provisional or supported order quantity. ${incomplete} channel periods have incomplete or unverified sales coverage. Historical stock, receipts, stockout days, returns and sell-through are unavailable from the verified bindings. ${failures.join(' ')} See Coverage in the workbook.`;
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
