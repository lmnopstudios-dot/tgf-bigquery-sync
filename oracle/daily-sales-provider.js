import { normalizeShopifyDay } from '../shopify/conversion-analytics.js';
import { evidenceNumber } from './numeric-evidence.js';

export const SHOPIFY_SALES_METRICS=Object.freeze(['orders','gross_sales','discounts','returns','net_sales','total_sales','average_order_value','net_items_sold']);
export const DAILY_SALES_CONTRACT=Object.freeze({metrics:['net_sales','orders'],dimensions:['weekday','day'],filters:['channel','currency','source_store'],grain:'day',platform:'shopify',channel:'online',currency_basis:'shop currency',timezone_semantics:'ShopifyQL calendar day in shop IANA timezone',definitions:{net_sales:'ShopifyQL source-native net sales (gross sales minus discounts and returns); shop currency.',orders:'ShopifyQL source-native orders; not conversion events or finance sale transactions.'},coverage:'Only explicitly reported days; omitted days are unavailable. Retrieval alone does not establish collection completeness.'});

/** The existing sales KPI query with authoritative metadata, reused by baseline and daily analysis. */
export function createShopifySalesKpiService({runReport,getShop}) {
  return async ({start_date,end_date,timeseries='none',sales_channel='Online Store'})=>{
    for(const date of [start_date,end_date])if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')||new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date)throw Error('Sales dates must be valid YYYY-MM-DD');
    if(start_date>end_date)throw Error('start_date must be on or before end_date');
    if(!['none','day','week','month'].includes(timeseries))throw Error('timeseries must be one of: none, day, week, month');
    if(!['Online Store','Point of Sale'].includes(sales_channel))throw Error('sales_channel must be one of: Online Store, Point of Sale');
    const sql=`FROM sales\nSHOW ${SHOPIFY_SALES_METRICS.join(', ')}\nWHERE sales_channel = '${sales_channel}'\n${timeseries==='none'?'':`TIMESERIES ${timeseries}\n`}SINCE ${start_date} UNTIL ${end_date}${timeseries==='none'?'':`\nORDER BY ${timeseries} ASC`}`;
    const rows=await runReport(sql);
    let shop;try{shop=await getShop();}catch{shop=null;}
    return {start_date,end_date,timeseries,sales_channel,currency:shop?.currencyCode||null,currency_basis:'Authoritative Shopify shop currency metadata.',source_store:shop?.id||null,reporting_timezone:shop?.ianaTimezone||null,timezone_semantics:DAILY_SALES_CONTRACT.timezone_semantics,source_collected_at:null,coverage:null,...(timeseries==='none'?{metrics:rows[0]??null}:{periods:rows})};
  };
}
export function createDailySalesProvider({shopifySales}) {
  return async args=>{
    if(!shopifySales)throw Object.assign(Error('Daily Shopify sales binding unavailable'),{code:'DAILY_SALES_UNAVAILABLE'});
    const raw=await shopifySales({start_date:args.start_date,end_date:args.end_date,timeseries:'day',sales_channel:'Online Store'});
    if(raw.timeseries!=='day'||raw.sales_channel!=='Online Store'||raw.start_date!==args.start_date||raw.end_date!==args.end_date)throw Object.assign(Error('Daily provider returned a different grain, channel or period'),{code:'EVIDENCE_SCOPE_MISMATCH'});
    const seen=new Set();
    const rows=(raw.periods||[]).map(row=>{
      const date=normalizeShopifyDay(row.day??row.date);
      if(seen.has(date)||date<args.start_date||date>args.end_date)throw Object.assign(Error('Duplicate or out-of-window daily sales'),{code:'DAILY_SALES_INVALID'});
      seen.add(date);
      return {date,net_sales:evidenceNumber(row.net_sales),orders:evidenceNumber(row.orders),complete:row.coverage?.complete===true||raw.coverage?.complete===true};
    });
    return {rows,period:{start_date:args.start_date,end_date:args.end_date},grain:'day',platform:'shopify',source_store:raw.source_store,channel:'online',currency:raw.currency,reporting_timezone:raw.reporting_timezone,timezone_semantics:raw.timezone_semantics,coverage:raw.coverage,source_collected_at:raw.source_collected_at,definitions:DAILY_SALES_CONTRACT.definitions};
  };
}
