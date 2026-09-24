export const ORDER_SEARCH_DEFAULT_LIMIT = 20;
export const ORDER_SEARCH_MAX_LIMIT = 100;
export const ORDER_LINE_ITEM_MAX_LIMIT = 100;
export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = ['woo', 'shopify'];
const STORES = ['ww', 'usd', 'shopify'];
const CHANNELS = ['online', 'pos'];
const EU_STATUSES = ['eu', 'non_eu'];
const SEARCH_FILTER_FIELDS = [
  'start_date', 'end_date', 'source_platform', 'source_store', 'channel', 'order_number', 'source_order_id',
  'status', 'currency', 'minimum_order_value', 'maximum_order_value', 'shipping_country', 'eu_status',
  'product_id', 'product_title', 'sku', 'location', 'refund_status', 'customer_id'
];

function date(value, field) {
  if (value === null) return;
  if (typeof value !== 'string' || !DATE.test(value) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be null or a valid YYYY-MM-DD date`);
  }
}

function optionalString(value, field, max = 200) {
  if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > max)) {
    throw new Error(`${field} must be null or a non-empty string of at most ${max} characters`);
  }
}

function validateIdentity(identity) {
  if (!identity || !SOURCES.includes(identity.source_platform)) {
    throw new Error('identity.source_platform must be woo or shopify');
  }
  optionalString(identity.source_order_id, 'identity.source_order_id');
  if (identity.source_order_id === null) throw new Error('identity.source_order_id is required');
  if (identity.source_platform === 'woo' && !['ww', 'usd'].includes(identity.source_store)) {
    throw new Error('identity.source_store must be ww or usd for Woo identities');
  }
  if (identity.source_platform === 'shopify' && identity.source_store !== 'shopify') {
    throw new Error('identity.source_store must be shopify for Shopify identities');
  }
}

function cleanRows(rows) {
  return rows.map(row => JSON.parse(JSON.stringify(row)));
}

// Human-facing order numbers are not source identities.  Normalize only the
// bounded wrappers users commonly add; do not remove arbitrary punctuation or
// perform substring/fuzzy matching.
export function normalizeOrderNumber(value) {
  if (value === null || value === undefined) return null;
  const unwrapped = value.trim().replace(/^order\s+/i, '').trim();
  const bare = unwrapped.startsWith('#') ? unwrapped.slice(1).trim() : unwrapped;
  if (!bare || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(bare)) {
    throw new Error('order_number must be an exact number/name optionally prefixed by "order" and/or "#"');
  }
  return { supplied: value, bare, prefixed: `#${bare}` };
}

export function validateSearchFilters(input = {}) {
  const defaults = {
    start_date: null, end_date: null, source_platform: null, source_store: null, channel: null,
    order_number: null, source_order_id: null, status: null, currency: null,
    minimum_order_value: null, maximum_order_value: null, shipping_country: null,
    eu_status: null,
    product_id: null, product_title: null, sku: null, location: null,
    refund_status: null, customer_id: null, limit: ORDER_SEARCH_DEFAULT_LIMIT,
  };
  // Treat undefined exactly like an omitted optional property. Strict tool calls
  // normally use null, but direct callers should have identical semantics.
  const filters = { ...defaults, ...Object.fromEntries(Object.entries(input)
    .filter(([, value]) => value !== undefined)) };
  date(filters.start_date, 'start_date');
  date(filters.end_date, 'end_date');
  if (filters.start_date && filters.end_date && filters.start_date > filters.end_date) {
    throw new Error('start_date must be on or before end_date');
  }
  if (filters.source_platform !== null && !SOURCES.includes(filters.source_platform)) {
    throw new Error('source_platform must be null, woo, or shopify');
  }
  if (filters.source_store !== null && !STORES.includes(filters.source_store)) {
    throw new Error('source_store must be null, ww, usd, or shopify');
  }
  if (filters.channel !== null && !CHANNELS.includes(filters.channel)) {
    throw new Error('channel must be null, online, or pos');
  }
  for (const field of ['order_number', 'source_order_id', 'status', 'currency', 'shipping_country',
    'product_id', 'product_title', 'sku', 'location', 'customer_id']) {
    optionalString(filters[field], field);
  }
  if (filters.currency !== null && !/^[A-Za-z]{3}$/.test(filters.currency)) {
    throw new Error('currency must be a three-letter currency code');
  }
  if (filters.shipping_country !== null && !/^[A-Za-z]{2}$/.test(filters.shipping_country)) {
    throw new Error('shipping_country must be a two-letter country code');
  }
  if (filters.eu_status !== null && !EU_STATUSES.includes(filters.eu_status)) {
    throw new Error('eu_status must be null, eu, or non_eu');
  }
  if (![null, 'any', 'refunded', 'none', 'partial', 'full'].includes(filters.refund_status)) {
    throw new Error('refund_status must be null, any, refunded, none, partial, or full');
  }
  for (const field of ['minimum_order_value', 'maximum_order_value']) {
    if (filters[field] !== null && (!Number.isFinite(filters[field]) || filters[field] < 0)) {
      throw new Error(`${field} must be null or a non-negative number`);
    }
  }
  if (filters.minimum_order_value !== null && filters.maximum_order_value !== null &&
      filters.minimum_order_value > filters.maximum_order_value) {
    throw new Error('minimum_order_value must not exceed maximum_order_value');
  }
  if (!Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > ORDER_SEARCH_MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${ORDER_SEARCH_MAX_LIMIT}`);
  }
  if (filters.order_number !== null) normalizeOrderNumber(filters.order_number);
  return filters;
}

function isAppliedSearchFilter(field, value) {
  if (value === null || value === undefined) return false;
  if (field === 'refund_status' && value === 'any') return false;
  return true;
}

export function searchFilterSemantics(input = {}) {
  const filters = validateSearchFilters(input);
  return {
    filters,
    supplied: SEARCH_FILTER_FIELDS.filter(field =>
      Object.hasOwn(input, field) && input[field] !== null && input[field] !== undefined),
    applied: SEARCH_FILTER_FIELDS.filter(field => isAppliedSearchFilter(field, filters[field]))
  };
}

function searchSql(project, filters) {
  const productFilter = filters.product_id || filters.product_title || filters.sku;
  const clauses = [
    filters.start_date && 'order_date >= DATE(@start_date)',
    filters.end_date && 'order_date <= DATE(@end_date)',
    filters.source_platform && 'source_platform = @source_platform',
    filters.source_store && 'source_store = @source_store',
    filters.channel && 'channel = @channel',
    filters.order_number && `(
      LOWER(source_order_number) IN (LOWER(@order_number_bare), LOWER(@order_number_prefixed))
      OR LOWER(source_order_name) IN (LOWER(@order_number_bare), LOWER(@order_number_prefixed))
    )`,
    filters.source_order_id && 'source_order_id = @source_order_id',
    filters.status && 'LOWER(status) = LOWER(@status)',
    filters.currency && 'currency = UPPER(@currency)',
    filters.minimum_order_value !== null && 'source_order_total >= @minimum_order_value',
    filters.maximum_order_value !== null && 'source_order_total <= @maximum_order_value',
    filters.shipping_country && 'shipping_country = UPPER(@shipping_country)',
    filters.eu_status && 'source_platform = \'shopify\' AND shipping_geography_status = \'valid\' AND eu_status = @eu_status',
    filters.location && 'LOWER(COALESCE(location, \'\')) = LOWER(@location)',
    filters.refund_status === 'refunded' && 'source_refund_total > 0',
    filters.refund_status === 'none' && 'source_refund_total = 0',
    filters.refund_status === 'partial' && 'source_refund_total > 0 AND source_refund_total < source_order_total',
    filters.refund_status === 'full' && 'source_refund_total >= source_order_total',
    filters.customer_id && 'customer_id = @customer_id',
    productFilter && `EXISTS (
      SELECT 1 FROM line_items li WHERE li.source_platform = orders.source_platform
      AND li.source_store = orders.source_store
      AND li.source_order_id = orders.source_order_id
      ${filters.product_id ? 'AND li.product_id = @product_id' : ''}
      ${filters.sku ? 'AND LOWER(li.sku) = LOWER(@sku)' : ''}
      ${filters.product_title ? "AND LOWER(li.product_title) LIKE CONCAT('%', LOWER(@product_title), '%')" : ''}
    )`
  ].filter(Boolean);
  return `
    WITH eu_membership AS (
      SELECT code, joined, left_on FROM UNNEST([
        STRUCT('AT' AS code, DATE '1995-01-01' AS joined, CAST(NULL AS DATE) AS left_on),
        ('BE',DATE '1958-01-01',NULL),('BG',DATE '2007-01-01',NULL),('HR',DATE '2013-07-01',NULL),
        ('CY',DATE '2004-05-01',NULL),('CZ',DATE '2004-05-01',NULL),('DK',DATE '1973-01-01',NULL),
        ('EE',DATE '2004-05-01',NULL),('FI',DATE '1995-01-01',NULL),('FR',DATE '1958-01-01',NULL),
        ('DE',DATE '1958-01-01',NULL),('GR',DATE '1981-01-01',NULL),('HU',DATE '2004-05-01',NULL),
        ('IE',DATE '1973-01-01',NULL),('IT',DATE '1958-01-01',NULL),('LV',DATE '2004-05-01',NULL),
        ('LT',DATE '2004-05-01',NULL),('LU',DATE '1958-01-01',NULL),('MT',DATE '2004-05-01',NULL),
        ('NL',DATE '1958-01-01',NULL),('PL',DATE '2004-05-01',NULL),('PT',DATE '1986-01-01',NULL),
        ('RO',DATE '2007-01-01',NULL),('SK',DATE '2004-05-01',NULL),('SI',DATE '2004-05-01',NULL),
        ('ES',DATE '1986-01-01',NULL),('SE',DATE '1995-01-01',NULL),
        ('GB',DATE '1973-01-01',DATE '2020-02-01')
      ])
    ), shopify_geography AS (
      SELECT order_id, shipping_country_code, shipping_country_name, geography_status,
        geography_provenance
      FROM \`${project}.shopify_data.order_shipping_geography\`
      QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY synced_at DESC) = 1
    ), orders AS (
      SELECT 'woo' source_platform, 'ww' source_store, 'metorik_uk.orders' source_dataset,
        CAST(order_id AS STRING) source_order_id, order_number source_order_number,
        order_name source_order_name, DATE(order_created_at) order_date, status,
        'online' channel, CAST(NULL AS STRING) location, currency,
        total source_order_total, total_discount source_discount_total,
        ABS(COALESCE(total_refunds, 0)) source_refund_total,
        COALESCE(payment_method_title, payment_method) payment_method,
        shipping_method_title shipping_method,
        g.shipping_country_iso2 shipping_country, CAST(NULL AS STRING) shipping_country_name,
        IF(g.geography_status = 'observed', 'valid', 'missing') shipping_geography_status,
        g.geography_provenance shipping_country_provenance, CAST(NULL AS STRING) eu_status,
        CAST(customer_id AS STRING) customer_id, FALSE is_migrated_order,
        CAST(NULL AS STRING) migration_source
      FROM \`${project}.metorik_uk.orders\` o
      LEFT JOIN \`${project}.commerce.order_geography\` g
        ON g.source_store = 'ww' AND g.source_order_id = CAST(o.order_id AS STRING)
      UNION ALL
      SELECT 'woo', 'usd', 'metorik_us.orders', CAST(o.order_id AS STRING), o.order_number,
        o.order_name, DATE(o.order_created_at), o.status, 'online', CAST(NULL AS STRING), o.currency,
        o.total, o.total_discount, ABS(COALESCE(o.total_refunds, 0)),
        COALESCE(o.payment_method_title, o.payment_method), o.shipping_method_title,
        g.shipping_country_iso2, CAST(NULL AS STRING), IF(g.geography_status = 'observed', 'valid', 'missing'),
        g.geography_provenance, CAST(NULL AS STRING), CAST(o.customer_id AS STRING), FALSE, CAST(NULL AS STRING)
      FROM \`${project}.metorik_us.orders\` o
      LEFT JOIN \`${project}.commerce.order_geography\` g
        ON g.source_store = 'usd' AND g.source_order_id = CAST(o.order_id AS STRING)
      UNION ALL
      SELECT 'shopify', 'shopify', 'shopify_data.order_locations', l.order_id, l.order_name,
        l.order_name, DATE(l.created_at), c.display_financial_status,
        IF(l.retail_location_id IS NULL, 'online', 'pos'), l.retail_location_name,
        f.shop_currency, f.original_total_shop, f.original_discounts_shop,
        COALESCE(f.total_refunded_shop, 0),
        JSON_VALUE(f.payment_gateway_names_json, '$[0]'), CAST(NULL AS STRING),
        IF(g.geography_status = 'valid', g.shipping_country_code, NULL),
        IF(g.geography_status = 'valid', g.shipping_country_name, NULL),
        COALESCE(g.geography_status, 'missing_geography_row'), g.geography_provenance,
        CASE WHEN g.geography_status != 'valid' OR g.shipping_country_code IS NULL THEN 'unknown'
          WHEN EXISTS (SELECT 1 FROM eu_membership eu WHERE eu.code = g.shipping_country_code
            AND DATE(l.created_at) >= eu.joined AND (eu.left_on IS NULL OR DATE(l.created_at) < eu.left_on)) THEN 'eu'
          ELSE 'non_eu' END,
        c.customer_id, l.source_app_id = @matrixify_app_id, IF(l.source_app_id = @matrixify_app_id, 'Matrixify/WooCommerce', NULL)
      FROM \`${project}.shopify_data.order_locations\` l
      LEFT JOIN \`${project}.shopify_data.order_financials\` f USING (order_id)
      LEFT JOIN \`${project}.shopify_data.order_customers\` c USING (order_id)
      LEFT JOIN shopify_geography g USING (order_id)
      WHERE (l.source_app_id IS NULL OR l.source_app_id != @matrixify_app_id)
    ), line_items AS (
      SELECT 'woo' source_platform, 'ww' source_store, CAST(order_id AS STRING) source_order_id,
        CAST(product_id AS STRING) product_id, name product_title, sku
      FROM \`${project}.metorik_uk.order_line_items\`
      UNION ALL
      SELECT 'woo', 'usd', CAST(order_id AS STRING), CAST(product_id AS STRING), name, sku
      FROM \`${project}.metorik_us.order_line_items\`
      UNION ALL
      SELECT 'shopify', 'shopify', order_id, product_id, title, sku
      FROM \`${project}.shopify_data.order_line_items\`
    ), matched AS (
      SELECT source_platform, source_store, source_dataset, source_order_id, source_order_number,
        source_order_name, order_date, status, channel, location, currency,
        source_order_total, source_discount_total, source_refund_total,
        payment_method, shipping_method, shipping_country, shipping_country_name,
        shipping_geography_status, shipping_country_provenance, eu_status,
        is_migrated_order, migration_source
      FROM orders WHERE ${clauses.length ? clauses.join('\n AND ') : 'TRUE'}
    )
    SELECT source_platform, source_store, source_dataset, source_order_id, source_order_number,
      source_order_name, order_date, status, channel, location, currency,
      source_order_total, source_discount_total, source_refund_total,
      payment_method, shipping_method,
      shipping_country, shipping_country_name, shipping_geography_status,
      shipping_country_provenance, eu_status, is_migrated_order,
      migration_source, COUNT(*) OVER() matching_order_count,
      COUNTIF(source_platform = 'woo') OVER() woo_result_count,
      COUNTIF(source_platform = 'shopify') OVER() shopify_result_count
    FROM matched
    ORDER BY order_date DESC, source_platform, source_store, source_order_id
    LIMIT @limit`;
}

function lineSql(project, source, store) {
  const dataset = store === 'usd' ? 'metorik_us' : 'metorik_uk';
  return source === 'woo' ? `SELECT CAST(order_id AS STRING) source_order_id,
      CAST(line_item_id AS STRING) line_item_id, CAST(product_id AS STRING) product_id,
      CAST(variation_id AS STRING) variant_id, name product_title, CAST(NULL AS STRING) variant_title,
      sku, quantity, currency, price source_unit_price, total source_line_total, total_tax source_line_tax
    FROM \`${project}.${dataset}.order_line_items\` WHERE order_id = SAFE_CAST(@source_order_id AS INT64)
    ORDER BY line_item_id LIMIT @line_limit`
    : `SELECT order_id source_order_id, line_item_id, product_id, variant_id, title product_title,
      variant_title, sku, quantity, shop_currency currency, original_unit_price_shop source_unit_price,
      discounted_total_shop source_line_total, tax_shop source_line_tax
    FROM \`${project}.shopify_data.order_line_items\` WHERE order_id = @source_order_id
    ORDER BY line_item_id LIMIT @line_limit`;
}

export function createOrderQueryService({ bigquery, project }) {
  if (!bigquery?.query || !project) throw new Error('bigquery and project are required');
  async function searchOrders(input) {
    const semantics = searchFilterSemantics(input);
    const { filters } = semantics;
    const normalizedNumber = normalizeOrderNumber(filters.order_number);
    const { order_number: _orderNumber, ...queryFilters } = filters;
    const activeQueryFilters = Object.fromEntries(Object.entries(queryFilters)
      .filter(([field, value]) => field === 'limit' || isAppliedSearchFilter(field, value)));
    const params = Object.fromEntries(Object.entries({
      ...activeQueryFilters,
      order_number_bare: normalizedNumber?.bare,
      order_number_prefixed: normalizedNumber?.prefixed,
      matrixify_app_id: MATRIXIFY_APP_ID
    })
      .filter(([, value]) => value !== null && value !== undefined));
    const [rows] = await bigquery.query({ query: searchSql(project, filters), params });
    const wooResultCount = Number(rows[0]?.woo_result_count || 0);
    const shopifyResultCount = Number(rows[0]?.shopify_result_count || 0);
    const orders = cleanRows(rows).map(({ woo_result_count: _woo, shopify_result_count: _shopify, ...row }) => row);
    return {
      orders,
      matching_order_count: Number(rows[0]?.matching_order_count || 0),
      returned_order_count: rows.length,
      limit: filters.limit,
      execution_diagnostic: {
        filters_supplied: semantics.supplied,
        filters_applied: semantics.applied,
        parameter_names: Object.keys(params).sort(),
        source_branches_queried: filters.source_platform ? [filters.source_platform] : [...SOURCES],
        woo_result_count: wooResultCount,
        shopify_result_count: shopifyResultCount,
        final_result_count: rows.length
      },
      order_number_lookup: normalizedNumber ? {
        match: 'exact_normalized',
        bare: normalizedNumber.bare,
        prefixed: normalizedNumber.prefixed
      } : null,
      monetary_semantics: 'Filters and returned values use source_order_total in source currency; canonical finance remains authoritative for business reporting.',
      geography_warning: filters.shipping_country || filters.eu_status
        ? 'Country and EU matches use valid directly observed shipping-country codes only. Missing or invalid geography remains unknown and is never inferred. Historical Woo shipping geography is incomplete.'
        : null,
      migration_semantics: 'Matrixify-imported Woo orders are excluded from Shopify results to prevent duplicate sales.'
    };
  }

  async function getOrderLineItems({ identity, limit = 50 }) {
    validateIdentity(identity);
    if (!Number.isInteger(limit) || limit < 1 || limit > ORDER_LINE_ITEM_MAX_LIMIT) {
      throw new Error(`limit must be an integer between 1 and ${ORDER_LINE_ITEM_MAX_LIMIT}`);
    }
    const [rows] = await bigquery.query({
      query: lineSql(project, identity.source_platform, identity.source_store),
      params: { source_order_id: identity.source_order_id, line_limit: limit }
    });
    return { identity, line_items: cleanRows(rows), returned_line_item_count: rows.length, limit };
  }

  async function getOrderDetails({ identity, line_item_limit = 50 }) {
    validateIdentity(identity);
    const result = await searchOrders({
      source_platform: identity.source_platform,
      source_store: identity.source_store,
      source_order_id: identity.source_order_id,
      limit: 2
    });
    const exact = result.orders.filter(row => row.source_platform === identity.source_platform &&
      row.source_order_id === identity.source_order_id &&
      (identity.source_platform !== 'woo' || row.source_store === identity.source_store));
    if (exact.length !== 1) return { identity, found: false, order: null, line_items: [] };
    const lines = await getOrderLineItems({ identity, limit: line_item_limit });
    return {
      identity, found: true, order: exact[0], line_items: lines.line_items,
      provenance: {
        operational_order: exact[0].source_dataset,
        canonical_finance_linkage: null,
        canonical_finance_note: 'No deterministic order-level canonical finance linkage is asserted by this tool.'
      },
      privacy: 'No name, email, phone, street address, postcode, payment credential, or raw payload is returned.'
    };
  }
  async function getOrderHistoryContext({ identity }) {
    validateIdentity(identity);
    if (identity.source_platform === 'woo') {
      return { identity, migration_classification: 'historical_woo_canonical', is_migrated_order: false,
        migration_source: null, canonical_finance_linkage: null };
    }
    const [rows] = await bigquery.query({
      query: `SELECT order_id source_order_id, source_app_id = @matrixify_app_id is_migrated_order,
        IF(source_app_id = @matrixify_app_id, 'Matrixify/WooCommerce', NULL) migration_source
        FROM \`${project}.shopify_data.order_locations\`
        WHERE order_id = @source_order_id LIMIT 1`,
      params: { source_order_id: identity.source_order_id, matrixify_app_id: MATRIXIFY_APP_ID }
    });
    const evidence = rows[0] || null;
    return { identity, found: evidence !== null,
      migration_classification: evidence?.is_migrated_order ? 'migrated_woo_representation' : 'shopify_native',
      is_migrated_order: evidence?.is_migrated_order ?? null,
      migration_source: evidence?.migration_source ?? null,
      canonical_finance_linkage: null,
      semantics: evidence?.is_migrated_order
        ? 'This is a historical Woo order represented in Shopify by migration, not a second sale.'
        : 'No Matrixify app-ID evidence classifies this order as a migrated Woo representation.' };
  }
  async function getGeographyCoverage({ start_date, end_date, source_store = null }) {
    date(start_date, 'start_date'); date(end_date, 'end_date');
    if (!start_date || !end_date) throw new Error('start_date and end_date are required');
    if (source_store !== null && !['ww', 'usd'].includes(source_store)) throw new Error('source_store must be null, ww, or usd');
    const [rows] = await bigquery.query({ query: `WITH woo_orders AS (
      SELECT 'ww' source_store, CAST(order_id AS STRING) source_order_id, DATE(order_created_at) order_date FROM \`${project}.metorik_uk.orders\`
      UNION ALL SELECT 'usd', CAST(order_id AS STRING), DATE(order_created_at) FROM \`${project}.metorik_us.orders\`)
      SELECT COUNT(*) total_orders, COUNTIF(g.geography_status = 'observed') observed_country_orders,
        COUNTIF(g.geography_status IS NULL OR g.geography_status = 'unresolved') unresolved_orders,
        ROUND(100 * SAFE_DIVIDE(COUNTIF(g.geography_status = 'observed'), COUNT(*)), 2) coverage_percentage
      FROM woo_orders o LEFT JOIN \`${project}.commerce.order_geography\` g
        ON g.source_store = o.source_store AND g.source_order_id = o.source_order_id
      WHERE o.order_date BETWEEN DATE(@start_date) AND DATE(@end_date)
        AND (@source_store IS NULL OR o.source_store = @source_store)`,
      params: { start_date, end_date, source_store }, types: { source_store: 'STRING' } });
    return { start_date, end_date, source_store, ...(cleanRows(rows)[0] || {}),
      semantics: 'Coverage counts direct Metorik-export shipping-country evidence; unresolved orders are not estimated.' };
  }
  return { searchOrders, getOrderDetails, getOrderLineItems, getOrderHistoryContext, getGeographyCoverage };
}

export function safeOrderToolCallDiagnostic(name, args = {}) {
  const diagnostic = { tool: name };
  if (name === 'search_orders') {
    const semantics = searchFilterSemantics(args);
    diagnostic.filters_supplied = semantics.supplied;
    diagnostic.filters_applied = semantics.applied;
    // Kept during the diagnostic transition for existing log consumers.
    diagnostic.populated_filters = Object.keys(args)
      .filter(key => args[key] !== null && args[key] !== undefined);
    diagnostic.order_number = args.order_number ?? null;
    diagnostic.source_order_id = args.source_order_id ?? null;
    diagnostic.source_platform = args.source_platform ?? null;
    if (args.order_number !== null && args.order_number !== undefined) {
      const normalized = normalizeOrderNumber(args.order_number);
      diagnostic.order_number_normalized = { bare: normalized.bare, prefixed: normalized.prefixed };
    }
  } else if (['get_order_details', 'get_order_line_items', 'get_order_history_context'].includes(name)) {
    diagnostic.identity = args.identity ? {
      source_platform: args.identity.source_platform ?? null,
      source_store: args.identity.source_store ?? null,
      source_order_id: args.identity.source_order_id ?? null
    } : null;
  }
  return diagnostic;
}

export async function executeOrderToolCall(service, name, args, onDiagnostic = () => {}) {
  const methods = {
    search_orders: 'searchOrders',
    get_order_details: 'getOrderDetails',
    get_order_line_items: 'getOrderLineItems',
    get_order_history_context: 'getOrderHistoryContext',
    get_geography_coverage: 'getGeographyCoverage'
  };
  const method = methods[name];
  if (!method) return { handled: false, result: null };
  onDiagnostic(safeOrderToolCallDiagnostic(name, args));
  const result = await service[method](args);
  if (name === 'search_orders') {
    onDiagnostic({ tool: name, phase: 'result', ...result.execution_diagnostic });
  }
  return { handled: true, result };
}

export const ORDER_TOOL_DEFINITIONS = [
  {
    type: 'function', name: 'search_orders', strict: true,
    description: 'Search bounded Woo and Shopify order evidence. Use source_platform=shopify plus eu_status=eu or non_eu for Shopify shipping-geography examples; results classify the valid direct shipping-country code at the order date (UK is non-EU after Brexit). Uses source-native money, never infers geography, and excludes Matrixify imports.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        start_date: { type: ['string', 'null'] }, end_date: { type: ['string', 'null'] },
        source_platform: { type: ['string', 'null'], enum: ['woo', 'shopify', null] },
        source_store: { type: ['string', 'null'], enum: ['ww', 'usd', 'shopify', null] },
        channel: { type: ['string', 'null'], enum: ['online', 'pos', null] },
        order_number: { type: ['string', 'null'], description: 'Human-facing order number/name. Put values such as #33653 or 33653 here; never reinterpret them as a source order ID.' },
        source_order_id: { type: ['string', 'null'], description: 'Internal source identity only (for example Woo Metorik order_id 169587), not the human-facing order number.' },
        status: { type: ['string', 'null'] }, currency: { type: ['string', 'null'] },
        minimum_order_value: { type: ['number', 'null'], minimum: 0 }, maximum_order_value: { type: ['number', 'null'], minimum: 0 },
        shipping_country: { type: ['string', 'null'], description: 'Exact ISO-2 direct shipping-country code.' },
        eu_status: { type: ['string', 'null'], enum: ['eu', 'non_eu', null], description: 'Shopify-only direct shipping-country membership at the order date. Use separate bounded calls for one EU and one non-EU example.' },
        product_id: { type: ['string', 'null'] },
        product_title: { type: ['string', 'null'] }, sku: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
        refund_status: { type: ['string', 'null'], enum: ['any', 'refunded', 'none', 'partial', 'full', null], description: 'Refund filter. Use any or null when no refund constraint was requested; refunded means any positive refund, while any adds no SQL predicate.' },
        customer_id: { type: ['string', 'null'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['start_date', 'end_date', 'source_platform', 'source_store', 'channel', 'order_number', 'source_order_id',
        'status', 'currency', 'minimum_order_value', 'maximum_order_value', 'shipping_country', 'eu_status', 'product_id',
        'product_title', 'sku', 'location', 'refund_status', 'customer_id', 'limit']
    }
  },
  {
    type: 'function', name: 'get_order_details', strict: true,
    description: 'Get one exact governed order identity and bounded line items without customer PII.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      identity: { type: 'object', additionalProperties: false, properties: {
        source_platform: { type: 'string', enum: ['woo', 'shopify'] }, source_store: { type: 'string', enum: ['ww', 'usd', 'shopify'] }, source_order_id: { type: 'string' }
      }, required: ['source_platform', 'source_store', 'source_order_id'] },
      line_item_limit: { type: 'integer', minimum: 1, maximum: 100 }
    }, required: ['identity', 'line_item_limit'] }
  },
  {
    type: 'function', name: 'get_order_line_items', strict: true,
    description: 'Get bounded line items for one exact governed order identity without customer PII.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      identity: { type: 'object', additionalProperties: false, properties: {
        source_platform: { type: 'string', enum: ['woo', 'shopify'] }, source_store: { type: 'string', enum: ['ww', 'usd', 'shopify'] }, source_order_id: { type: 'string' }
      }, required: ['source_platform', 'source_store', 'source_order_id'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }, required: ['identity', 'limit'] }
  },
  {
    type: 'function', name: 'get_order_history_context', strict: true,
    description: 'Inspect migration/import classification for one exact order identity; this does not invent event history.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      identity: { type: 'object', additionalProperties: false, properties: {
        source_platform: { type: 'string', enum: ['woo', 'shopify'] }, source_store: { type: 'string', enum: ['ww', 'usd', 'shopify'] }, source_order_id: { type: 'string' }
      }, required: ['source_platform', 'source_store', 'source_order_id'] }
    }, required: ['identity'] }
  },
  {
    type: 'function', name: 'get_geography_coverage', strict: true,
    description: 'Return direct shipping-country evidence coverage for a bounded historical Woo period.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      start_date: { type: 'string' }, end_date: { type: 'string' },
      source_store: { type: ['string', 'null'], enum: ['ww', 'usd', null] }
    }, required: ['start_date', 'end_date', 'source_store'] }
  }
];

export function assertOrderQuerySafety() {
  const definitions = JSON.stringify(ORDER_TOOL_DEFINITIONS);
  for (const forbidden of ['email', 'phone', 'postcode', 'address', 'raw_json']) {
    if (definitions.toLowerCase().includes(forbidden)) throw new Error(`PII field exposed: ${forbidden}`);
  }
  const samples = [searchSql('project', validateSearchFilters({})), lineSql('project', 'woo'), lineSql('project', 'shopify')];
  for (const sql of samples) {
    if (/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|EXPORT)\b/i.test(sql)) throw new Error('non-read-only SQL');
    if (/SELECT\s+\*/i.test(sql) || /raw_json/i.test(sql)) throw new Error('unsafe projection');
  }
  return { valid: true, checks: 10, maximum_search_limit: ORDER_SEARCH_MAX_LIMIT, maximum_line_item_limit: ORDER_LINE_ITEM_MAX_LIMIT };
}
