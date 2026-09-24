export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';
export const ONLINE_COUNTRY_LIMIT = 10;
export const ONLINE_COUNTRY_MAX_BYTES = 10_000_000_000;
export const SHOPIFY_NATIVE_HISTORY_START = '2025-11-16';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateOnlineCountrySalesInput(input = {}) {
  const { start_date, end_date, currency = null } = input;
  for (const [field, value] of Object.entries({ start_date, end_date })) {
    if (typeof value !== 'string' || !DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      throw new Error(`${field} must be a valid YYYY-MM-DD date`);
    }
  }
  if (start_date > end_date) throw new Error('start_date must be on or before end_date');
  if (currency !== null && (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency))) {
    throw new Error('currency must be null or a three-letter currency code');
  }
  return { start_date, end_date, currency: currency?.toUpperCase() || null };
}

/**
 * One row is established per source order before the latest direct geography
 * row is joined.  Country totals therefore cannot be multiplied by duplicate
 * geography snapshots.  Values remain in source currency and are never FX
 * converted.
 */
export function onlineCountrySalesSql(project) {
  return `WITH woo_geography AS (
    SELECT source_store,source_order_id,shipping_country_iso2 country_code,geography_status
    FROM \`${project}.commerce.order_geography\`
    WHERE source_platform='woo'
    QUALIFY ROW_NUMBER() OVER(PARTITION BY source_store,source_order_id ORDER BY imported_at DESC)=1
  ), shopify_geography AS (
    SELECT order_id source_order_id,shipping_country_code country_code,geography_status
    FROM \`${project}.shopify_data.order_shipping_geography\`
    QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1
  ), woo_orders_raw AS (
    SELECT 'woo' source_platform,'ww' source_store,CAST(order_id AS STRING) source_order_id,
      DATE(order_created_at) order_date,UPPER(currency) currency,status,
      CAST(total-ABS(COALESCE(total_refunds,0)) AS NUMERIC) operational_net_sales
    FROM \`${project}.metorik_uk.orders\`
    UNION ALL
    SELECT 'woo','usd',CAST(order_id AS STRING),DATE(order_created_at),UPPER(currency),status,
      CAST(total-ABS(COALESCE(total_refunds,0)) AS NUMERIC)
    FROM \`${project}.metorik_us.orders\`
  ), woo_orders AS (
    SELECT * FROM woo_orders_raw
    QUALIFY ROW_NUMBER() OVER(PARTITION BY source_store,source_order_id ORDER BY order_date DESC)=1
  ), shopify_orders AS (
    SELECT 'shopify' source_platform,'shopify' source_store,f.order_id source_order_id,
      DATE(f.created_at) order_date,UPPER(f.presentment_currency) currency,c.display_financial_status status,
      CAST(f.original_total_presentment-COALESCE(f.total_refunded_presentment,0) AS NUMERIC) operational_net_sales
    FROM \`${project}.shopify_data.order_financials\` f
    JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
    JOIN \`${project}.shopify_data.order_customers\` c USING(order_id)
    WHERE l.retail_location_id IS NULL AND c.cancelled_at IS NULL
      AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
    QUALIFY ROW_NUMBER() OVER(PARTITION BY f.order_id ORDER BY f.created_at DESC)=1
  ), eligible AS (
    SELECT o.source_platform,o.source_store,o.source_order_id,o.order_date,o.currency,o.operational_net_sales,
      IF(g.geography_status='observed' AND REGEXP_CONTAINS(g.country_code,r'^[A-Z]{2}$'),g.country_code,NULL) country_code
    FROM woo_orders o LEFT JOIN woo_geography g USING(source_store,source_order_id)
    WHERE LOWER(o.status) IN ('completed','processing')
      AND o.order_date BETWEEN DATE(@start_date) AND DATE(@end_date)
      AND (@currency IS NULL OR o.currency=UPPER(@currency))
    UNION ALL
    SELECT o.source_platform,o.source_store,o.source_order_id,o.order_date,o.currency,o.operational_net_sales,
      IF(g.geography_status='valid' AND REGEXP_CONTAINS(g.country_code,r'^[A-Z]{2}$'),g.country_code,NULL)
    FROM shopify_orders o LEFT JOIN shopify_geography g USING(source_order_id)
    WHERE LOWER(o.status) IN ('paid','partially_paid','partially_refunded')
      AND o.order_date BETWEEN DATE(@start_date) AND DATE(@end_date)
      AND (@currency IS NULL OR o.currency=UPPER(@currency))
  ), source_coverage AS (
    SELECT source_platform,source_store,currency,COUNT(*) eligible_orders,
      COUNTIF(country_code IS NULL) unknown_country_orders,SUM(operational_net_sales) eligible_sales,
      SUM(IF(country_code IS NULL,operational_net_sales,0)) unknown_country_sales,
      MIN(order_date) first_order_date,MAX(order_date) last_order_date
    FROM eligible GROUP BY 1,2,3
  ), country_source AS (
    SELECT currency,country_code,source_platform,source_store,COUNT(*) orders,SUM(operational_net_sales) operational_net_sales
    FROM eligible WHERE country_code IS NOT NULL GROUP BY 1,2,3,4
  ), country_totals AS (
    SELECT currency,country_code,SUM(orders) orders,SUM(operational_net_sales) operational_net_sales,
      ARRAY_AGG(STRUCT(source_platform,source_store,orders,operational_net_sales) ORDER BY source_platform,source_store) sources
    FROM country_source GROUP BY 1,2
  ), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY currency ORDER BY operational_net_sales DESC,country_code) country_rank
    FROM country_totals
  ), coverage AS (
    SELECT currency,SUM(eligible_orders) eligible_orders,SUM(unknown_country_orders) unknown_country_orders,
      SUM(eligible_sales) eligible_sales,SUM(unknown_country_sales) unknown_country_sales,
      ARRAY_AGG(STRUCT(source_platform,source_store,eligible_orders,unknown_country_orders,eligible_sales,
        unknown_country_sales,first_order_date,last_order_date) ORDER BY source_platform,source_store) source_coverage
    FROM source_coverage GROUP BY currency
  )
  SELECT c.currency,r.country_rank,r.country_code,r.orders,r.operational_net_sales,r.sources,
    c.eligible_orders,c.unknown_country_orders,c.eligible_sales,c.unknown_country_sales,c.source_coverage,
    SAFE_DIVIDE(c.unknown_country_orders,c.eligible_orders) unknown_order_share,
    SAFE_DIVIDE(c.unknown_country_sales,c.eligible_sales) unknown_sales_share
  FROM coverage c LEFT JOIN ranked r ON r.currency=c.currency AND r.country_rank<=${ONLINE_COUNTRY_LIMIT}
  ORDER BY currency,country_rank LIMIT 100`;
}

