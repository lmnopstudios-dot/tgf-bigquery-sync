/** Bounded, aggregate-only stored evidence. No Shopify requests or writes. */
import { pathToFileURL } from 'node:url';
import { createBigQueryClient } from '../bigquery/client.js';
import { datasetLocation } from '../bigquery/dataset-location.js';
import { orderValueSnapshotSql, orderValuePopulationSql, orderValueQueryOptions, validateOrderValueScope } from '../oracle/order-value-provider.js';
import { safeReadFailure } from '../oracle/read-failure.js';
import { boundedEvidenceRead } from '../oracle/bounded-evidence-read.js';

export function validateShippingEvidenceInput(input) {
  if(Object.keys(input).some(k=>!['start','end'].includes(k)))throw Error('Only --start and --end are allowed');
  validateOrderValueScope({start_date:input.start,end_date:input.end,platform:'shopify',channel:'online',time_zone:'Europe/London',country:'GB',currency:'GBP',basis:'observed_subtotal'});
  return input;
}
export function shippingEvidenceClass(value) {
  if(value==null)return 'missing_stored_value';
  const amount=Number(value);
  return !Number.isFinite(amount)||amount<0?'invalid_stored_value':amount===0?'ambiguous_collector_zero':'known_positive_charge';
}
export function shippingEvidenceSql(project) {
  return `${orderValuePopulationSql(project)}, classified AS (
    SELECT e.*,f.original_shipping_shop,f.shop_currency,
      CASE WHEN e.original_shipping_presentment IS NULL THEN 'missing_stored_value'
        WHEN e.original_shipping_presentment<0 THEN 'invalid_stored_value'
        WHEN e.original_shipping_presentment=0 THEN 'ambiguous_collector_zero'
        ELSE 'known_positive_charge' END charge_evidence
    FROM eligible e JOIN financials f USING(order_id)
  ), scenarios AS (
    SELECT c.*,threshold FROM classified c CROSS JOIN UNNEST([275,300]) threshold
    WHERE original_subtotal_presentment>=250 AND original_subtotal_presentment<threshold
    UNION ALL SELECT c.*,0 threshold FROM classified c
  )
  SELECT threshold,charge_evidence,COUNT(*) orders,
    COUNTIF(original_shipping_shop>0) positive_shop_shipping_orders,
    COUNTIF(original_shipping_shop=0) ambiguous_shop_zero_orders,
    COUNTIF(original_shipping_shop IS NULL) missing_shop_shipping_orders,
    COUNTIF(shop_currency!=presentment_currency) different_shop_currency_orders,
    SUM(IF(charge_evidence='known_positive_charge',original_shipping_presentment,NULL)) known_presentment_shipping,
    MIN(original_subtotal_presentment) minimum_subtotal,MAX(original_subtotal_presentment) maximum_subtotal
  FROM scenarios GROUP BY 1,2 ORDER BY 1,2 LIMIT 12`;
}
export function shippingPopulationAuditSql(project) {
  return `${orderValueSnapshotSql(project)}, audit AS (
    SELECT COALESCE(l.order_id,f.order_id) order_id,
      l.order_id IS NOT NULL location_matched,f.order_id IS NOT NULL financial_matched,
      c.order_id IS NOT NULL customer_matched,g.geography_status,g.shipping_country_code,
      f.presentment_currency,l.retail_location_id,l.source_app_id,
      l.order_id IS NOT NULL AND g.order_id IS NOT NULL AND l.retail_location_id IS DISTINCT FROM g.retail_location_id location_geography_retail_disagreement,
      l.order_id IS NOT NULL AND g.order_id IS NOT NULL AND l.source_app_id IS DISTINCT FROM g.source_app_id location_geography_app_disagreement,
      c.cancelled_at,f.cancelled_at finance_cancelled_at,c.display_financial_status,
      DATE(l.created_at,'Europe/London') london_location_date,DATE(f.created_at) utc_finance_date,
      DATE(f.created_at,'Europe/London') london_finance_date,DATE(f.processed_at,'Europe/London') london_processed_date
    FROM locations l FULL OUTER JOIN financials f USING(order_id)
    LEFT JOIN customers c ON c.order_id=COALESCE(l.order_id,f.order_id)
    LEFT JOIN geography g ON g.order_id=COALESCE(l.order_id,f.order_id)
  ), flags AS (
    SELECT *,COALESCE(london_location_date BETWEEN DATE(@start_date) AND DATE(@end_date),FALSE) oracle_date,
      COALESCE(utc_finance_date BETWEEN DATE(@start_date) AND DATE(@end_date),FALSE) reporting_date,
      COALESCE(financial_matched AND location_matched AND customer_matched AND geography_status='valid'
        AND shipping_country_code=@country AND presentment_currency=@currency
        AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id)
        AND cancelled_at IS NULL AND finance_cancelled_at IS NULL
        AND LOWER(display_financial_status) IN ('paid','partially_paid','partially_refunded'),FALSE) oracle_rules,
      COALESCE(financial_matched AND location_matched AND customer_matched AND geography_status='valid'
        AND shipping_country_code=@country AND UPPER(presentment_currency)=@currency
        AND retail_location_id IS NULL AND (source_app_id IS NULL OR source_app_id!=@matrixify_app_id)
        AND cancelled_at IS NULL
        AND LOWER(display_financial_status) IN ('paid','partially_paid','partially_refunded'),FALSE) reporting_rules
    FROM audit
  )
  SELECT geography_status,shipping_country_code,presentment_currency,
    retail_location_id IS NOT NULL retail_attributed,source_app_id=@matrixify_app_id matrixify,
    location_matched,financial_matched,customer_matched,
    oracle_date,reporting_date,oracle_rules,reporting_rules,COUNT(*) orders,
    COUNTIF(location_geography_retail_disagreement) retail_snapshot_disagreements,
    COUNTIF(location_geography_app_disagreement) app_snapshot_disagreements,
    COUNTIF(london_location_date IS DISTINCT FROM london_finance_date) location_finance_date_disagreements,
    COUNTIF(london_finance_date IS DISTINCT FROM utc_finance_date) utc_london_date_disagreements,
    COUNTIF(london_processed_date IS DISTINCT FROM london_finance_date) processed_created_date_disagreements,
    COUNTIF(finance_cancelled_at IS NOT NULL AND cancelled_at IS NULL) cancellation_snapshot_disagreements
  FROM flags WHERE oracle_date OR reporting_date GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12
  ORDER BY 1,2,3,4,5,6,7,8,9,10,11,12 LIMIT 2001`;
}
export function reconcileShippingPopulation(rows) {
  const counts={oracle_orders:0,online_country_uk_gbp_orders:0,both:0,oracle_only:0,reporting_only:0};
  const differences=[];
  for(const row of rows){const n=Number(row.orders);const a=row.oracle_date&&row.oracle_rules,b=row.reporting_date&&row.reporting_rules;
    if(a)counts.oracle_orders+=n;if(b)counts.online_country_uk_gbp_orders+=n;
    if(a&&b)counts.both+=n;else if(a){counts.oracle_only+=n;differences.push(row);}else if(b){counts.reporting_only+=n;differences.push(row);}}
  return {...counts,differences,exact_identity:'Latest governed snapshots; online-country criteria reproduced before top-ten ranking. Equal timestamp ties in legacy reporting may choose different snapshots. This is stored-population reconciliation, not authoritative Shopify completeness.'};
}
export function shippingRefundEvidenceSql(project) {
  return `${orderValuePopulationSql(project)}, refunds AS (
    SELECT * FROM \`${project}.shopify_data.order_refunds\`
    QUALIFY ROW_NUMBER() OVER(PARTITION BY refund_id ORDER BY synced_at DESC)=1
  ), evidence AS (
    SELECT e.order_id,e.original_subtotal_presentment,e.original_shipping_presentment,
      COUNTIF(r.refund_shipping_subtotal_presentment>0 AND r.presentment_currency=@currency) positive_shipping_refunds,
      COUNTIF(r.refund_shipping_subtotal_presentment=0) ambiguous_zero_shipping_refunds,
      COUNTIF(r.refund_shipping_lines_json IS NOT NULL AND SAFE.PARSE_JSON(r.refund_shipping_lines_json) IS NULL) malformed_shipping_payloads
    FROM eligible e LEFT JOIN refunds r USING(order_id)
    GROUP BY 1,2,3
  )
  SELECT threshold,COUNT(*) orders,
    COUNTIF(positive_shipping_refunds>0) orders_with_positive_shipping_refund,
    COUNTIF(positive_shipping_refunds>0 AND (original_shipping_presentment=0 OR original_shipping_presentment IS NULL)) unknown_original_with_positive_shipping_refund,
    COUNTIF(ambiguous_zero_shipping_refunds>0) orders_with_ambiguous_zero_shipping_refund,
    COUNTIF(malformed_shipping_payloads>0) orders_with_malformed_shipping_payload
  FROM evidence CROSS JOIN UNNEST([0,275,300]) threshold
  WHERE threshold=0 OR (original_subtotal_presentment>=250 AND original_subtotal_presentment<threshold)
  GROUP BY 1 ORDER BY 1 LIMIT 3`;
}
export async function diagnoseShippingEvidence(input,{bigquery,project}) {
  validateShippingEvidenceInput(input);
  const read=work=>boundedEvidenceRead(work,{maximumMs:30000});
  const location=await read(()=>datasetLocation(bigquery,project,'shopify_data'));
  const args={start_date:input.start,end_date:input.end,country:'GB',currency:'GBP',basis:'observed_subtotal'};
  const options={...orderValueQueryOptions(args,location),jobTimeoutMs:30000};
  const report={read_only:true,aggregate_only:true,period:input,location,financial_evidence_complete:false,
    bounds:{maximum_days:366,maximum_queries:4,maximum_dry_runs:3,maximum_bytes_per_query:1000000000,maximum_audit_rows:2000,maximum_shipping_rows:12,job_timeout_ms:30000},
    interpretation:{threshold_zero:'All eligible orders; 275/300 are observed subtotal >=250 and < proposed threshold, equality qualifies.',
      zero:'Ambiguous collector zero, never proven free shipping. Neither shop-money zero nor arithmetic residual proves free shipping.',
      positive_shop:'Independent stored shop-side amount can expose a presentment discrepancy; no FX conversion or substitution.',
      recovery:'No original totalShippingPriceSet or shipping-line payload is retained in these tables. Transactions describe payments; refund shipping lines describe refunds, not the original charge. Positive refund amounts can contradict free-shipping claims but cannot establish original charge or prove zero.',
      market:'Shipping country and presentment currency are separate filters; neither shop currency, customer address nor market is a substitute.',
      retail:'Null retailLocation is the governed proxy, not positive Online Store attribution. Cross-snapshot disagreements are evidence to investigate, not permission to alter eligibility.'},checks:[]};
  const [schemas]=await read(()=>bigquery.query({...options,query:`SELECT table_name,column_name,data_type,is_nullable FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN ('order_locations','order_financials','order_customers','order_shipping_geography','order_refunds') ORDER BY table_name,ordinal_position LIMIT 300`}));
  report.schemas=schemas;
  const reads=[['shipping',shippingEvidenceSql(project),12],['population_audit',shippingPopulationAuditSql(project),2000]];
  if(['refund_id','order_id','synced_at','presentment_currency','refund_shipping_subtotal_presentment','refund_shipping_lines_json'].every(column=>schemas.some(r=>r.table_name==='order_refunds'&&r.column_name===column)))
    reads.push(['shipping_refunds',shippingRefundEvidenceSql(project),3]);
  else report.checks.push({stage:'shipping_refunds',status:'blocked',reason:'Required refund evidence columns absent; absence is not evidence of no shipping refunds.'});
  for(const [stage,query,maxRows] of reads) {
    try {await read(()=>bigquery.createQueryJob({...options,query,dryRun:true}));const [rows]=await read(()=>bigquery.query({...options,query}));
      if(rows.length>maxRows)throw Object.assign(Error('Aggregate row bound exceeded'),{code:'SHIPPING_EVIDENCE_ROW_BOUND'});
      report[stage]=rows;report.checks.push({stage,status:'fulfilled'});
    }catch(error){report.checks.push({stage,status:'rejected',failure:safeReadFailure(error,stage)});}
  }
  if(report.population_audit)report.reconciliation=reconcileShippingPopulation(report.population_audit);
  return report;
}
async function main(){const input={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1])throw Error('Use --start YYYY-MM-DD --end YYYY-MM-DD');input[process.argv[i].slice(2)]=process.argv[i+1];}
  const report=await diagnoseShippingEvidence(input,createBigQueryClient());console.log(JSON.stringify(report,null,2));if(report.checks.some(c=>c.status==='rejected'))process.exitCode=1;}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(JSON.stringify({status:'failed',failure:safeReadFailure(error,'shipping_evidence')}));process.exitCode=1;});
