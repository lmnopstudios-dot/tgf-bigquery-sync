export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';
export const COUNTRY_LIMIT = 10;
export const PRODUCT_LIMIT = 10;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateCountryProductInput(input = {}) {
  const { start_date, end_date, currency = null } = input;
  for (const [name, value] of Object.entries({ start_date, end_date })) {
    if (typeof value !== 'string' || !DATE.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
      throw new Error(`${name} must be a valid YYYY-MM-DD date`);
    }
  }
  if (start_date > end_date) throw new Error('start_date must be on or before end_date');
  if (currency !== null && (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency))) {
    throw new Error('currency must be null or a three-letter currency code');
  }
  return { start_date, end_date, currency: currency?.toUpperCase() || null };
}

/**
 * Shopify Online Store operational analysis. Order-valued country rankings and
 * line-valued product rankings deliberately live in separate CTEs: joining a
 * line cannot multiply an order sale. Rankings are independently partitioned
 * by presentment currency, which is never converted or combined.
 */
export function shopifyCountryProductsSql(project) {
  return `WITH geography AS (
    SELECT order_id,shipping_country_code,shipping_country_name,geography_status
    FROM \`${project}.shopify_data.order_shipping_geography\`
    QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1
  ), eligible_orders AS (
    SELECT f.order_id,DATE(f.created_at) order_date,UPPER(f.presentment_currency) currency,
      CAST(f.original_total_presentment-COALESCE(f.total_refunded_presentment,0) AS NUMERIC) operational_net_sales,
      IF(g.geography_status='valid' AND REGEXP_CONTAINS(g.shipping_country_code,r'^[A-Z]{2}$'),g.shipping_country_code,NULL) country_code,
      IF(g.geography_status='valid',g.shipping_country_name,NULL) country_name
    FROM \`${project}.shopify_data.order_financials\` f
    JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
    JOIN \`${project}.shopify_data.order_customers\` c USING(order_id)
    LEFT JOIN geography g USING(order_id)
    WHERE l.retail_location_id IS NULL
      AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
      AND LOWER(c.display_financial_status) IN ('paid','partially_paid','partially_refunded')
      AND c.cancelled_at IS NULL
      AND DATE(f.created_at) BETWEEN DATE(@start_date) AND DATE(@end_date)
      AND (@currency IS NULL OR UPPER(f.presentment_currency)=UPPER(@currency))
  ), coverage AS (
    SELECT currency,COUNT(*) eligible_orders,COUNTIF(country_code IS NULL) unknown_country_orders,
      CAST(SUM(operational_net_sales) AS NUMERIC) eligible_sales,
      CAST(SUM(IF(country_code IS NULL,operational_net_sales,0)) AS NUMERIC) unknown_country_sales
    FROM eligible_orders GROUP BY currency
  ), country_totals AS (
    SELECT currency,country_code,ANY_VALUE(country_name) country_name,COUNT(*) orders,
      CAST(SUM(operational_net_sales) AS NUMERIC) operational_net_sales
    FROM eligible_orders WHERE country_code IS NOT NULL GROUP BY currency,country_code
  ), ranked_countries AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY currency ORDER BY operational_net_sales DESC,country_code) country_rank
    FROM country_totals
  ), top_countries AS (SELECT * FROM ranked_countries WHERE country_rank<=10),
  product_lines AS (
    SELECT o.currency,o.country_code,li.order_id,li.line_item_id,
      COALESCE(NULLIF(li.product_id,''),'unknown') source_product_id,
      COALESCE(NULLIF(li.title,''),NULLIF(li.name,''),'Unresolved product') source_product_title,
      li.variant_id,li.quantity units,CAST(li.discounted_total_presentment AS NUMERIC) product_sales
    FROM eligible_orders o JOIN top_countries tc USING(currency,country_code)
    JOIN \`${project}.shopify_data.order_line_items\` li USING(order_id)
    WHERE UPPER(li.presentment_currency)=o.currency
  ), product_totals AS (
    SELECT currency,country_code,source_product_id,ANY_VALUE(source_product_title) product_title,
      COUNT(DISTINCT order_id) product_orders,SUM(units) units,CAST(SUM(product_sales) AS NUMERIC) product_sales,
      COUNT(*) line_items,COUNT(DISTINCT variant_id) variant_count,
      IF(source_product_id='unknown','unresolved_source_product','stable_shopify_parent_product') product_grain_status
    FROM product_lines GROUP BY currency,country_code,source_product_id
  ), ranked_products AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY currency,country_code ORDER BY product_sales DESC,source_product_id) product_rank
    FROM product_totals
  )
  SELECT tc.currency,tc.country_rank,tc.country_code,tc.country_name,tc.orders country_orders,
    tc.operational_net_sales country_operational_net_sales,rp.product_rank,rp.source_product_id,rp.product_title,
    rp.product_orders,rp.units,rp.product_sales,rp.line_items,rp.variant_count,rp.product_grain_status,
    cv.eligible_orders,cv.unknown_country_orders,cv.eligible_sales,cv.unknown_country_sales,
    SAFE_DIVIDE(cv.unknown_country_orders,cv.eligible_orders) unknown_order_share,
    SAFE_DIVIDE(cv.unknown_country_sales,cv.eligible_sales) unknown_sales_share
  FROM top_countries tc JOIN coverage cv USING(currency)
  LEFT JOIN ranked_products rp ON rp.currency=tc.currency AND rp.country_code=tc.country_code AND rp.product_rank<=10
  ORDER BY currency,country_rank,product_rank LIMIT 1000`;
}