export function createOnlineCountrySalesService({ bigquery, project }) {
  if (!bigquery?.query || !project) throw new Error('bigquery and project are required');
  return async input => {
    const params = validateOnlineCountrySalesInput(input);
    const [rows] = await bigquery.query({ query: onlineCountrySalesSql(project),
      params: { ...params, matrixify_app_id: MATRIXIFY_APP_ID }, types: { currency: 'STRING' },
      useLegacySql: false, maximumBytesBilled: String(ONLINE_COUNTRY_MAX_BYTES),
      labels: { component: 'oracle', operation: 'online_country_sales' } });
    return { period: { start_date: params.start_date, end_date: params.end_date }, currency_filter: params.currency,
      rows: JSON.parse(JSON.stringify(rows)), source_scope: ['woo','shopify'],
      shopify_native_history: { known_start: SHOPIFY_NATIVE_HISTORY_START,
        warning: `Native Shopify history starts ${SHOPIFY_NATIVE_HISTORY_START}; do not describe Shopify as covering the whole requested period.` },
      semantics: {
        metric: 'Source-native operational order total less source refund total, after each source\'s established eligible-order status rules.',
        comparability: 'Woo and Shopify operational totals and refund capture come from different source systems. Combined country totals are directional, not canonical accounting revenue; use source breakdowns when comparing performance.',
        geography: 'Direct shipping-country evidence only. Unknown country is reported in coverage and excluded from named-country ranking.',
        currency: 'Ranked independently by source currency; no conversion or cross-currency addition.',
        deduplication: 'Orders are deduplicated before latest geography is joined; Matrixify Shopify representations are excluded.' },
      contract: { read_only: true, aggregate_only: true, pii_free: true, maximum_rows: 100 } };
  };
}

export const ONLINE_COUNTRY_SALES_TOOL_DEFINITION = {
  type: 'function', name: 'get_online_country_sales', strict: true,
  description: 'Rank direct shipping countries for all eligible WooCommerce and native Shopify online orders. Use for historical cross-platform online country rankings and follow-ups that add WooCommerce; never use ShopifyQL. Returns separate source-native currency rankings, explicit source/unknown-country coverage, and source breakdowns.',
  parameters: { type:'object', additionalProperties:false, properties:{
    start_date:{type:'string',description:'Inclusive YYYY-MM-DD date.'}, end_date:{type:'string',description:'Inclusive YYYY-MM-DD date.'},
    currency:{type:['string','null'],description:'Three-letter source currency, or null for independently separated currencies.'}
  }, required:['start_date','end_date','currency'] }
};
