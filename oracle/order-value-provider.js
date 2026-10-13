import { ORDER_VALUE_SCHEMA } from './order-value-schema.js';
import { safeReadFailure, readFailureError } from './read-failure.js';
import { boundedEvidenceRead } from './bounded-evidence-read.js';
import { assertDatasetIdentifier, datasetLocation } from '../bigquery/dataset-location.js';
import { MATRIXIFY_APP_ID } from './online-country-sales.js';

export const ORDER_VALUE_ROW_BOUND=50000;
// The SDK extracts .value for explicit DATE parameters; plain ISO strings must
// use STRING, then DATE(@parameter) in SQL, as onlineCountrySalesSql does.
export const ORDER_VALUE_PARAMETER_TYPES=Object.freeze({start_date:'STRING',end_date:'STRING',country:'STRING',currency:'STRING',basis:'STRING',assumed_charge:'NUMERIC',matrixify_app_id:'STRING'});
export function orderValueQueryOptions(args,location) {
  return {params:{start_date:args.start_date,end_date:args.end_date,country:args.country,currency:args.currency,basis:args.basis,assumed_charge:args.assumed_charge??8,matrixify_app_id:MATRIXIFY_APP_ID},types:{...ORDER_VALUE_PARAMETER_TYPES},maximumBytesBilled:'1000000000',useLegacySql:false,location,labels:{component:'oracle_order_value_read'}};
}

