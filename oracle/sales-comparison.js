import {SHOPIFY_PUBLIC_LAUNCH_DATE} from './device-source-conversion.js';

const scalar=x=>x?.value??x;
export const financeSource=row=>String(row.source_platform||row.source||'Unknown');
export const isOnline=row=>String(row.channel||'').toLowerCase()==='online';
const platform=row=>financeSource(row).toLowerCase();
const date=row=>String(scalar(row.date||row.period)||'').slice(0,10);

/** Dates establish observed evidence, never completeness or duplicate identity. */
export function migrationDiagnostics(current,comparison){
  const inspect=(rows,period)=>{
    const online=rows.filter(isOnline),shopify=online.filter(r=>platform(r).includes('shopify'));
    const before=shopify.filter(r=>date(r).length===10&&date(r)<SHOPIFY_PUBLIC_LAUNCH_DATE);
    const overlap=shopify.filter(r=>online.some(w=>/woo/i.test(platform(w))&&date(w)===date(r)&&w.currency===r.currency));
    return {period,prelaunch_dates:[...new Set(before.map(date))].sort(),overlap_dates:[...new Set(overlap.map(date))].sort(),prelaunch_rows:before,overlap_rows:overlap};
  };
  return {public_launch_date:SHOPIFY_PUBLIC_LAUNCH_DATE,periods:[inspect(current,'current'),inspect(comparison,'comparison')],duplicate_status:'not_established',handling:'All source dates and legitimate overlap retained; same-day evidence does not prove duplicate transactions.'};
}

export function financeComponents(rows){
  const groups=new Map();
  for(const row of rows){const key=[row.currency,row.channel,financeSource(row)].join('|'),item=groups.get(key)||{currency:row.currency,channel:row.channel,source:financeSource(row),gross_sales:0,refunds:0,net_gross:0,sales_transaction_count:0,count_available:true,dates:new Set()};
    for(const metric of ['gross_sales','refunds','net_gross'])item[metric]+=Number(row[metric]||0);
    const count=row.sales_transaction_count??row.orders;item.count_available&&=count!=null&&Number.isFinite(Number(count));item.sales_transaction_count+=Number(count||0);item.dates.add(date(row));groups.set(key,item);
  }
  return [...groups.values()].map(({dates,...item})=>({...item,sales_transaction_count:item.count_available?item.sales_transaction_count:null,observed_days:dates.size,first_evidence_date:[...dates].sort()[0],last_evidence_date:[...dates].sort().at(-1),collection_completeness:'not_established'}));
}

// The finance path preserves legacy ledger rows and native Shopify transactions,
// but provides no accepted cross-source migration reconciliation contract.
export const ONLINE_COMPARISON_BOUNDARY=Object.freeze({status:'withheld',definition_compatibility:'not_established',migration_reconciliation:'not_established',reason:'Compatible sale/refund dates, channel populations, historical transaction grain, source completeness and governed migration reconciliation have not been established. Source components are shown separately within each currency.'});
