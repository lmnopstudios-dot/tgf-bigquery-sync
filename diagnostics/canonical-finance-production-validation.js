import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { canonicalFinanceCtes, MATRIXIFY_APP_ID } from '../finance/canonical.js';

export const MIGRATION_DATE='2025-11-20';

export function validationQueries(project){
  const native=`native AS (SELECT DATE_TRUNC(DATE(r.refund_created_at),MONTH) month,
    UPPER(COALESCE(r.presentment_currency,f.presentment_currency)) currency,
    IF(l.retail_location_id IS NULL,'Online','POS') channel,
    COUNT(DISTINCT r.refund_id) refund_events,COUNT(DISTINCT r.order_id) distinct_refunded_orders,
    CAST(SUM(r.refund_total_presentment) AS FLOAT64) refund_amount
    FROM \`${project}.shopify_data.order_refunds\` r
    JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
    JOIN \`${project}.shopify_data.order_financials\` f USING(order_id)
    WHERE DATE(r.refund_created_at) BETWEEN DATE(@migration_date) AND @cutoff
      AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
      AND COALESCE(r.refund_total_presentment,0)>0 GROUP BY 1,2,3)`;
  const canonical=`${canonicalFinanceCtes(project)}, canonical AS (SELECT DATE_TRUNC(transaction_date,MONTH) month,currency,channel,
    COUNT(*) refund_events,COUNT(DISTINCT order_id) distinct_refunded_orders,
    CAST(ABS(SUM(amount)) AS FLOAT64) refund_amount FROM canonical_transactions
    WHERE transaction_type='refund' AND source='Shopify' AND transaction_date BETWEEN DATE(@migration_date) AND @cutoff GROUP BY 1,2,3)`;
  return {
    cutoff:`SELECT LEAST(MAX(cutoff),CURRENT_DATE()) cutoff FROM (
      SELECT MAX(date) cutoff FROM \`${project}.finance.accountant_transactions\` UNION ALL
      SELECT MAX(DATE(created_at)) FROM \`${project}.shopify_data.order_financials\` UNION ALL
      SELECT MAX(DATE(refund_created_at)) FROM \`${project}.shopify_data.order_refunds\`)`,
    native_shopify_refunds:`WITH ${native} SELECT * FROM native ORDER BY month,currency,channel`,
    canonical_shopify_refunds:`WITH ${canonical} SELECT * FROM canonical ORDER BY month,currency,channel`,
    reconciliation:`WITH ${native}, ${canonical} SELECT COALESCE(n.month,c.month) month,COALESCE(n.currency,c.currency) currency,COALESCE(n.channel,c.channel) channel,
      COALESCE(n.refund_events,0) native_refund_events,COALESCE(c.refund_events,0) canonical_refund_events,
      COALESCE(n.distinct_refunded_orders,0) native_refunded_orders,COALESCE(c.distinct_refunded_orders,0) canonical_refunded_orders,
      COALESCE(n.refund_amount,0) native_amount,COALESCE(c.refund_amount,0) canonical_amount,
      COALESCE(c.refund_amount,0)-COALESCE(n.refund_amount,0) difference,
      IF(COALESCE(n.refund_events,0)=COALESCE(c.refund_events,0) AND ABS(COALESCE(c.refund_amount,0)-COALESCE(n.refund_amount,0))<0.01,'PASS','FAIL') status
      FROM native n FULL JOIN canonical c USING(month,currency,channel) ORDER BY month,currency,channel`,
    historical_oracle_usd:`WITH ${canonicalFinanceCtes(project)} SELECT FORMAT_DATE('%Y-%m',transaction_date) month,source,channel,
      COUNT(*) refund_events,COUNT(DISTINCT order_id) distinct_refunded_orders,CAST(ABS(SUM(amount)) AS FLOAT64) refund_amount
      FROM canonical_transactions WHERE transaction_type='refund' AND currency='USD'
      AND transaction_date BETWEEN DATE '2023-01-01' AND @cutoff GROUP BY 1,2,3 ORDER BY 1,2,3`
  };
}

export async function validate({bigquery,project}){
  const queries=validationQueries(project),common={migration_date:MIGRATION_DATE,matrixify_app_id:MATRIXIFY_APP_ID};
  const [cutoffRows]=await bigquery.query({query:queries.cutoff,maximumBytesBilled:'5000000000',useLegacySql:false});
  const cutoff=cutoffRows[0]?.cutoff?.value||cutoffRows[0]?.cutoff||new Date().toISOString().slice(0,10);
  const evidence={};
  for(const [name,query] of Object.entries(queries).filter(([name])=>name!=='cutoff')){
    const [rows]=await bigquery.query({query,params:{...common,cutoff},maximumBytesBilled:'5000000000',useLegacySql:false});evidence[name]=rows;
  }
  const usd=evidence.native_shopify_refunds.filter(r=>r.currency==='USD');
  return {contract:{read_only:true,aggregate_only:true,pii_free:true,canonical_sign:'negative',display_sign:'positive_magnitude',refund_count:'persisted refund events',refund_date:'refund_created_at'},period:{start:MIGRATION_DATE,cutoff},acceptance:{native_shopify_usd_refunds_exist:usd.length>0,refund_events:usd.reduce((n,r)=>n+Number(r.refund_events||0),0),distinct_refunded_orders:usd.reduce((n,r)=>n+Number(r.distinct_refunded_orders||0),0),refund_amount:usd.reduce((n,r)=>n+Number(r.refund_amount||0),0),months:[...new Set(usd.map(r=>String(r.month?.value||r.month).slice(0,7)))],channels:[...new Set(usd.map(r=>r.channel))]},migration_boundary_months:['2025-11','2025-12'],evidence};
}

async function main(){
  const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';
  const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'null');
  if(!credentials)throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is required');
  console.log(JSON.stringify(await validate({project,bigquery:new BigQuery({projectId:project,credentials})}),null,2));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(e);process.exitCode=1;});