export const ORDER_VALUE_DEFINITIONS=Object.freeze({
  dates:"Latest location snapshot created_at TIMESTAMP converted to Europe/London business date, inclusive start/end. Null created_at is excluded; no fallback to financial, customer, geography, updated_at or synced_at. Snapshots selected over all collected history before date filtering.",
  identity:'Shopify/shopify/order_id; latest component snapshot per order before joins; no line-item or refund one-to-many joins.',
  population:'Direct valid shippingAddress.countryCodeV2; retail_location_id IS NULL (existing governed online proxy, not positive Online Store attribution); exclude Matrixify; uncancelled paid, partially_paid or partially_refunded; fully refunded/unpaid excluded.',
  observed_subtotal:'Collected Shopify subtotalPriceSet.presentmentMoney.amount: observed discounted subtotal, shipping excluded. Tax inclusion and shipping-rule basis unverified. Do not subtract total discounts or add total tax again.',
  observed_total:'Collected totalPriceSet.presentmentMoney.amount: includes shipping/tax according to Shopify order semantics. Explicit alternative observed total; not shipping eligibility.',
  charges:'Collected totalShippingPriceSet.presentmentMoney.amount; separate original recorded shipping charges, before shipping-refund allocation. Not delivery cost, margin or profit.',
  zeros:'Finance collector coerces absent money fields to zero. Stored zero amounts/charges are ambiguous and treated as unknown; proven zero is supported only with independent evidence.',
  scenarios:'Threshold equality qualifies. Existing orders and behaviour unchanged. Observed-basis scenarios are conditional, not verified shipping-rule eligibility or forecasts. Hypothetical fee is supplied charge × affected orders, not an expected revenue gain/loss.',
  charge_completeness:'charge_total_complete describes known charges and known observed amounts within the retrieved affected-order calculation only. It does not verify population coverage, shipping rules, delivery cost, margin or profit. evidence_complete additionally requires verified population coverage.',
  coverage:'Represented dates and component matches describe collected evidence only. No authoritative complete-population reconciliation is available.'
});
export const ORDER_VALUE_FILTER_STAGES=Object.freeze([
  ['financial_match','financial_matched'],
  ['status_match','customer_matched'],
  ['geography_match','geography_matched'],
  ['valid_geography',"geography_status='valid'"],
  ['country','shipping_country_code=@country'],
  ['currency','presentment_currency=@currency'],
  ['online_proxy','retail_location_id IS NULL'],
  ['not_matrixify','(source_app_id IS NULL OR source_app_id!=@matrixify_app_id)'],
  ['uncancelled','cancelled_at IS NULL AND finance_cancelled_at IS NULL'],
  ['financial_status',"LOWER(display_financial_status) IN ('paid','partially_paid','partially_refunded')"]
]);
export function orderValueSnapshotSql(project) {
  assertDatasetIdentifier(project);
  const table=name=>`\`${project}.shopify_data.${name}\``;
  // Analytic ORDER BY accepts scalar expressions, not a whole-row range variable.
  // Tie-break only on governed fields; rows equal on these fields are equivalent
  // for every downstream calculation, without serializing private columns.
  const snapshot = name => `TO_JSON_STRING(STRUCT(${Object.keys(ORDER_VALUE_SCHEMA[name]).join(',')}))`;
  return `WITH locations AS (
    SELECT * FROM ${table('order_locations')} QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY updated_at DESC,synced_at DESC,${snapshot('order_locations')} DESC)=1
  ), financials AS (
    SELECT * FROM ${table('order_financials')} QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY updated_at DESC,synced_at DESC,${snapshot('order_financials')} DESC)=1
  ), customers AS (
    SELECT * FROM ${table('order_customers')} QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC,${snapshot('order_customers')} DESC)=1
  ), geography AS (
    SELECT * FROM ${table('order_shipping_geography')} QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC,${snapshot('order_shipping_geography')} DESC)=1
  )`;
}
export function orderValuePopulationSql(project) {
  return `${orderValueSnapshotSql(project)}, joined AS (
    SELECT l.order_id,DATE(l.created_at,'Europe/London') order_date,
      l.created_at location_created_at,f.created_at financial_created_at,
      c.order_created_at status_created_at,g.order_created_at geography_created_at,
      f.order_id IS NOT NULL financial_matched,c.order_id IS NOT NULL customer_matched,g.order_id IS NOT NULL geography_matched,
      g.geography_status,g.shipping_country_code,f.presentment_currency,
      l.retail_location_id,l.source_app_id,c.display_financial_status,c.cancelled_at,f.cancelled_at finance_cancelled_at,
      f.original_subtotal_presentment,f.original_total_presentment,f.original_shipping_presentment,
      f.synced_at financial_collected_at,l.synced_at location_collected_at,g.synced_at geography_collected_at,c.synced_at status_collected_at
    FROM locations l LEFT JOIN financials f USING(order_id) LEFT JOIN customers c USING(order_id) LEFT JOIN geography g USING(order_id)
  ), scoped AS (
    SELECT * FROM joined WHERE order_date BETWEEN DATE(@start_date) AND DATE(@end_date)
  ), eligible AS (
    SELECT * FROM scoped WHERE ${ORDER_VALUE_FILTER_STAGES.map(([,predicate])=>predicate).join(' AND ')}
  )`;
}
export function orderValueHistogramSql(project) {
  return `${orderValuePopulationSql(project)}
  SELECT CAST(order_date AS STRING) date,
    IF(@basis='observed_subtotal',NULLIF(original_subtotal_presentment,0),NULLIF(original_total_presentment,0)) amount,
    NULLIF(original_shipping_presentment,0) shipping_charge,COUNT(*) orders
  FROM eligible GROUP BY 1,2,3 ORDER BY 1,2,3 LIMIT ${ORDER_VALUE_ROW_BOUND+1}`;
}
export function orderValueCoverageSql(project) {
  return `${orderValuePopulationSql(project)}
  SELECT COUNT(*) represented_location_orders,COUNTIF(NOT financial_matched) missing_financials,
    COUNTIF(NOT customer_matched) missing_status,COUNTIF(NOT geography_matched) missing_geography,
    COUNTIF(geography_status IS NULL OR geography_status!='valid') unknown_country,
    COUNTIF(presentment_currency IS NULL) unknown_currency,
    COUNTIF(original_subtotal_presentment=0) ambiguous_zero_subtotals,
    COUNTIF(original_shipping_presentment=0) ambiguous_zero_charges,
    MIN(order_date) first_represented_date,MAX(order_date) last_represented_date,COUNT(DISTINCT order_date) represented_dates,
    MIN(financial_collected_at) first_financial_collection,MAX(financial_collected_at) latest_financial_collection,
    MIN(location_collected_at) first_location_collection,MAX(location_collected_at) latest_location_collection,
    MIN(geography_collected_at) first_geography_collection,MAX(geography_collected_at) latest_geography_collection,
    MIN(status_collected_at) first_status_collection,MAX(status_collected_at) latest_status_collection,
    (SELECT COUNT(*) FROM eligible) eligible_orders,
    (SELECT COUNT(DISTINCT order_date) FROM eligible) eligible_represented_dates,
    (SELECT MIN(order_date) FROM eligible) first_eligible_date,(SELECT MAX(order_date) FROM eligible) last_eligible_date,
    COUNTIF(retail_location_id IS NOT NULL) excluded_pos,COUNTIF(source_app_id=@matrixify_app_id) excluded_migrated,
    COUNTIF(cancelled_at IS NOT NULL OR finance_cancelled_at IS NOT NULL) excluded_cancelled,
    COUNTIF(display_financial_status IS NULL OR LOWER(display_financial_status) NOT IN ('paid','partially_paid','partially_refunded')) excluded_financial_status,
    (SELECT COUNT(*)-COUNT(DISTINCT order_id) FROM \`${project}.shopify_data.order_locations\` WHERE DATE(created_at,'Europe/London') BETWEEN DATE(@start_date) AND DATE(@end_date)) duplicate_location_rows,
    (SELECT COUNT(*)-COUNT(DISTINCT order_id) FROM \`${project}.shopify_data.order_financials\` WHERE DATE(created_at,'Europe/London') BETWEEN DATE(@start_date) AND DATE(@end_date)) duplicate_financial_rows,
    (SELECT COUNT(*)-COUNT(DISTINCT order_id) FROM \`${project}.shopify_data.order_customers\` WHERE DATE(order_created_at,'Europe/London') BETWEEN DATE(@start_date) AND DATE(@end_date)) duplicate_status_rows,
    (SELECT COUNT(*)-COUNT(DISTINCT order_id) FROM \`${project}.shopify_data.order_shipping_geography\` WHERE DATE(order_created_at,'Europe/London') BETWEEN DATE(@start_date) AND DATE(@end_date)) duplicate_geography_rows,
    (SELECT COUNT(*) FROM eligible WHERE original_shipping_presentment IS NULL OR original_shipping_presentment=0) unknown_eligible_charges,
    (SELECT COUNT(*) FROM eligible WHERE original_shipping_presentment>0 AND original_shipping_presentment!=@assumed_charge) non_standard_eligible_charges,
    (SELECT SUM(original_shipping_presentment) FROM eligible WHERE original_shipping_presentment>0) known_recorded_shipping,
    (SELECT COUNT(*) FROM eligible WHERE original_subtotal_presentment IS NULL OR original_subtotal_presentment=0) unknown_eligible_subtotals
  FROM scoped`;
}
export function validateOrderValueScope(args) {
  for(const d of [args.start_date,args.end_date])if(!/^\d{4}-\d{2}-\d{2}$/.test(d||'')||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)throw Error('Valid dates required');
  if(args.start_date>args.end_date||(Date.parse(args.end_date)-Date.parse(args.start_date))/86400000>=366)throw Error('Order-value reads require 1–366 days');
  if(args.platform!=='shopify'||args.channel!=='online'||args.time_zone!=='Europe/London'||args.source_store&&args.source_store!=='shopify'||!['observed_subtotal','observed_total'].includes(args.basis)||!/^[A-Z]{2}$/.test(args.country)||!/^[A-Z]{3}$/.test(args.currency))throw Error('Unsupported order-value population');
  return args;
}
export function createOrderValueProvider({bigquery,project}) {
  return async (args,options={})=>{
    validateOrderValueScope(args);
    let location;
    try{location=await boundedEvidenceRead(()=>datasetLocation(bigquery,project,'shopify_data'),options);}catch(error){throw readFailureError(error,'dataset_location');}
    const queryOptions=orderValueQueryOptions(args,location);
    let providerCalls=0;
    const read=query=>boundedEvidenceRead(timeoutMs=>{providerCalls++;return bigquery.query({...queryOptions,query,jobTimeoutMs:Math.max(1,Math.floor(timeoutMs))});},options);
    const results=await Promise.allSettled([read(orderValueHistogramSql(project)),read(orderValueCoverageSql(project))]);
    options.onProviderStage?.({stage:'aggregate_provider',selected_route:'get_order_value_analysis',provider_calls:providerCalls,population_status:results[0].status,coverage_status:results[1].status});
    if(results[0].status==='rejected')throw readFailureError(results[0].reason,'population_query');
    const rows=results[0].value[0];if(rows.length>ORDER_VALUE_ROW_BOUND)throw Object.assign(Error('Order-value aggregate read exceeds bound; narrow the period'),{code:'ORDER_VALUE_READ_BOUND'});
    return {scope:{...args,source_store:'shopify'},rows,definitions:ORDER_VALUE_DEFINITIONS,coverage:{...(results[1].status==='fulfilled'?results[1].value[0][0]:{}),complete:false,coverage_retrieval:results[1].status,...(results[1].status==='rejected'?{failure:safeReadFailure(results[1].reason,'coverage_query')}:{}),population_complete:'unverified'},collected_at:new Date().toISOString()};
  };
}
