export const ORDER_SEARCH_DEFAULT_LIMIT = 20;
export const ORDER_SEARCH_MAX_LIMIT = 100;
export const ORDER_LINE_ITEM_MAX_LIMIT = 100;
export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCES = ['woo', 'shopify'];
const CHANNELS = ['online', 'pos'];

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
}

function cleanRows(rows) {
  return rows.map(row => JSON.parse(JSON.stringify(row)));
}

export function validateSearchFilters(input = {}) {
  const filters = {
    start_date: null, end_date: null, source_platform: null, channel: null,
    order_number: null, source_order_id: null, status: null, currency: null,
    minimum_order_value: null, maximum_order_value: null, shipping_country: null,
    product_id: null, product_title: null, sku: null, location: null,
    refund_status: null, customer_id: null, limit: ORDER_SEARCH_DEFAULT_LIMIT,
    ...input
  };
  date(filters.start_date, 'start_date');
  date(filters.end_date, 'end_date');
  if (filters.start_date && filters.end_date && filters.start_date > filters.end_date) {
    throw new Error('start_date must be on or before end_date');
  }
  if (filters.source_platform !== null && !SOURCES.includes(filters.source_platform)) {
    throw new Error('source_platform must be null, woo, or shopify');
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
  if (![null, 'any', 'none', 'partial', 'full'].includes(filters.refund_status)) {
    throw new Error('refund_status must be null, any, none, partial, or full');
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
  return filters;
}

function searchSql(project, filters) {
  const productFilter = filters.product_id || filters.product_title || filters.sku;
  const clauses = [
    filters.start_date && 'order_date >= DATE(@start_date)',
    filters.end_date && 'order_date <= DATE(@end_date)',
    filters.source_platform && 'source_platform = @source_platform',
    filters.channel && 'channel = @channel',
    filters.order_number && '(LOWER(source_order_number) = LOWER(@order_number) OR LOWER(source_order_name) = LOWER(@order_number))',
    filters.source_order_id && 'source_order_id = @source_order_id',
    filters.status && 'LOWER(status) = LOWER(@status)',
    filters.currency && 'currency = UPPER(@currency)',
    filters.minimum_order_value !== null && 'source_order_total >= @minimum_order_value',
    filters.maximum_order_value !== null && 'source_order_total <= @maximum_order_value',
    filters.shipping_country && 'shipping_country = UPPER(@shipping_country)',
    filters.location && 'LOWER(COALESCE(location, \'\')) = LOWER(@location)',
    filters.refund_status === 'any' && 'source_refund_total > 0',
    filters.refund_status === 'none' && 'source_refund_total = 0',
    filters.refund_status === 'partial' && 'source_refund_total > 0 AND source_refund_total < source_order_total',
    filters.refund_status === 'full' && 'source_refund_total >= source_order_total',
    filters.customer_id && 'customer_id = @customer_id',
    productFilter && `EXISTS (
      SELECT 1 FROM line_items li WHERE li.source_platform = orders.source_platform
      AND li.source_order_id = orders.source_order_id
      ${filters.product_id ? 'AND li.product_id = @product_id' : ''}
      ${filters.sku ? 'AND LOWER(li.sku) = LOWER(@sku)' : ''}
      ${filters.product_title ? "AND LOWER(li.product_title) LIKE CONCAT('%', LOWER(@product_title), '%')" : ''}
    )`
  ].filter(Boolean);
  return `
    WITH orders AS (
      SELECT 'woo' source_platform, 'metorik_uk.orders' source_dataset,
        CAST(order_id AS STRING) source_order_id, order_number source_order_number,
        order_name source_order_name, DATE(order_created_at) order_date, status,
        'online' channel, CAST(NULL AS STRING) location, currency,
        total source_order_total, total_discount source_discount_total,
        ABS(COALESCE(total_refunds, 0)) source_refund_total,
        COALESCE(payment_method_title, payment_method) payment_method,
        shipping_method_title shipping_method,
        shipping_country, IF(shipping_country IS NULL, NULL, 'metorik_uk.orders.shipping_country') shipping_country_provenance,
        CAST(customer_id AS STRING) customer_id, FALSE is_migrated_order,
        CAST(NULL AS STRING) migration_source
      FROM \`${project}.metorik_uk.orders\`
      UNION ALL
      SELECT 'shopify', 'shopify_data.order_locations', l.order_id, l.order_name,
        l.order_name, DATE(l.created_at), c.display_financial_status,
        IF(l.retail_location_id IS NULL, 'online', 'pos'), l.retail_location_name,
        f.shop_currency, f.original_total_shop, f.original_discounts_shop,
        COALESCE(f.total_refunded_shop, 0),
        JSON_VALUE(f.payment_gateway_names_json, '$[0]'), CAST(NULL AS STRING),
        CAST(NULL AS STRING), CAST(NULL AS STRING),
        c.customer_id, l.source_app_id = @matrixify_app_id, IF(l.source_app_id = @matrixify_app_id, 'Matrixify/WooCommerce', NULL)
      FROM \`${project}.shopify_data.order_locations\` l
      LEFT JOIN \`${project}.shopify_data.order_financials\` f USING (order_id)
      LEFT JOIN \`${project}.shopify_data.order_customers\` c USING (order_id)
      WHERE (l.source_app_id IS NULL OR l.source_app_id != @matrixify_app_id)
    ), line_items AS (
      SELECT 'woo' source_platform, CAST(order_id AS STRING) source_order_id,
        CAST(product_id AS STRING) product_id, name product_title, sku
      FROM \`${project}.metorik_uk.order_line_items\`
      UNION ALL
      SELECT 'shopify', order_id, product_id, title, sku
      FROM \`${project}.shopify_data.order_line_items\`
    ), matched AS (
      SELECT source_platform, source_dataset, source_order_id, source_order_number,
        source_order_name, order_date, status, channel, location, currency,
        source_order_total, source_discount_total, source_refund_total,
        payment_method, shipping_method, shipping_country, shipping_country_provenance,
        is_migrated_order, migration_source
      FROM orders WHERE ${clauses.length ? clauses.join('\n AND ') : 'TRUE'}
    )
    SELECT source_platform, source_dataset, source_order_id, source_order_number,
      source_order_name, order_date, status, channel, location, currency,
      source_order_total, source_discount_total, source_refund_total,
      payment_method, shipping_method,
      shipping_country, shipping_country_provenance, is_migrated_order,
      migration_source, COUNT(*) OVER() matching_order_count
    FROM matched
    ORDER BY order_date DESC, source_platform, source_order_id
    LIMIT @limit`;
}

function lineSql(project, source) {
  return source === 'woo' ? `SELECT CAST(order_id AS STRING) source_order_id,
      CAST(line_item_id AS STRING) line_item_id, CAST(product_id AS STRING) product_id,
      CAST(variation_id AS STRING) variant_id, name product_title, CAST(NULL AS STRING) variant_title,
      sku, quantity, currency, price source_unit_price, total source_line_total, total_tax source_line_tax
    FROM \`${project}.metorik_uk.order_line_items\` WHERE order_id = SAFE_CAST(@source_order_id AS INT64)
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
    const filters = validateSearchFilters(input);
    const params = Object.fromEntries(Object.entries({ ...filters, matrixify_app_id: MATRIXIFY_APP_ID })
      .filter(([, value]) => value !== null));
    const [rows] = await bigquery.query({ query: searchSql(project, filters), params });
    return {
      orders: cleanRows(rows),
      matching_order_count: Number(rows[0]?.matching_order_count || 0),
      returned_order_count: rows.length,
      limit: filters.limit,
      monetary_semantics: 'Filters and returned values use source_order_total in source currency; canonical finance remains authoritative for business reporting.',
      geography_warning: filters.shipping_country
        ? 'Country matches use directly observed shipping-country evidence only. Historical Woo shipping geography is incomplete, so this is not complete country coverage.'
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
      query: lineSql(project, identity.source_platform),
      params: { source_order_id: identity.source_order_id, line_limit: limit }
    });
    return { identity, line_items: cleanRows(rows), returned_line_item_count: rows.length, limit };
  }

  async function getOrderDetails({ identity, line_item_limit = 50 }) {
    validateIdentity(identity);
    const result = await searchOrders({
      source_platform: identity.source_platform,
      source_order_id: identity.source_order_id,
      limit: 2
    });
    const exact = result.orders.filter(row => row.source_platform === identity.source_platform &&
      row.source_order_id === identity.source_order_id);
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
  return { searchOrders, getOrderDetails, getOrderLineItems, getOrderHistoryContext };
}

export const ORDER_TOOL_DEFINITIONS = [
  {
    type: 'function', name: 'search_orders', strict: true,
    description: 'Search bounded Woo and Shopify order evidence. Uses source-native money, direct-only country evidence, and excludes Matrixify imports from Shopify.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        start_date: { type: ['string', 'null'] }, end_date: { type: ['string', 'null'] },
        source_platform: { type: ['string', 'null'], enum: ['woo', 'shopify', null] },
        channel: { type: ['string', 'null'], enum: ['online', 'pos', null] },
        order_number: { type: ['string', 'null'] }, source_order_id: { type: ['string', 'null'] },
        status: { type: ['string', 'null'] }, currency: { type: ['string', 'null'] },
        minimum_order_value: { type: ['number', 'null'], minimum: 0 }, maximum_order_value: { type: ['number', 'null'], minimum: 0 },
        shipping_country: { type: ['string', 'null'] }, product_id: { type: ['string', 'null'] },
        product_title: { type: ['string', 'null'] }, sku: { type: ['string', 'null'] },
        location: { type: ['string', 'null'] },
        refund_status: { type: ['string', 'null'], enum: ['any', 'none', 'partial', 'full', null] },
        customer_id: { type: ['string', 'null'] }, limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['start_date', 'end_date', 'source_platform', 'channel', 'order_number', 'source_order_id',
        'status', 'currency', 'minimum_order_value', 'maximum_order_value', 'shipping_country', 'product_id',
        'product_title', 'sku', 'location', 'refund_status', 'customer_id', 'limit']
    }
  },
  {
    type: 'function', name: 'get_order_details', strict: true,
    description: 'Get one exact governed order identity and bounded line items without customer PII.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      identity: { type: 'object', additionalProperties: false, properties: {
        source_platform: { type: 'string', enum: ['woo', 'shopify'] }, source_order_id: { type: 'string' }
      }, required: ['source_platform', 'source_order_id'] },
      line_item_limit: { type: 'integer', minimum: 1, maximum: 100 }
    }, required: ['identity', 'line_item_limit'] }
  },
  {
    type: 'function', name: 'get_order_line_items', strict: true,
    description: 'Get bounded line items for one exact governed order identity without customer PII.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      identity: { type: 'object', additionalProperties: false, properties: {
        source_platform: { type: 'string', enum: ['woo', 'shopify'] }, source_order_id: { type: 'string' }
      }, required: ['source_platform', 'source_order_id'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    }, required: ['identity', 'limit'] }
  },
  {
    type: 'function', name: 'get_order_history_context', strict: true,
    description: 'Inspect migration/import classification for one exact order identity; this does not invent event history.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      identity: { type: 'object', additionalProperties: false, properties: {
        source_platform: { type: 'string', enum: ['woo', 'shopify'] }, source_order_id: { type: 'string' }
      }, required: ['source_platform', 'source_order_id'] }
    }, required: ['identity'] }
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
