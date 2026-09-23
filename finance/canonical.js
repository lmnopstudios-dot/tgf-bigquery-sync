export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';
export const CANONICAL_FINANCE_VERSION = 'canonical-finance-v1';

const GRAINS = Object.freeze({
  summary: "'summary'",
  day: "FORMAT_DATE('%Y-%m-%d', transaction_date)",
  week: "FORMAT_DATE('%G-W%V', transaction_date)",
  month: "FORMAT_DATE('%Y-%m', transaction_date)"
});

/**
 * One governed transaction stream. Shopify sales are one row per native order;
 * Shopify refunds are one row per persisted refund event. Existing non-Shopify
 * accountant rows preserve Woo/Square history and legitimate migration overlap.
 */
export function canonicalFinanceCtes(project) {
  return `legacy_non_shopify AS (
    SELECT date transaction_date,LOWER(transaction_type) transaction_type,
      COALESCE(source,'Unclassified') source,COALESCE(channel,'Unclassified') channel,
      UPPER(currency) currency,CAST(gross AS NUMERIC) amount,CAST(tax AS NUMERIC) tax,
      CAST(net_ex_tax AS NUMERIC) net_ex_tax,CAST(NULL AS STRING) order_id,
      CAST(NULL AS STRING) transaction_id,'finance.accountant_transactions' provenance
    FROM \`${project}.finance.accountant_transactions\`
    WHERE NOT REGEXP_CONTAINS(LOWER(COALESCE(source,'')),r'shopify')
  ), native_shopify_sales AS (
    SELECT DATE(f.created_at),'sale','Shopify',
      IF(l.retail_location_id IS NULL,'Online','POS'),UPPER(f.presentment_currency),
      CAST(f.original_total_presentment AS NUMERIC),CAST(f.original_tax_presentment AS NUMERIC),
      CAST(f.original_total_presentment-f.original_tax_presentment AS NUMERIC),f.order_id,f.order_id,
      'shopify_data.order_financials:presentment'
    FROM \`${project}.shopify_data.order_financials\` f
    JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
    WHERE (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
      AND COALESCE(f.original_total_presentment,0)>0
  ), native_shopify_refunds AS (
    SELECT DATE(r.refund_created_at),'refund','Shopify',
      IF(l.retail_location_id IS NULL,'Online','POS'),
      UPPER(COALESCE(r.presentment_currency,f.presentment_currency)),
      -ABS(CAST(r.refund_total_presentment AS NUMERIC)),
      -ABS(CAST(COALESCE(r.refund_tax_presentment,0) AS NUMERIC)),
      -ABS(CAST(r.refund_total_presentment-COALESCE(r.refund_tax_presentment,0) AS NUMERIC)),
      r.order_id,r.refund_id,'shopify_data.order_refunds:presentment'
    FROM \`${project}.shopify_data.order_refunds\` r
    JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
    JOIN \`${project}.shopify_data.order_financials\` f USING(order_id)
    WHERE (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
      AND r.refund_created_at IS NOT NULL AND COALESCE(r.refund_total_presentment,0)>0
  ), canonical_transactions AS (
    SELECT * FROM legacy_non_shopify UNION ALL
    SELECT * FROM native_shopify_sales UNION ALL
    SELECT * FROM native_shopify_refunds
  )`;
}

export function buildCanonicalFinanceQuery(project,{grain='day',dimensions=[]}={}) {
  if (!Object.hasOwn(GRAINS,grain)) throw new Error('grain must be summary, day, week, or month');
  const allowed=new Set(['source','channel','currency','transaction_type']);
  if (!dimensions.every(x=>allowed.has(x))) throw new Error('unsupported finance dimension');
  const selected=[`${GRAINS[grain]} period`,...dimensions];
  const grouped=selected.map((_,i)=>String(i+1)).join(',');
  return `WITH ${canonicalFinanceCtes(project)}
    SELECT ${selected.join(',')},COUNT(*) transaction_count,
      COUNTIF(transaction_type='refund') refund_events,
      COUNT(DISTINCT IF(transaction_type='refund',order_id,NULL)) distinct_refunded_orders,
      CAST(SUM(amount) AS FLOAT64) amount,CAST(SUM(tax) AS FLOAT64) tax,
      CAST(SUM(net_ex_tax) AS FLOAT64) net_ex_tax
    FROM canonical_transactions
    WHERE transaction_date BETWEEN DATE(@start_date) AND DATE(@end_date)
      AND (@currency IS NULL OR currency=UPPER(@currency))
      AND (@channel IS NULL OR LOWER(channel)=LOWER(@channel))
      AND (@source IS NULL OR LOWER(source)=LOWER(@source))
      AND (@transaction_type IS NULL OR transaction_type=LOWER(@transaction_type))
    GROUP BY ${grouped} ORDER BY ${grouped}`;
}

export function createCanonicalFinanceService({bigquery,project}) {
  return async function queryFinance({start_date,end_date,grain='day',currency=null,channel=null,source=null,transaction_type=null,dimensions=[]}) {
    const query=buildCanonicalFinanceQuery(project,{grain,dimensions});
    const params={start_date,end_date,currency,channel,source,transaction_type,matrixify_app_id:MATRIXIFY_APP_ID};
    const [rows]=await bigquery.query({query,params,types:{currency:'STRING',channel:'STRING',source:'STRING',transaction_type:'STRING'},maximumBytesBilled:'5000000000',useLegacySql:false});
    return rows;
  };
}

export const FINANCE_SEMANTICS=Object.freeze({
  refund_count:'refund_events counts distinct persisted Shopify refund IDs (and one governed legacy ledger refund row per event); distinct_refunded_orders is also exposed.',
  refund_date:'Shopify refunds use refund_created_at, never the underlying order date.',
  sign:'Canonical refunds are negative ledger values; presentation may show ABS(amount) only when labelled as a magnitude.',
  currency:'Shopify sales and refunds use presentment currency and amounts. Currencies are never converted or combined.'
});