export function createShopifyCountryProductsService({ bigquery, project }) {
  if (!bigquery?.query || !project) throw new Error('bigquery and project are required');
  return async input => {
    const params = validateCountryProductInput(input);
    const [rows] = await bigquery.query({
      query: shopifyCountryProductsSql(project), params: { ...params, matrixify_app_id: MATRIXIFY_APP_ID },
      types: { currency: 'STRING' }, useLegacySql: false, maximumBytesBilled: '10000000000'
    });
    return {
      period: { start_date: params.start_date, end_date: params.end_date },
      currency_filter: params.currency,
      rows: JSON.parse(JSON.stringify(rows)),
      semantics: {
        country_rank: 'Top 10 valid direct shipping countries by order-level operational net sales, independently per presentment currency.',
        product_rank: 'Top 10 stable Shopify parent products within each returned country by discounted line sales; variants remain children.',
        refunds: 'Country operational net sales subtract persisted order refunds. Product sales use discounted line value because persisted refunds are not governed at product allocation grain.',
        unknown: 'Missing or invalid direct shipping country is reported in coverage and excluded from named-country rankings.',
        geography: 'Direct Shopify shipping address only; never inferred from billing, currency, market, IP, retail location, or POS.',
        currency: 'Source-native presentment currencies are partitioned and never converted or combined.',
        unresolved_products: 'Missing product IDs remain explicit as unknown / Unresolved product and are not merged with a named product.'
      },
      privacy: 'Aggregate-only and PII-free.'
    };
  };
}

export const SHOPIFY_COUNTRY_PRODUCTS_TOOL_DEFINITION = {
  type: 'function', name: 'get_shopify_online_country_products', strict: true,
  description: 'Use for “top locations/countries for online sales and top products in each” questions. Returns the top 10 direct Shopify shipping countries by operational net sales and top 10 products within each country, ranked separately by source-native presentment currency, with unknown-country coverage. This is the aggregate path; retain search_orders for bounded order examples.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    start_date: { type: 'string', description: 'Inclusive YYYY-MM-DD date.' },
    end_date: { type: 'string', description: 'Inclusive YYYY-MM-DD date.' },
    currency: { type: ['string','null'], description: 'Optional three-letter presentment currency; null returns separate rankings per currency.' }
  }, required: ['start_date','end_date','currency'] }
};
