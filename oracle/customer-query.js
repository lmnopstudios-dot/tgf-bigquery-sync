export const CUSTOMER_SEARCH_DEFAULT_LIMIT = 20;
export const CUSTOMER_SEARCH_MAX_LIMIT = 100;
export const CUSTOMER_HISTORY_MAX_LIMIT = 100;
export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLATFORMS = ['woo', 'shopify'];
const STORES = ['ww', 'usd', 'shopify'];
const MODES = ['population', 'new_vs_returning', 'lapsed', 'revenue_orders'];

function validDate(value, field, required = false) {
  if (value === null || value === undefined) {
    if (required) throw new Error(`${field} is required`);
    return;
  }
  if (typeof value !== 'string' || !DATE.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
}

function string(value, field, max = 200) {
  if (value !== null && value !== undefined &&
      (typeof value !== 'string' || !value.trim() || value.length > max)) {
    throw new Error(`${field} must be null or a non-empty string of at most ${max} characters`);
  }
}

function integer(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value !== null && value !== undefined &&
      (!Number.isInteger(value) || value < min || value > max)) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
}

function number(value, field) {
  if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${field} must be null or a non-negative number`);
  }
}

function clean(rows) { return rows.map(row => JSON.parse(JSON.stringify(row))); }

export function validateCustomerRef(customerRef) {
  if (typeof customerRef !== 'string' || !/^c_[0-9a-f]{64}$/.test(customerRef)) {
    throw new Error('customer_ref must be an exact governed opaque customer reference');
  }
  return customerRef;
}

export function validateCustomerSearch(input = {}) {
  const filters = { source_platform: null, source_store: null, first_purchase_start: null,
    first_purchase_end: null, latest_purchase_start: null, latest_purchase_end: null,
    minimum_order_count: null, maximum_order_count: null, repeat_customer: null,
    minimum_lifetime_value: null, maximum_lifetime_value: null, currency: null,
    purchased_product_id: null, purchased_sku: null, product_title: null,
    shipping_country: null, inactive_since: null, limit: CUSTOMER_SEARCH_DEFAULT_LIMIT, ...input };
  for (const field of ['first_purchase_start', 'first_purchase_end', 'latest_purchase_start',
    'latest_purchase_end', 'inactive_since']) validDate(filters[field], field);
  for (const [a, b] of [['first_purchase_start', 'first_purchase_end'], ['latest_purchase_start', 'latest_purchase_end']]) {
    if (filters[a] && filters[b] && filters[a] > filters[b]) throw new Error(`${a} must be on or before ${b}`);
  }
  if (filters.source_platform !== null && !PLATFORMS.includes(filters.source_platform)) throw new Error('source_platform must be null, woo, or shopify');
  if (filters.source_store !== null && !STORES.includes(filters.source_store)) throw new Error('source_store must be null, ww, usd, or shopify');
  if (filters.repeat_customer !== null && typeof filters.repeat_customer !== 'boolean') throw new Error('repeat_customer must be null or boolean');
  integer(filters.minimum_order_count, 'minimum_order_count'); integer(filters.maximum_order_count, 'maximum_order_count');
  if (filters.minimum_order_count !== null && filters.maximum_order_count !== null && filters.minimum_order_count > filters.maximum_order_count) throw new Error('minimum_order_count must not exceed maximum_order_count');
  number(filters.minimum_lifetime_value, 'minimum_lifetime_value'); number(filters.maximum_lifetime_value, 'maximum_lifetime_value');
  if (filters.minimum_lifetime_value !== null && filters.maximum_lifetime_value !== null && filters.minimum_lifetime_value > filters.maximum_lifetime_value) throw new Error('minimum_lifetime_value must not exceed maximum_lifetime_value');
  for (const field of ['currency', 'purchased_product_id', 'purchased_sku', 'product_title', 'shipping_country']) string(filters[field], field);
  if (filters.currency && !/^[A-Za-z]{3}$/.test(filters.currency)) throw new Error('currency must be a three-letter currency code');
  if (filters.shipping_country && !/^[A-Za-z]{2}$/.test(filters.shipping_country)) throw new Error('shipping_country must be a two-letter country code');
  integer(filters.limit, 'limit', { min: 1, max: CUSTOMER_SEARCH_MAX_LIMIT });
  return filters;
}

// This query is intentionally a view-like CTE rather than a persisted customer table:
// it keeps PII and reversible source IDs out of a new object while using current governed sources.
export function customerEvidenceSql(project) {
  return `WITH order_evidence AS (
    SELECT 'woo' source_platform, 'ww' source_store, CAST(o.order_id AS STRING) source_order_id,
      CAST(o.customer_id AS STRING) source_customer_id, DATE(o.order_created_at) order_date,
      LOWER(o.status) status, UPPER(o.currency) currency, o.total source_order_value,
      ABS(COALESCE(o.total_refunds, 0)) source_refund_value,
      g.shipping_country_iso2 shipping_country, FALSE is_migrated_order
    FROM \`${project}.metorik_uk.orders\` o LEFT JOIN \`${project}.commerce.order_geography\` g
      ON g.source_store = 'ww' AND g.source_order_id = CAST(o.order_id AS STRING)
    UNION ALL
    SELECT 'woo', 'usd', CAST(o.order_id AS STRING), CAST(o.customer_id AS STRING), DATE(o.order_created_at),
      LOWER(o.status), UPPER(o.currency), o.total, ABS(COALESCE(o.total_refunds, 0)), g.shipping_country_iso2, FALSE
    FROM \`${project}.metorik_us.orders\` o LEFT JOIN \`${project}.commerce.order_geography\` g
      ON g.source_store = 'usd' AND g.source_order_id = CAST(o.order_id AS STRING)
    UNION ALL
    SELECT 'shopify', 'shopify', l.order_id, c.customer_id, DATE(l.created_at),
      LOWER(c.display_financial_status), UPPER(f.shop_currency), f.original_total_shop,
      COALESCE(f.total_refunded_shop, 0), CAST(NULL AS STRING), l.source_app_id = @matrixify_app_id
    FROM \`${project}.shopify_data.order_locations\` l
    LEFT JOIN \`${project}.shopify_data.order_customers\` c USING(order_id)
    LEFT JOIN \`${project}.shopify_data.order_financials\` f USING(order_id)
  ), qualifying_orders AS (
    SELECT source_platform, source_store, source_order_id, source_customer_id, order_date, status,
      currency, source_order_value, source_refund_value, shipping_country, is_migrated_order,
      CONCAT('c_', TO_HEX(SHA256(CONCAT(source_platform, '|', source_store, '|', source_customer_id)))) customer_ref
    FROM order_evidence
    WHERE source_customer_id IS NOT NULL AND source_customer_id NOT IN ('', '0') AND NOT is_migrated_order
      AND ((source_platform = 'woo' AND status IN ('completed', 'processing'))
        OR (source_platform = 'shopify' AND status IN ('paid', 'partially_refunded', 'partially_paid')))
      AND COALESCE(source_order_value, 0) > COALESCE(source_refund_value, 0)
  ), line_evidence AS (
    SELECT 'woo' source_platform, 'ww' source_store, CAST(order_id AS STRING) source_order_id,
      CAST(product_id AS STRING) product_id, sku, name product_title
    FROM \`${project}.metorik_uk.order_line_items\`
    UNION ALL SELECT 'woo', 'usd', CAST(order_id AS STRING), CAST(product_id AS STRING), sku, name
    FROM \`${project}.metorik_us.order_line_items\`
    UNION ALL SELECT 'shopify', 'shopify', order_id, product_id, sku, title
    FROM \`${project}.shopify_data.order_line_items\`
  ), customer_currency AS (
    SELECT customer_ref, currency, SUM(source_order_value) source_native_lifetime_order_value,
      SUM(source_refund_value) source_native_lifetime_refund_value
    FROM qualifying_orders GROUP BY customer_ref, currency
  ), customer_rollup AS (
    SELECT customer_ref, ANY_VALUE(source_platform) source_platform, ANY_VALUE(source_store) source_store,
      MIN(order_date) first_observed_purchase_date, MAX(order_date) latest_observed_purchase_date,
      COUNT(DISTINCT source_order_id) qualifying_order_count,
      COUNT(DISTINCT source_order_id) >= 2 repeat_customer,
      ARRAY_AGG(DISTINCT currency IGNORE NULLS ORDER BY currency) currencies,
      ARRAY_AGG(DISTINCT shipping_country IGNORE NULLS ORDER BY shipping_country) observed_shipping_countries
    FROM qualifying_orders GROUP BY customer_ref
  )`;
}

function searchSql(project, f) {
  const lineFilter = f.purchased_product_id || f.purchased_sku || f.product_title;
  const clauses = [f.source_platform && 'c.source_platform = @source_platform', f.source_store && 'c.source_store = @source_store',
    f.first_purchase_start && 'c.first_observed_purchase_date >= DATE(@first_purchase_start)', f.first_purchase_end && 'c.first_observed_purchase_date <= DATE(@first_purchase_end)',
    f.latest_purchase_start && 'c.latest_observed_purchase_date >= DATE(@latest_purchase_start)', f.latest_purchase_end && 'c.latest_observed_purchase_date <= DATE(@latest_purchase_end)',
    f.minimum_order_count !== null && 'c.qualifying_order_count >= @minimum_order_count', f.maximum_order_count !== null && 'c.qualifying_order_count <= @maximum_order_count',
    f.repeat_customer !== null && 'c.repeat_customer = @repeat_customer', f.inactive_since && 'c.latest_observed_purchase_date < DATE(@inactive_since)',
    f.shipping_country && 'UPPER(@shipping_country) IN UNNEST(c.observed_shipping_countries)',
    (f.currency || f.minimum_lifetime_value !== null || f.maximum_lifetime_value !== null) && `EXISTS (SELECT 1 FROM customer_currency v WHERE v.customer_ref = c.customer_ref
      ${f.currency ? 'AND v.currency = UPPER(@currency)' : ''} ${f.minimum_lifetime_value !== null ? 'AND v.source_native_lifetime_order_value >= @minimum_lifetime_value' : ''}
      ${f.maximum_lifetime_value !== null ? 'AND v.source_native_lifetime_order_value <= @maximum_lifetime_value' : ''})`,
    lineFilter && `EXISTS (SELECT 1 FROM qualifying_orders q JOIN line_evidence li USING(source_platform, source_store, source_order_id)
      WHERE q.customer_ref = c.customer_ref ${f.purchased_product_id ? 'AND li.product_id = @purchased_product_id' : ''}
      ${f.purchased_sku ? 'AND LOWER(li.sku) = LOWER(@purchased_sku)' : ''} ${f.product_title ? "AND LOWER(li.product_title) LIKE CONCAT('%', LOWER(@product_title), '%')" : ''})`
  ].filter(Boolean);
  return `${customerEvidenceSql(project)}, matched AS (SELECT c.customer_ref, c.source_platform, c.source_store,
    c.first_observed_purchase_date, c.latest_observed_purchase_date, c.qualifying_order_count, c.repeat_customer,
    c.currencies, c.observed_shipping_countries FROM customer_rollup c WHERE ${clauses.length ? clauses.join(' AND ') : 'TRUE'})
    SELECT c.customer_ref, c.source_platform, c.source_store, c.first_observed_purchase_date,
      c.latest_observed_purchase_date, c.qualifying_order_count, c.repeat_customer, c.currencies,
      c.observed_shipping_countries,
      ARRAY(SELECT AS STRUCT v.currency, v.source_native_lifetime_order_value, v.source_native_lifetime_refund_value
        FROM customer_currency v WHERE v.customer_ref = c.customer_ref ORDER BY v.currency) source_native_values_by_currency,
      COUNT(*) OVER() matching_customer_count
    FROM matched c ORDER BY c.qualifying_order_count DESC, c.latest_observed_purchase_date DESC, c.customer_ref LIMIT @limit`;
}

function baseParams(input) { return Object.fromEntries(Object.entries({ ...input, matrixify_app_id: MATRIXIFY_APP_ID }).filter(([, v]) => v !== null && v !== undefined)); }

export function createCustomerQueryService({ bigquery, project }) {
  if (!bigquery?.query || !project) throw new Error('bigquery and project are required');
  async function searchCustomers(input = {}) {
    const filters = validateCustomerSearch(input); const params = baseParams(filters);
    const [rows] = await bigquery.query({ query: searchSql(project, filters), params });
    return { customers: clean(rows), matching_customer_count: Number(rows[0]?.matching_customer_count || 0), returned_customer_count: rows.length,
      limit: filters.limit, identity_semantics: IDENTITY_SEMANTICS, monetary_semantics: MONEY_SEMANTICS,
      geography_warning: filters.shipping_country ? GEOGRAPHY_WARNING : null };
  }
  async function getCustomerHistory({ customer_ref, limit = 50, order = 'descending' }) {
    validateCustomerRef(customer_ref); integer(limit, 'limit', { min: 1, max: CUSTOMER_HISTORY_MAX_LIMIT });
    if (!['ascending', 'descending'].includes(order)) throw new Error('order must be ascending or descending');
    const [rows] = await bigquery.query({ query: `${customerEvidenceSql(project)} SELECT q.customer_ref, q.source_platform, q.source_store,
      q.source_order_id, q.order_date, q.status, q.currency, q.source_order_value, q.source_refund_value,
      q.shipping_country, ARRAY_AGG(STRUCT(li.product_id, li.sku, li.product_title) ORDER BY li.product_title LIMIT 100) products
      FROM qualifying_orders q LEFT JOIN line_evidence li USING(source_platform, source_store, source_order_id)
      WHERE q.customer_ref = @customer_ref GROUP BY q.customer_ref, q.source_platform, q.source_store, q.source_order_id,
      q.order_date, q.status, q.currency, q.source_order_value, q.source_refund_value, q.shipping_country
      ORDER BY q.order_date ${order === 'ascending' ? 'ASC' : 'DESC'}, q.source_order_id ${order === 'ascending' ? 'ASC' : 'DESC'} LIMIT @limit`,
      params: baseParams({ customer_ref, limit }) });
    return { customer_ref, orders: clean(rows), returned_order_count: rows.length, limit, identity_semantics: IDENTITY_SEMANTICS, privacy: PRIVACY };
  }
  async function getCustomerSummary({ customer_ref }) {
    validateCustomerRef(customer_ref);
    const [rows] = await bigquery.query({ query: `${customerEvidenceSql(project)} SELECT c.customer_ref, c.source_platform, c.source_store,
      c.first_observed_purchase_date, c.latest_observed_purchase_date, DATE_DIFF(c.latest_observed_purchase_date, c.first_observed_purchase_date, DAY) observed_active_span_days,
      c.qualifying_order_count, c.repeat_customer, c.currencies, c.observed_shipping_countries,
      ARRAY(SELECT AS STRUCT v.currency, v.source_native_lifetime_order_value, v.source_native_lifetime_refund_value FROM customer_currency v WHERE v.customer_ref = c.customer_ref ORDER BY currency) source_native_values_by_currency,
      ARRAY(SELECT AS STRUCT li.product_id, li.sku, ANY_VALUE(li.product_title) product_title, COUNT(DISTINCT q.source_order_id) order_count
        FROM qualifying_orders q JOIN line_evidence li USING(source_platform, source_store, source_order_id) WHERE q.customer_ref = c.customer_ref
        GROUP BY li.product_id, li.sku ORDER BY order_count DESC, product_title LIMIT 50) products
      FROM customer_rollup c WHERE c.customer_ref = @customer_ref LIMIT 1`, params: baseParams({ customer_ref }) });
    return { found: rows.length === 1, customer: clean(rows)[0] || null, identity_semantics: IDENTITY_SEMANTICS, monetary_semantics: MONEY_SEMANTICS, privacy: PRIVACY };
  }
  async function getCustomerMetrics({ mode, start_date, end_date, source_store = null, minimum_order_count = null, inactive_since = null }) {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of ${MODES.join(', ')}`);
    validDate(start_date, 'start_date', true); validDate(end_date, 'end_date', true); if (start_date > end_date) throw new Error('start_date must be on or before end_date');
    validDate(inactive_since, 'inactive_since'); integer(minimum_order_count, 'minimum_order_count');
    if (source_store !== null && !STORES.includes(source_store)) throw new Error('invalid source_store');
    const [rows] = await bigquery.query({ query: `${customerEvidenceSql(project)}, scoped AS (
      SELECT q.source_platform, q.source_store, q.source_order_id, q.source_customer_id, q.order_date, q.status,
        q.currency, q.source_order_value, q.source_refund_value, q.shipping_country, q.customer_ref,
        ROW_NUMBER() OVER(PARTITION BY customer_ref ORDER BY order_date, source_order_id) observed_order_number
      FROM qualifying_orders q WHERE (@source_store IS NULL OR source_store = @source_store)), period AS (
      SELECT source_platform, source_store, source_order_id, source_customer_id, order_date, status, currency,
        source_order_value, source_refund_value, shipping_country, customer_ref, observed_order_number
      FROM scoped WHERE order_date BETWEEN DATE(@start_date) AND DATE(@end_date))
      SELECT COUNT(DISTINCT customer_ref) customer_count,
        COUNT(DISTINCT IF(observed_order_number >= 2, customer_ref, NULL)) returning_customer_count,
        COUNT(DISTINCT IF(observed_order_number = 1, customer_ref, NULL)) new_customer_count,
        COUNT(DISTINCT IF(customer_ref IN (SELECT customer_ref FROM customer_rollup WHERE repeat_customer), customer_ref, NULL)) repeat_customer_count,
        ROUND(100 * SAFE_DIVIDE(COUNT(DISTINCT IF(customer_ref IN (SELECT customer_ref FROM customer_rollup WHERE repeat_customer), customer_ref, NULL)), COUNT(DISTINCT customer_ref)), 2) repeat_customer_rate_percentage,
        COUNT(DISTINCT source_order_id) qualifying_order_count,
        ARRAY_AGG(DISTINCT STRUCT(currency, currency_order_value, currency_order_count) ORDER BY currency) source_native_values_by_currency
      FROM (SELECT p.source_platform, p.source_store, p.source_order_id, p.source_customer_id, p.order_date, p.status,
        p.currency, p.source_order_value, p.source_refund_value, p.shipping_country, p.customer_ref, p.observed_order_number,
        SUM(source_order_value) OVER(PARTITION BY currency) currency_order_value, COUNT(*) OVER(PARTITION BY currency) currency_order_count
        FROM period p WHERE (@inactive_since IS NULL OR customer_ref IN (SELECT customer_ref FROM customer_rollup WHERE latest_observed_purchase_date < DATE(@inactive_since)
          AND qualifying_order_count >= COALESCE(@minimum_order_count, 0))))`, params: { start_date, end_date, source_store, inactive_since, minimum_order_count, matrixify_app_id: MATRIXIFY_APP_ID },
      types: { source_store: 'STRING', inactive_since: 'STRING', minimum_order_count: 'INT64' } });
    return { mode, start_date, end_date, source_store, ...(clean(rows)[0] || {}), definition: REPEAT_DEFINITION, identity_semantics: IDENTITY_SEMANTICS, monetary_semantics: MONEY_SEMANTICS };
  }
  async function getCustomerCohort({ cohort_start, cohort_end, return_start, return_end, source_store = null }) {
    for (const f of ['cohort_start', 'cohort_end', 'return_start', 'return_end']) validDate(arguments[0][f], f, true);
    if (cohort_start > cohort_end || return_start > return_end) throw new Error('date ranges must be ordered');
    if (source_store !== null && !STORES.includes(source_store)) throw new Error('invalid source_store');
    const [rows] = await bigquery.query({ query: `${customerEvidenceSql(project)}, cohort AS (SELECT customer_ref, source_store, first_observed_purchase_date FROM customer_rollup
      WHERE first_observed_purchase_date BETWEEN DATE(@cohort_start) AND DATE(@cohort_end) AND (@source_store IS NULL OR source_store = @source_store))
      SELECT COUNT(*) cohort_customer_count, COUNTIF(EXISTS(SELECT 1 FROM qualifying_orders q WHERE q.customer_ref = c.customer_ref
        AND q.order_date BETWEEN DATE(@return_start) AND DATE(@return_end) AND q.order_date > c.first_observed_purchase_date)) returned_customer_count,
        ROUND(100 * SAFE_DIVIDE(COUNTIF(EXISTS(SELECT 1 FROM qualifying_orders q WHERE q.customer_ref = c.customer_ref
          AND q.order_date BETWEEN DATE(@return_start) AND DATE(@return_end) AND q.order_date > c.first_observed_purchase_date)), COUNT(*)), 2) returned_customer_percentage
      FROM cohort c`, params: { cohort_start, cohort_end, return_start, return_end, source_store, matrixify_app_id: MATRIXIFY_APP_ID }, types: { source_store: 'STRING' } });
    return { ...(clean(rows)[0] || {}), cohort_start, cohort_end, return_start, return_end, denominator: 'Governed identified customers whose first observed qualifying purchase is in the cohort range; unresolved guest orders are excluded.', observed_history_warning: OBSERVED_WARNING };
  }
  async function getFirstToSecondPurchaseTiming({ start_date, end_date, source_store = null }) {
    validDate(start_date, 'start_date', true); validDate(end_date, 'end_date', true); if (start_date > end_date) throw new Error('date range must be ordered');
    if (source_store !== null && !STORES.includes(source_store)) throw new Error('invalid source_store');
    const [rows] = await bigquery.query({ query: `${customerEvidenceSql(project)}, ranked AS (SELECT customer_ref, source_store, order_date,
      ROW_NUMBER() OVER(PARTITION BY customer_ref ORDER BY order_date, source_order_id) n FROM qualifying_orders), gaps AS (
      SELECT customer_ref, DATE_DIFF(MAX(IF(n=2, order_date, NULL)), MAX(IF(n=1, order_date, NULL)), DAY) days_to_second
      FROM ranked WHERE (@source_store IS NULL OR source_store=@source_store) GROUP BY customer_ref
      HAVING MAX(IF(n=1, order_date, NULL)) BETWEEN DATE(@start_date) AND DATE(@end_date) AND MAX(n)>=2)
      SELECT COUNT(*) customer_count, APPROX_QUANTILES(days_to_second, 100)[OFFSET(50)] median_days,
        ROUND(AVG(days_to_second), 2) average_days, APPROX_QUANTILES(days_to_second, 100)[OFFSET(25)] p25_days,
        APPROX_QUANTILES(days_to_second, 100)[OFFSET(75)] p75_days FROM gaps`, params: { start_date, end_date, source_store, matrixify_app_id: MATRIXIFY_APP_ID }, types: { source_store: 'STRING' } });
    return { ...(clean(rows)[0] || {}), start_date, end_date, definition: REPEAT_DEFINITION, observed_history_warning: OBSERVED_WARNING };
  }
  async function getProductPurchaseSequence({ product_id = null, sku = null, product_title = null, source_store = null, limit = 20 }) {
    for (const [v, f] of [[product_id, 'product_id'], [sku, 'sku'], [product_title, 'product_title']]) string(v, f);
    if (![product_id, sku, product_title].some(Boolean)) throw new Error('one product selector is required');
    if (source_store !== null && !STORES.includes(source_store)) throw new Error('invalid source_store'); integer(limit, 'limit', { min: 1, max: 100 });
    const [rows] = await bigquery.query({ query: `${customerEvidenceSql(project)}, ranked AS (SELECT q.source_platform,
      q.source_store, q.source_order_id, q.source_customer_id, q.order_date, q.status, q.currency,
      q.source_order_value, q.source_refund_value, q.shipping_country, q.customer_ref,
      DENSE_RANK() OVER(PARTITION BY q.customer_ref ORDER BY q.order_date, q.source_order_id) order_rank FROM qualifying_orders q), seed AS (
      SELECT r.customer_ref, MIN(r.order_rank) seed_rank FROM ranked r JOIN line_evidence li USING(source_platform,source_store,source_order_id)
      WHERE (@source_store IS NULL OR r.source_store=@source_store) AND (@product_id IS NULL OR li.product_id=@product_id)
        AND (@sku IS NULL OR LOWER(li.sku)=LOWER(@sku)) AND (@product_title IS NULL OR LOWER(li.product_title) LIKE CONCAT('%',LOWER(@product_title),'%')) GROUP BY r.customer_ref), next_products AS (
      SELECT li.product_id, li.sku, ANY_VALUE(li.product_title) product_title, COUNT(DISTINCT r.customer_ref) customer_count
      FROM seed s JOIN ranked r ON r.customer_ref=s.customer_ref AND r.order_rank=s.seed_rank+1
      JOIN line_evidence li USING(source_platform,source_store,source_order_id) GROUP BY li.product_id,li.sku)
      SELECT product_id, sku, product_title, customer_count, SUM(customer_count) OVER() next_product_customer_rows FROM next_products
      ORDER BY customer_count DESC, product_title, product_id LIMIT @limit`, params: { product_id, sku, product_title, source_store, limit, matrixify_app_id: MATRIXIFY_APP_ID },
      types: { product_id: 'STRING', sku: 'STRING', product_title: 'STRING', source_store: 'STRING' } });
    return { next_observed_order_products: clean(rows), returned_product_count: rows.length, limit,
      semantics: 'Observed sequence only: products are on the next qualifying observed order after the first matching order; this is association, not causation.', observed_history_warning: OBSERVED_WARNING };
  }
  return { searchCustomers, getCustomerHistory, getCustomerSummary, getCustomerMetrics, getCustomerCohort, getFirstToSecondPurchaseTiming, getProductPurchaseSequence };
}

export const REPEAT_DEFINITION = 'At least two distinct qualifying observed orders for one source-qualified, non-guest customer. Woo completed/processing and Shopify paid/partially_paid/partially_refunded count; cancelled, failed, pending, fully refunded, zero-value, and Matrixify-imported Shopify representations do not.';
export const IDENTITY_SEMANTICS = 'Opaque customer_ref hashes source platform + governed store + stable source customer ID. WW, USD, and Shopify namespaces never merge; no cross-platform identity resolution is asserted. Unresolved guests are excluded.';
export const MONEY_SEMANTICS = 'Operational source-native order values are grouped by currency and are not canonical finance or cross-currency LTV. Canonical finance remains authoritative for company financial reporting.';
export const OBSERVED_WARNING = 'First means first observed qualifying purchase in available source history, not guaranteed lifetime acquisition.';
export const GEOGRAPHY_WARNING = 'Country uses directly observed commerce.order_geography evidence only. Unresolved geography is not estimated and coverage is incomplete.';
export const PRIVACY = 'No name, email, phone, street address, postcode, city, payment information, notes, marketing content, source customer ID, or raw payload is returned.';

const nullableString = { type: ['string', 'null'] };
export const CUSTOMER_TOOL_DEFINITIONS = [
  { type: 'function', name: 'search_customers', strict: true, description: 'Search a bounded pseudonymous governed customer population. Returns a total match count and at most 100 safe summaries.', parameters: { type: 'object', additionalProperties: false, properties: {
    source_platform: { type: ['string','null'], enum: ['woo','shopify',null] }, source_store: { type: ['string','null'], enum: ['ww','usd','shopify',null] },
    first_purchase_start: nullableString, first_purchase_end: nullableString, latest_purchase_start: nullableString, latest_purchase_end: nullableString,
    minimum_order_count: { type: ['integer','null'], minimum: 0 }, maximum_order_count: { type: ['integer','null'], minimum: 0 }, repeat_customer: { type: ['boolean','null'] },
    minimum_lifetime_value: { type: ['number','null'], minimum: 0 }, maximum_lifetime_value: { type: ['number','null'], minimum: 0 }, currency: nullableString,
    purchased_product_id: nullableString, purchased_sku: nullableString, product_title: nullableString, shipping_country: nullableString, inactive_since: nullableString,
    limit: { type: 'integer', minimum: 1, maximum: 100 }
  }, required: ['source_platform','source_store','first_purchase_start','first_purchase_end','latest_purchase_start','latest_purchase_end','minimum_order_count','maximum_order_count','repeat_customer','minimum_lifetime_value','maximum_lifetime_value','currency','purchased_product_id','purchased_sku','product_title','shipping_country','inactive_since','limit'] } },
  { type: 'function', name: 'get_customer_history', strict: true, description: 'Get bounded purchase history for one exact opaque customer_ref without PII.', parameters: { type:'object', additionalProperties:false, properties:{ customer_ref:{type:'string'}, limit:{type:'integer',minimum:1,maximum:100}, order:{type:'string',enum:['ascending','descending']} }, required:['customer_ref','limit','order'] } },
  { type: 'function', name: 'get_customer_summary', strict: true, description: 'Get a safe aggregate and product summary for one exact opaque customer_ref.', parameters: { type:'object', additionalProperties:false, properties:{customer_ref:{type:'string'}}, required:['customer_ref'] } },
  { type: 'function', name: 'get_customer_metrics', strict: true, description: 'Get controlled customer population, new/returning, lapsed, repeat, order, and source-native value metrics for an explicit period.', parameters:{type:'object',additionalProperties:false,properties:{mode:{type:'string',enum:MODES},start_date:{type:'string'},end_date:{type:'string'},source_store:{type:['string','null'],enum:['ww','usd','shopify',null]},minimum_order_count:{type:['integer','null'],minimum:0},inactive_since:nullableString},required:['mode','start_date','end_date','source_store','minimum_order_count','inactive_since']} },
  { type: 'function', name: 'get_customer_cohort', strict: true, description: 'Measure identified customers first observed in one period who purchased again in a later period.', parameters:{type:'object',additionalProperties:false,properties:{cohort_start:{type:'string'},cohort_end:{type:'string'},return_start:{type:'string'},return_end:{type:'string'},source_store:{type:['string','null'],enum:['ww','usd','shopify',null]}},required:['cohort_start','cohort_end','return_start','return_end','source_store']} },
  { type: 'function', name: 'get_first_to_second_purchase_timing', strict: true, description: 'Return count, median, mean, p25 and p75 days from first to second qualifying observed purchase.', parameters:{type:'object',additionalProperties:false,properties:{start_date:{type:'string'},end_date:{type:'string'},source_store:{type:['string','null'],enum:['ww','usd','shopify',null]}},required:['start_date','end_date','source_store']} },
  { type: 'function', name: 'get_product_purchase_sequence', strict: true, description: 'Aggregate products on the next observed qualifying order after a controlled product/SKU/title match; association only.', parameters:{type:'object',additionalProperties:false,properties:{product_id:nullableString,sku:nullableString,product_title:nullableString,source_store:{type:['string','null'],enum:['ww','usd','shopify',null]},limit:{type:'integer',minimum:1,maximum:100}},required:['product_id','sku','product_title','source_store','limit']} }
];

export function safeCustomerToolCallDiagnostic(name, args = {}) {
  return { tool: name, customer_ref: args.customer_ref || null,
    populated_filters: Object.keys(args).filter(k => args[k] !== null && args[k] !== undefined && k !== 'customer_ref') };
}

export async function executeCustomerToolCall(service, name, args, onDiagnostic = () => {}) {
  const methods = { search_customers:'searchCustomers', get_customer_history:'getCustomerHistory', get_customer_summary:'getCustomerSummary',
    get_customer_metrics:'getCustomerMetrics', get_customer_cohort:'getCustomerCohort', get_first_to_second_purchase_timing:'getFirstToSecondPurchaseTiming', get_product_purchase_sequence:'getProductPurchaseSequence' };
  if (!methods[name]) return { handled:false, result:null };
  onDiagnostic(safeCustomerToolCallDiagnostic(name,args)); return { handled:true, result:await service[methods[name]](args) };
}

export function assertCustomerQuerySafety() {
  const definitions = JSON.stringify(CUSTOMER_TOOL_DEFINITIONS).toLowerCase();
  for (const forbidden of ['email','phone','postcode','address','raw_json','customer_id']) if (definitions.includes(forbidden)) throw new Error(`PII field exposed: ${forbidden}`);
  const sql = customerEvidenceSql('project') + searchSql('project', validateCustomerSearch({}));
  if (/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|EXPORT)\b/i.test(sql) || /SELECT\s+\*/i.test(sql)) throw new Error('unsafe customer SQL');
  if (!sql.includes('@matrixify_app_id') || !sql.includes("source_customer_id NOT IN ('', '0')")) throw new Error('missing migration or guest controls');
  return { valid:true, maximum_search_limit:CUSTOMER_SEARCH_MAX_LIMIT, maximum_history_limit:CUSTOMER_HISTORY_MAX_LIMIT, tools:CUSTOMER_TOOL_DEFINITIONS.length };
}
