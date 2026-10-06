import { evidenceNumber } from './numeric-evidence.js';
import { createCanonicalFinanceService, FINANCE_SEMANTICS } from '../finance/canonical.js';

export function createOracleFinanceService({bigquery,project}){
  const canonicalFinance=createCanonicalFinanceService({bigquery,project});
  return {
    async getRefunds({start_date,end_date,currency='GBP',location=null,channel=null,source=null,group_by='summary'}){
      if(location)throw new Error('Canonical refund evidence does not support a governed location filter; use channel or source.');
      const dimensions={summary:[],month:[],channel:['channel'],source:['source'],month_source:['source'],month_channel_source:['source','channel']}[group_by];
      if(!dimensions)throw new Error('Unsupported refund grouping');
      const rows=await canonicalFinance({start_date,end_date,currency,channel,source,transaction_type:'refund',grain:group_by.startsWith('month')?'month':'summary',dimensions});
      const presented=rows.map(row=>({...row,refund_count:evidenceNumber(row.refund_events),refunds_gross:evidenceNumber(row.amount),refunded_amount:evidenceNumber(row.amount)==null?null:Math.abs(evidenceNumber(row.amount)),semantics:FINANCE_SEMANTICS}));
      return group_by==='summary'&&currency!=null?presented[0]||{period:'summary',currency,status:'unavailable',refund_count:null,distinct_refunded_orders:null,refunds_gross:null,refunded_amount:null,semantics:FINANCE_SEMANTICS}:presented;
    }
  };
}
