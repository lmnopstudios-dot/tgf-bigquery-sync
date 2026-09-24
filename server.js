import express from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import OpenAI from 'openai';
import { syncGa4, parseArgs as parseGa4SyncArgs } from './ga4/sync.js';
import { createEcommerceManagementReportService } from './oracle/ecommerce-management-report.js';
import { createOrderQueryService, executeOrderToolCall } from './oracle/order-query.js';
import { createCustomerQueryService, executeCustomerToolCall } from './oracle/customer-query.js';
import { applyJourneyAnalysisContext, createCustomerJourneyService, executeCustomerJourneyToolCall } from './oracle/customer-journey.js';
import { createOracleToolDefinitions } from './oracle/tool-registry.js';
import { applyOrderDateScope } from './oracle/order-date-scope.js';
import { assertOracleToolSchemas } from './oracle/tool-schema-validator.js';
import { createKnowledgeService, executeKnowledgeToolCall } from './oracle/knowledge-bigquery.js';
import { createOracleUiRouter } from './oracle/ui-router.js';
import { createEcommerceReportV2 } from './oracle/ecommerce-report-v2.js';
import { createOracleFinanceService } from './oracle/finance.js';
import { createProposalGenerator } from './oracle/proposals.js';
import { createProductMappingService } from './oracle/product-mapping.js';
import { createCollectionClassificationService } from './oracle/collection-classification.js';
import { redactError } from './oracle/ui-security.js';
import {
  AcquisitionValidationError,
  syncShopifyAcquisition
} from './shopify/acquisition.js';
import { normalizeShippingGeography, persistShippingGeography } from './shopify/order-geography.js';
import { createShopifyCountryProductsService } from './oracle/shopify-country-products.js';
import { createCustomerOrderIntervalService } from './oracle/customer-order-interval.js';
import { createOnlineCountrySalesService, ONLINE_COUNTRY_MAX_BYTES } from './oracle/online-country-sales.js';
import { runWithShopifyThrottle, SHOPIFY_RATE_LIMIT_MESSAGE } from './oracle/shopifyql-throttle.js';
import { buildOracleInlineChart } from './oracle/inline-charts.js';
import { AsyncLocalStorage } from 'node:async_hooks';

const app = express();
const PORT = process.env.PORT || 3000;
const DEPLOYED_GIT_REVISION = process.env.RENDER_GIT_COMMIT || null;

// Fail during process startup, before Oracle can submit an invalid tool registry.
assertOracleToolSchemas(createOracleToolDefinitions());

const {
  SHOPIFY_SHOP,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,

  GOOGLE_PROJECT_ID = 'gf-full-data',
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GA4_PROPERTY_ID,

  SYNC_SECRET,

  WOO_US_URL,
  WOO_US_CONSUMER_KEY,
  WOO_US_CONSUMER_SECRET,

  WOO_JP_URL,
  WOO_JP_CONSUMER_KEY,
  WOO_JP_CONSUMER_SECRET,

  METORIK_UK_API_KEY,
  METORIK_US_API_KEY
} = process.env;

const DATASET = 'shopify_data';
const TABLE = 'order_locations';
const LINE_ITEMS_TABLE = 'order_line_items';
const ORDER_CUSTOMERS_TABLE = 'order_customers';
const FINANCIALS_TABLE = 'order_financials';
const REFUNDS_TABLE = 'order_refunds';
const MATRIXIFY_SOURCE_APP_ID = 'gid://shopify/App/1758145';
const SHOPIFY_NATIVE_HISTORY_START = '2025-11-16';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const requestBudget = new AsyncLocalStorage();

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class ShopifyGraphQLError extends Error {
  constructor(errors) {
    super(JSON.stringify(errors, null, 2));
    this.name = 'ShopifyGraphQLError';
    this.errors = errors;
  }
}

/* ---------------------------------------------------------
   BASIC VALIDATION
--------------------------------------------------------- */

if (
  !SHOPIFY_SHOP ||
  !SHOPIFY_CLIENT_ID ||
  !SHOPIFY_CLIENT_SECRET
) {
  throw new Error('Missing Shopify environment variables');
}

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
}

/* ---------------------------------------------------------
   BIGQUERY
--------------------------------------------------------- */

const credentials = JSON.parse(
  GOOGLE_SERVICE_ACCOUNT_JSON
);

const bigquery = new BigQuery({
  projectId: GOOGLE_PROJECT_ID,
  credentials
});

const orderQueryService = createOrderQueryService({
  bigquery,
  project: GOOGLE_PROJECT_ID
});
const customerQueryService = createCustomerQueryService({ bigquery, project: GOOGLE_PROJECT_ID });
const customerJourneyService = createCustomerJourneyService({ bigquery, project: GOOGLE_PROJECT_ID });
const knowledgeService = createKnowledgeService({
  bigquery,
  project: GOOGLE_PROJECT_ID,
  onDiagnostic: diagnostic => console.error('Oracle knowledge query failed:', diagnostic)
});
const ecommerceReportV2 = createEcommerceReportV2({ bigquery, project: GOOGLE_PROJECT_ID, knowledgeService });
const oracleFinance = createOracleFinanceService({ bigquery, project: GOOGLE_PROJECT_ID });
const productMappingService = createProductMappingService({ bigquery, project: GOOGLE_PROJECT_ID });
const collectionClassificationService = createCollectionClassificationService({ bigquery, project: GOOGLE_PROJECT_ID });
const shopifyCountryProductsService = createShopifyCountryProductsService({ bigquery, project: GOOGLE_PROJECT_ID });
const customerOrderIntervalService = createCustomerOrderIntervalService({ bigquery, project: GOOGLE_PROJECT_ID });
const onlineCountrySalesService = createOnlineCountrySalesService({ bigquery, project: GOOGLE_PROJECT_ID });
productMappingService.setup().catch(error => console.error('Product mapping storage setup failed:', redactError(error?.message || error)));
collectionClassificationService.setup().catch(error => console.error('Collection classification storage setup failed:', redactError(error?.message || error)));

/* =========================================================
   SHOPIFY
========================================================= */

function sanitizeShopifyResponsePreview(
  body,
  secrets = []
) {
  let preview = body;

  for (const secret of secrets) {
    if (secret) {
      preview = preview.split(secret).join('[REDACTED]');
    }
  }

  return preview
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 500);
}

async function getShopifyAccessToken() {
  const response = await fetch(
    `https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET
      })
    }
  );

  const responseBody = await response.text();
  let data;

  try {
    data = JSON.parse(responseBody);
  } catch {
    console.error(
      `Shopify OAuth returned non-JSON response (HTTP ${response.status}):`,
      sanitizeShopifyResponsePreview(
        responseBody,
        [SHOPIFY_CLIENT_SECRET]
      )
    );

    throw new Error(
      `Shopify OAuth returned non-JSON response: HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    console.error(
      'Shopify auth error:',
      data
    );

    throw new Error(
      'Could not get Shopify access token'
    );
  }

  return data.access_token;
}

async function shopifyGraphQL(
  token,
  query,
  variables = {}
) {
  const response = await fetch(
    `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const responseBody = await response.text();
  let data;

  try {
    data = JSON.parse(responseBody);
  } catch {
    console.error(
      `Shopify GraphQL returned non-JSON response (HTTP ${response.status}):`,
      sanitizeShopifyResponsePreview(
        responseBody,
        [token]
      )
    );

    throw new Error(
      `Shopify GraphQL returned non-JSON response: HTTP ${response.status}`
    );
  }

  if (!response.ok || data.errors) {
    console.error(
      'Shopify GraphQL error:',
      JSON.stringify(data, null, 2)
    );

    if (data.errors) {
      throw new ShopifyGraphQLError(data.errors);
    }

    throw new Error(JSON.stringify(data, null, 2));
  }

  return data.data;
}

const SHOPIFY_CONVERSION_METRICS = [
  'sessions',
  'online_store_visitors',
  'sessions_with_cart_additions',
  'sessions_that_reached_checkout',
  'sessions_that_completed_checkout',
  'conversion_rate',
  'checkout_conversion_rate'
];

const SHOPIFY_SALES_METRICS = [
  'orders',
  'gross_sales',
  'discounts',
  'returns',
  'net_sales',
  'total_sales',
  'average_order_value'
];

const SHOPIFY_PRODUCT_PERFORMANCE_METRICS = [
  'gross_sales',
  'discounts',
  'returns',
  'net_sales',
  'net_items_sold',
  'orders'
];

const SHOPIFY_INVENTORY_METRICS = [
  'ending_inventory_units_at_location',
  'inventory_units_net_change_at_location',
  'days_in_stock_at_location',
  'days_out_of_stock_at_location',
  'days_of_inventory_remaining_at_location',
  'ending_inventory_value_at_location',
  'ending_inventory_retail_value_at_location'
];

const SHOPIFY_INVENTORY_DIMENSIONS = [
  'inventory_location_id',
  'inventory_location_name',
  'product_id',
  'product_title',
  'product_variant_id',
  'product_variant_title',
  'product_variant_sku'
];

const SHOPIFY_INVENTORY_EFFICIENCY_METRICS = [
  'starting_inventory_units',
  'ending_inventory_units',
  'inventory_units_sold',
  'inventory_units_sold_per_day',
  'sell_through_rate',
  'percent_of_inventory_sold',
  'days_in_stock',
  'days_out_of_stock',
  'days_of_inventory_remaining',
  'ending_inventory_value',
  'ending_inventory_retail_value'
];

const SHOPIFY_PROFITABILITY_METRICS = [
  'average_revenue_before_returns',
  'average_store_costs_before_returns',
  'average_profit_at_delivery_before_returns',
  'average_cost_of_goods_sold',
  'average_sale_after_discounts',
  'average_customer_shipping_charges',
  'average_store_shipping_costs',
  'average_store_duties_and_import_taxes',
  'average_customer_duties_and_import_taxes',
  'average_sales_taxes',
  'average_duty_and_import_tax_adjustment_costs',
  'average_shipping_label_adjustment_costs'
];

const SHOPIFY_CUSTOMER_LIFETIME_METRICS = [
  'new_customer_records',
  'total_amount_spent',
  'total_number_of_orders',
  'total_amount_spent_per_order',
  'days_since_last_order',
  'percent_of_customers'
];

const SHOPIFY_CUSTOMER_METRICS = [
  'customers',
  'new_customers',
  'returning_customers',
  'returning_customer_rate',
  'orders',
  'total_sales',
  'average_order_value'
];

const SHOPIFY_CUSTOMER_TYPE_METRICS = [
  'customers',
  'orders',
  'total_sales',
  'average_order_value'
];

function validateShopifyReportDate(value, name) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw new Error(
      `${name} must be a date in YYYY-MM-DD format`
    );
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(
      `${name} must be a valid calendar date`
    );
  }
}

function shopifyqlStringLiteral(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return `'${value.trim()
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")}'`;
}

function normalizeShopifyResourceIds(rows, fields) {
  for (const row of rows) {
    for (const field of fields) {
      if (row[field] !== null && row[field] !== undefined) {
        row[field] = String(row[field]);
      }
    }
  }

  return rows;
}

function parseShopifyqlValue(value, dataType) {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (
    typeof value === 'string' &&
    (
      /number|numeric|decimal|integer|float/i.test(
        dataType || ''
      ) ||
      /^-?(?:\d+\.?\d*|\.\d+)$/.test(value)
    )
  ) {
    const number = Number(value);

    if (Number.isFinite(number)) {
      return number;
    }
  }

  return value;
}

function normalizeShopifyqlRows(tableData) {
  const { columns = [], rows = [] } = tableData;

  return rows.map(row => {
    const values = Array.isArray(row)
      ? row
      : columns.map(column => row?.[column.name]);
    const normalized = {};

    columns.forEach((column, index) => {
      const value = values[index];

      if (value !== undefined) {
        normalized[column.name] = parseShopifyqlValue(
          value,
          column.dataType
        );
      }
    });

    return normalized;
  });
}

async function runShopifyqlReport(
  token,
  shopifyql,
  reportName
) {
  const query = `
      query ShopifyReport($query: String!) {
        shopifyqlQuery(query: $query) {
          tableData {
            columns {
              name
              dataType
              displayName
            }
            rows
          }
          parseErrors
        }
      }
    `;
  const data = await runWithShopifyThrottle(
    () => shopifyGraphQL(
        token,
        query,
        { query: shopifyql }
      ),
    { deadlineAt: requestBudget.getStore()?.deadlineAt, log: diagnostic => console.info('ShopifyQL operation:', diagnostic) }
  );

  const response = data.shopifyqlQuery;

  if (response.parseErrors?.length) {
    const details = response.parseErrors.join('; ');

    throw new Error(
      `ShopifyQL could not run the ${reportName} report: ${details}`
    );
  }

  if (!response.tableData) {
    throw new Error(
      'ShopifyQL returned an unexpected response without table data'
    );
  }

  return normalizeShopifyqlRows(response.tableData);
}

function addCalculatedConversionRates(metrics) {
  const calculations = [
    [
      'add_to_cart_rate',
      'sessions_with_cart_additions',
      'sessions'
    ],
    [
      'reached_checkout_rate',
      'sessions_that_reached_checkout',
      'sessions'
    ],
    [
      'checkout_completion_rate',
      'sessions_that_completed_checkout',
      'sessions_that_reached_checkout'
    ]
  ];

  for (const [name, numerator, denominator] of calculations) {
    if (
      typeof metrics[numerator] === 'number' &&
      typeof metrics[denominator] === 'number' &&
      metrics[denominator] !== 0
    ) {
      metrics[name] =
        metrics[numerator] / metrics[denominator];
    }
  }

  return metrics;
}

async function getShopifyConversionKpis({
  start_date,
  end_date,
  timeseries = 'none'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error(
      'start_date must be on or before end_date'
    );
  }

  if (
    !['none', 'day', 'week', 'month'].includes(
      timeseries
    )
  ) {
    throw new Error(
      'timeseries must be one of: none, day, week, month'
    );
  }

  const dateRange =
    `SINCE ${start_date} UNTIL ${end_date}`;
  const shopifyql = timeseries === 'none'
    ? `FROM sessions
SHOW ${SHOPIFY_CONVERSION_METRICS.join(', ')}
WHERE human_or_bot_session = 'human'
${dateRange}`
    : `FROM sessions
SHOW ${SHOPIFY_CONVERSION_METRICS.join(', ')}
WHERE human_or_bot_session = 'human'
TIMESERIES ${timeseries}
${dateRange}
ORDER BY ${timeseries} ASC`;
  const token = await getShopifyAccessToken();
  const rows = await runShopifyqlReport(
    token,
    shopifyql,
    'conversion KPI'
  );
  rows.forEach(addCalculatedConversionRates);

  return {
    start_date,
    end_date,
    timeseries,
    ...(timeseries === 'none'
      ? { metrics: rows[0] ?? null }
      : { periods: rows })
  };
}

async function getShopifySalesKpis({
  start_date,
  end_date,
  timeseries = 'none'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error(
      'start_date must be on or before end_date'
    );
  }

  if (
    !['none', 'day', 'week', 'month'].includes(
      timeseries
    )
  ) {
    throw new Error(
      'timeseries must be one of: none, day, week, month'
    );
  }

  const dateRange =
    `SINCE ${start_date} UNTIL ${end_date}`;
  const shopifyql = timeseries === 'none'
    ? `FROM sales
SHOW ${SHOPIFY_SALES_METRICS.join(', ')}
WHERE sales_channel = 'Online Store'
${dateRange}`
    : `FROM sales
SHOW ${SHOPIFY_SALES_METRICS.join(', ')}
WHERE sales_channel = 'Online Store'
TIMESERIES ${timeseries}
${dateRange}
ORDER BY ${timeseries} ASC`;
  const token = await getShopifyAccessToken();
  const rows = await runShopifyqlReport(
    token,
    shopifyql,
    'sales KPI'
  );

  return {
    start_date,
    end_date,
    timeseries,
    ...(timeseries === 'none'
      ? { metrics: rows[0] ?? null }
      : { periods: rows })
  };
}

async function getShopifyProductPerformance({
  start_date,
  end_date,
  limit = 10,
  sort_by = 'net_sales'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error(
      'start_date must be on or before end_date'
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    throw new Error(
      'limit must be an integer between 1 and 50'
    );
  }

  const sortableMetrics = [
    'net_sales',
    'gross_sales',
    'net_items_sold',
    'orders',
    'returns'
  ];

  if (!sortableMetrics.includes(sort_by)) {
    throw new Error(
      `sort_by must be one of: ${sortableMetrics.join(', ')}`
    );
  }

  const shopifyql = `FROM sales
SHOW ${SHOPIFY_PRODUCT_PERFORMANCE_METRICS.join(', ')}
WHERE sales_channel = 'Online Store'
GROUP BY product_id, product_title
SINCE ${start_date} UNTIL ${end_date}
ORDER BY ${sort_by} DESC
LIMIT ${limit}`;
  const token = await getShopifyAccessToken();
  const rows = await runShopifyqlReport(
    token,
    shopifyql,
    'product performance'
  );

  for (const row of rows) {
    if (
      typeof row.returns === 'number' &&
      typeof row.gross_sales === 'number' &&
      row.gross_sales !== 0
    ) {
      row.return_rate_value =
        Math.abs(row.returns) / row.gross_sales;
    }

    if (
      typeof row.net_sales === 'number' &&
      typeof row.net_items_sold === 'number' &&
      row.net_items_sold !== 0
    ) {
      row.average_net_sales_per_item =
        row.net_sales / row.net_items_sold;
    }
  }

  return {
    start_date,
    end_date,
    sales_channel: 'Online Store',
    sort_by,
    limit,
    products: rows
  };
}

async function getShopifyInventoryPerformance({
  start_date,
  end_date,
  limit = 25,
  location = null,
  sort_by = 'ending_inventory_units_at_location',
  sort_direction = 'desc'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error('start_date must be on or before end_date');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }

  const sortableMetrics = [
    'ending_inventory_units_at_location',
    'days_of_inventory_remaining_at_location',
    'days_out_of_stock_at_location',
    'ending_inventory_value_at_location'
  ];

  if (!sortableMetrics.includes(sort_by)) {
    throw new Error(`sort_by must be one of: ${sortableMetrics.join(', ')}`);
  }

  if (!['asc', 'desc'].includes(sort_direction)) {
    throw new Error('sort_direction must be one of: asc, desc');
  }

  const locationFilter = location === null || location === undefined
    ? ''
    : `WHERE inventory_location_name = ${shopifyqlStringLiteral(location, 'location')}\n`;
  const shopifyql = `FROM inventory_by_location
SHOW ${SHOPIFY_INVENTORY_METRICS.join(', ')}
${locationFilter}GROUP BY ${SHOPIFY_INVENTORY_DIMENSIONS.join(', ')}
SINCE ${start_date} UNTIL ${end_date}
ORDER BY ${sort_by} ${sort_direction.toUpperCase()}
LIMIT ${limit}`;
  const token = await getShopifyAccessToken();
  const rows = await runShopifyqlReport(
    token,
    shopifyql,
    'inventory performance'
  );

  normalizeShopifyResourceIds(rows, [
    'inventory_location_id',
    'product_id',
    'product_variant_id'
  ]);

  return {
    start_date,
    end_date,
    location,
    sort_by,
    sort_direction,
    limit,
    inventory_history: rows,
    semantics: {
      data_type: 'historical_location_inventory',
      days_of_inventory_remaining: 'Estimate based on Shopify inventory and sales history, not a guarantee.',
      inventory_value: 'Depends on costs recorded in Shopify.'
    }
  };
}

async function getShopifyInventoryEfficiency({
  start_date,
  end_date,
  limit = 20,
  sort_by = 'sell_through_rate',
  sort_direction = 'desc'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error('start_date must be on or before end_date');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }

  const sortableMetrics = [
    'sell_through_rate',
    'inventory_units_sold',
    'inventory_units_sold_per_day',
    'ending_inventory_units',
    'days_of_inventory_remaining',
    'days_out_of_stock',
    'ending_inventory_value',
    'ending_inventory_retail_value'
  ];

  if (!sortableMetrics.includes(sort_by)) {
    throw new Error(`sort_by must be one of: ${sortableMetrics.join(', ')}`);
  }
  if (!['asc', 'desc'].includes(sort_direction)) {
    throw new Error('sort_direction must be one of: asc, desc');
  }

  const shopifyql = `FROM inventory
SHOW ${SHOPIFY_INVENTORY_EFFICIENCY_METRICS.join(', ')}
WHERE inventory_is_tracked = true
GROUP BY product_id, product_title
SINCE ${start_date} UNTIL ${end_date}
ORDER BY ${sort_by} ${sort_direction.toUpperCase()}
LIMIT ${limit}`;
  const token = await getShopifyAccessToken();
  const rows = await runShopifyqlReport(token, shopifyql, 'inventory efficiency');

  normalizeShopifyResourceIds(rows, ['product_id']);

  return {
    start_date,
    end_date,
    scope: 'aggregate_across_shopify_locations',
    data_type: 'aggregate_historical_shopify_inventory_analytics',
    tracked_inventory_only: true,
    sort_by,
    sort_direction,
    limit,
    products: rows,
    semantics: {
      sell_through_rate: "Shopify's inventory sell-through metric.",
      days_of_inventory_remaining: 'Estimate based on recent sales velocity, not a guarantee; it can be null when no units sold in the period.',
      inventory_value: 'Depends on cost data recorded in Shopify.',
      negative_inventory: 'Negative inventory is not physical stock.'
    }
  };
}

async function getShopifyProfitability({
  start_date,
  end_date,
  timeseries = 'none'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error('start_date must be on or before end_date');
  }
  if (!['none', 'day', 'week', 'month'].includes(timeseries)) {
    throw new Error('timeseries must be one of: none, day, week, month');
  }

  const dateRange = `SINCE ${start_date} UNTIL ${end_date}`;
  const shopifyql = `FROM profitability
SHOW ${SHOPIFY_PROFITABILITY_METRICS.join(', ')}
${timeseries === 'none' ? dateRange : `TIMESERIES ${timeseries}\n${dateRange}\nORDER BY ${timeseries} ASC`}`;
  const token = await getShopifyAccessToken();
  const rows = await runShopifyqlReport(token, shopifyql, 'profitability');

  return {
    start_date,
    end_date,
    timeseries,
    ...(timeseries === 'none' ? { metrics: rows[0] ?? null } : { periods: rows }),
    semantics: {
      basis: 'Shopify operational profitability before returns are settled; not accounting profit.',
      currency: 'Report values remain in Shopify store currency; no currency conversion is performed.',
      excluded_costs: 'Excludes costs Shopify does not know about, including marketing and packaging.',
      unavailable_fees: 'Payment-processing and international fee components are unavailable from this ShopifyQL report and are omitted; they are not inferred or replaced with zero.',
      cost_data: 'Missing product costs must not be interpreted as complete or zero cost data.',
      source_of_truth: 'BigQuery remains the historical and accounting financial source of truth; later DHL data may provide more authoritative shipping, duty and customs costs.'
    }
  };
}

async function getShopifyCustomerLifetimeMetrics({
  start_date,
  end_date,
  limit = 20,
  sort_by = 'total_amount_spent',
  sort_direction = 'desc'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error('start_date must be on or before end_date');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }

  const sortableMetrics = [
    'total_amount_spent',
    'total_number_of_orders',
    'total_amount_spent_per_order',
    'days_since_last_order',
    'new_customer_records'
  ];

  if (!sortableMetrics.includes(sort_by)) {
    throw new Error(`sort_by must be one of: ${sortableMetrics.join(', ')}`);
  }
  if (!['asc', 'desc'].includes(sort_direction)) {
    throw new Error('sort_direction must be one of: asc, desc');
  }

  const shopifyql = `FROM customers
SHOW ${SHOPIFY_CUSTOMER_LIFETIME_METRICS.join(', ')}
GROUP BY customer_id, customer_name, customer_first_order_date, customer_last_order_date
SINCE ${start_date} UNTIL ${end_date}
ORDER BY ${sort_by} ${sort_direction.toUpperCase()}
LIMIT ${limit}`;
  const token = await getShopifyAccessToken();
  const rows = await runShopifyqlReport(token, shopifyql, 'customer lifetime metrics');

  normalizeShopifyResourceIds(rows, ['customer_id']);

  return {
    start_date,
    end_date,
    cohort_basis: 'customer acquisition / first purchase in the selected date range',
    metrics_scope: 'lifetime metrics for the selected customers, not activity limited to the date range',
    pii: 'No customer email, phone or address is requested.',
    sort_by,
    sort_direction,
    limit,
    customers: rows
  };
}

function optionalBehaviorDateFilter(startDate, endDate, field) {
  const clauses = [];

  if (startDate !== null) clauses.push(`${field} >= DATE(@start_date)`);
  if (endDate !== null) clauses.push(`${field} <= DATE(@end_date)`);

  return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
}

async function getShopifyCustomerProductBehavior({
  analysis,
  start_date,
  end_date,
  product_query,
  customer_query,
  minimum_lifetime_spend,
  minimum_orders,
  inactive_days,
  limit
}) {
  const analyses = [
    'product_customers',
    'customer_products',
    'product_affinity',
    'repeat_customer_products',
    'lapsed_high_value_customers'
  ];

  if (!analyses.includes(analysis)) {
    throw new Error(`analysis must be one of: ${analyses.join(', ')}`);
  }
  if (start_date !== null) validateShopifyReportDate(start_date, 'start_date');
  if (end_date !== null) validateShopifyReportDate(end_date, 'end_date');
  if (start_date !== null && end_date !== null && start_date > end_date) {
    throw new Error('start_date must be on or before end_date');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  if (['product_customers', 'product_affinity'].includes(analysis) &&
      (typeof product_query !== 'string' || !product_query.trim())) {
    throw new Error(`${analysis} requires product_query`);
  }
  if (analysis === 'customer_products' &&
      (typeof customer_query !== 'string' || !customer_query.trim())) {
    throw new Error('customer_products requires customer_query');
  }
  if (minimum_lifetime_spend !== null &&
      (typeof minimum_lifetime_spend !== 'number' || minimum_lifetime_spend < 0)) {
    throw new Error('minimum_lifetime_spend must be a non-negative number or null');
  }
  if (minimum_orders !== null && (!Number.isInteger(minimum_orders) || minimum_orders < 1)) {
    throw new Error('minimum_orders must be a positive integer or null');
  }
  if (inactive_days !== null && (!Number.isInteger(inactive_days) || inactive_days < 0)) {
    throw new Error('inactive_days must be a non-negative integer or null');
  }

  const params = {
    matrixify_source_app_id: MATRIXIFY_SOURCE_APP_ID,
    limit
  };
  if (start_date !== null) params.start_date = start_date;
  if (end_date !== null) params.end_date = end_date;
  if (product_query !== null) params.product_query = product_query.trim().toLowerCase();
  if (customer_query !== null) params.customer_query = customer_query.trim().toLowerCase();
  if (minimum_lifetime_spend !== null) params.minimum_lifetime_spend = minimum_lifetime_spend;
  if (minimum_orders !== null) params.minimum_orders = minimum_orders;
  if (inactive_days !== null) params.inactive_days = inactive_days;

  const base = `
    WITH native_orders AS (
      SELECT order_id, DATE(order_created_at) AS order_date,
             customer_id, customer_name, is_guest
      FROM \`${GOOGLE_PROJECT_ID}.${DATASET}.${ORDER_CUSTOMERS_TABLE}\`
      WHERE (source_app_id IS NULL OR source_app_id != @matrixify_source_app_id)
    ),
    lines AS (
      SELECT o.*, li.product_id, li.variant_id, li.title AS product_title,
             li.variant_title, li.sku, li.quantity,
             li.discounted_total_shop AS purchased_line_value,
             li.shop_currency
      FROM native_orders o
      JOIN \`${GOOGLE_PROJECT_ID}.${DATASET}.${LINE_ITEMS_TABLE}\` li USING (order_id)
    )`;
  const linesActivityFilter = optionalBehaviorDateFilter(
    start_date,
    end_date,
    'lines.order_date'
  );
  const customerProductsActivityFilter = optionalBehaviorDateFilter(
    start_date,
    end_date,
    'l.order_date'
  );
  const productMatch = `(
    LOWER(COALESCE(product_id, '')) = @product_query OR
    LOWER(COALESCE(product_title, '')) LIKE CONCAT('%', @product_query, '%')
  )`;
  let sql;
  let dateSemantics = 'start_date and end_date bound the purchase/activity period; null bounds use all synchronized history.';
  let guestSql = `${base} SELECT COUNT(DISTINCT order_id) AS excluded_guest_orders
    FROM lines WHERE is_guest ${linesActivityFilter}`;

  if (analysis === 'product_customers') {
    sql = `${base},
      matched AS (SELECT * FROM lines WHERE ${productMatch} ${linesActivityFilter}),
      lifetime AS (
        SELECT customer_id, COUNT(DISTINCT order_id) AS available_history_orders,
               SUM(purchased_line_value) AS available_history_purchased_line_value,
               MIN(order_date) AS available_history_first_order,
               MAX(order_date) AS available_history_last_order
        FROM lines WHERE customer_id IS NOT NULL GROUP BY customer_id
      )
      SELECT m.customer_id, ANY_VALUE(m.customer_name HAVING MAX m.order_date) AS customer_name,
             m.product_id, ANY_VALUE(m.product_title HAVING MAX m.order_date) AS product_title,
             SUM(m.quantity) AS matching_quantity, COUNT(DISTINCT m.order_id) AS matching_order_count,
             ANY_VALUE(l.available_history_orders) AS available_history_orders,
             ANY_VALUE(l.available_history_purchased_line_value) AS available_history_purchased_line_value,
             ANY_VALUE(l.available_history_first_order) AS available_history_first_order,
             ANY_VALUE(l.available_history_last_order) AS available_history_last_order,
             DATE_DIFF(CURRENT_DATE(), ANY_VALUE(l.available_history_last_order), DAY) AS days_since_last_order
      FROM matched m JOIN lifetime l USING (customer_id)
      WHERE m.customer_id IS NOT NULL AND NOT m.is_guest
      GROUP BY m.customer_id, m.product_id
      ORDER BY matching_quantity DESC, matching_order_count DESC LIMIT @limit`;
    guestSql = `${base} SELECT COUNT(DISTINCT order_id) AS excluded_guest_orders
      FROM lines WHERE is_guest AND ${productMatch} ${linesActivityFilter}`;
  } else if (analysis === 'customer_products') {
    sql = `${base}, matched_customers AS (
        SELECT DISTINCT customer_id FROM lines
        WHERE customer_id IS NOT NULL AND NOT is_guest AND (
          LOWER(customer_id) = @customer_query OR
          LOWER(COALESCE(customer_name, '')) LIKE CONCAT('%', @customer_query, '%'))
      ), customer_product_history AS (
        SELECT l.customer_id, ANY_VALUE(l.customer_name HAVING MAX l.order_date) AS customer_name,
               l.product_id, ANY_VALUE(l.product_title HAVING MAX l.order_date) AS product_title,
               SUM(l.quantity) AS quantity, COUNT(DISTINCT l.order_id) AS order_count,
               SUM(l.purchased_line_value) AS operational_purchased_line_value,
               MIN(l.order_date) AS first_purchase, MAX(l.order_date) AS latest_purchase
        FROM lines l JOIN matched_customers USING (customer_id)
        WHERE TRUE ${customerProductsActivityFilter}
        GROUP BY l.customer_id, l.product_id
      ), distinct_variant_details AS (
        SELECT DISTINCT l.customer_id, l.product_id,
               l.variant_id, l.variant_title, l.sku
        FROM lines l JOIN matched_customers USING (customer_id)
        WHERE TRUE ${customerProductsActivityFilter}
          AND (l.variant_id IS NOT NULL OR l.variant_title IS NOT NULL OR l.sku IS NOT NULL)
      ), variant_details AS (
        SELECT customer_id, product_id,
               ARRAY_AGG(STRUCT(variant_id, variant_title, sku)
                 ORDER BY variant_id, variant_title, sku LIMIT 10) AS variant_sku_details
        FROM distinct_variant_details
        GROUP BY customer_id, product_id
      )
      SELECT h.*, IFNULL(v.variant_sku_details, []) AS variant_sku_details
      FROM customer_product_history h
      LEFT JOIN variant_details v
        ON h.customer_id = v.customer_id
       AND h.product_id IS NOT DISTINCT FROM v.product_id
      ORDER BY operational_purchased_line_value DESC, quantity DESC LIMIT @limit`;
    guestSql = 'SELECT 0 AS excluded_guest_orders';
  } else if (analysis === 'product_affinity') {
    sql = `${base}, period_lines AS (SELECT * FROM lines WHERE TRUE ${linesActivityFilter}),
      seed AS (SELECT * FROM period_lines WHERE customer_id IS NOT NULL AND NOT is_guest AND ${productMatch}),
      seed_summary AS (
        SELECT product_id AS seed_product_id,
               ANY_VALUE(product_title HAVING MAX order_date) AS seed_product_title,
               COUNT(DISTINCT customer_id) AS seed_product_customer_count
        FROM seed GROUP BY product_id
      ), related AS (
        SELECT s.product_id AS seed_product_id, p.product_id AS related_product_id,
               ANY_VALUE(p.product_title HAVING MAX p.order_date) AS related_product_title,
               COUNT(DISTINCT p.customer_id) AS shared_customer_count,
               COUNT(DISTINCT p.order_id) AS related_order_count,
               SUM(p.quantity) AS related_quantity,
               SUM(p.purchased_line_value) AS related_operational_purchased_line_value
        FROM (SELECT DISTINCT product_id, customer_id FROM seed) s
        JOIN period_lines p USING (customer_id)
        WHERE p.product_id IS DISTINCT FROM s.product_id
        GROUP BY s.product_id, p.product_id
      )
      SELECT ss.seed_product_id, ss.seed_product_title, r.related_product_id,
             r.related_product_title, ss.seed_product_customer_count, r.shared_customer_count,
             100 * SAFE_DIVIDE(r.shared_customer_count, ss.seed_product_customer_count) AS customer_overlap_percentage,
             r.related_order_count, r.related_quantity, r.related_operational_purchased_line_value
      FROM related r JOIN seed_summary ss USING (seed_product_id)
      ORDER BY shared_customer_count DESC, related_quantity DESC LIMIT @limit`;
    guestSql = `${base} SELECT COUNT(DISTINCT order_id) AS excluded_guest_orders
      FROM lines WHERE is_guest AND ${productMatch} ${linesActivityFilter}`;
  } else if (analysis === 'repeat_customer_products') {
    sql = `${base}, period_lines AS (
        SELECT * FROM lines WHERE customer_id IS NOT NULL AND NOT is_guest ${linesActivityFilter}
      ), customer_orders AS (
        SELECT customer_id, COUNT(DISTINCT order_id) AS orders FROM period_lines GROUP BY customer_id
      )
      SELECT l.product_id, ANY_VALUE(l.product_title HAVING MAX l.order_date) AS product_title,
             COUNT(DISTINCT l.customer_id) AS identified_buyers,
             COUNT(DISTINCT IF(c.orders > 1, l.customer_id, NULL)) AS repeat_buyers,
             COUNT(DISTINCT IF(c.orders = 1, l.customer_id, NULL)) AS one_order_buyers,
             SAFE_DIVIDE(COUNT(DISTINCT IF(c.orders > 1, l.customer_id, NULL)),
                         COUNT(DISTINCT l.customer_id)) AS repeat_buyer_share,
             SUM(l.quantity) AS quantity, COUNT(DISTINCT l.order_id) AS orders,
             SUM(l.purchased_line_value) AS operational_purchased_line_value
      FROM period_lines l JOIN customer_orders c USING (customer_id)
      GROUP BY l.product_id ORDER BY repeat_buyers DESC, identified_buyers DESC LIMIT @limit`;
  } else {
    const spendFilter = minimum_lifetime_spend === null ? '' : 'AND available_history_purchased_line_value >= @minimum_lifetime_spend';
    const ordersFilter = minimum_orders === null ? '' : 'AND available_history_orders >= @minimum_orders';
    const inactiveFilter = inactive_days === null ? '' : 'AND days_since_last_order >= @inactive_days';
    const acquisitionFilter = optionalBehaviorDateFilter(start_date, end_date, 'available_history_first_order');
    sql = `${base}, customer_history AS (
        SELECT customer_id, ANY_VALUE(customer_name HAVING MAX order_date) AS customer_name,
               SUM(purchased_line_value) AS available_history_purchased_line_value,
               COUNT(DISTINCT order_id) AS available_history_orders,
               MIN(order_date) AS available_history_first_order,
               MAX(order_date) AS available_history_last_order,
               DATE_DIFF(${end_date === null ? 'CURRENT_DATE()' : 'DATE(@end_date)'}, MAX(order_date), DAY) AS days_since_last_order
        FROM lines WHERE customer_id IS NOT NULL AND NOT is_guest GROUP BY customer_id
      ), qualifying_customers AS (
        SELECT * FROM customer_history WHERE TRUE ${acquisitionFilter}
        ${spendFilter} ${ordersFilter} ${inactiveFilter}
        ORDER BY available_history_purchased_line_value DESC LIMIT @limit
      ), recent_product_history AS (
        SELECT l.customer_id,
               ARRAY_AGG(STRUCT(l.product_id, l.product_title, l.order_date)
                 ORDER BY l.order_date DESC LIMIT 10) AS recent_products
        FROM lines l JOIN qualifying_customers q USING (customer_id)
        GROUP BY l.customer_id
      )
      SELECT q.*, r.recent_products
      FROM qualifying_customers q
      JOIN recent_product_history r USING (customer_id)
      ORDER BY available_history_purchased_line_value DESC`;
    dateSemantics = 'start_date and end_date bound the available-history acquisition (first-order) period; metrics use all synchronized Shopify-native history. Inactivity is measured at end_date, or today when end_date is null.';
    guestSql = `${base} SELECT COUNT(DISTINCT order_id) AS excluded_guest_orders FROM lines WHERE is_guest`;
  }

  const parametersUsedBy = query => Object.fromEntries(
    Object.entries(params).filter(([name]) => query.includes(`@${name}`))
  );
  const diagnosticParams = query => Object.fromEntries(
    Object.entries(parametersUsedBy(query)).map(([name, value]) => [
      name,
      name === 'customer_query' ? '[supplied]' : value
    ])
  );

  console.log('Shopify customer/product behavior BigQuery diagnostic', {
    analysis,
    sql,
    params: diagnosticParams(sql),
    guest_sql: guestSql,
    guest_params: diagnosticParams(guestSql)
  });

  const runBigQuery = async (label, query) => {
    const startedAt = Date.now();

    console.log(
      `[customer-behavior:${analysis}] ${label} BigQuery starting`
    );

    try {
      const result = await bigquery.query({
        query,
        params: parametersUsedBy(query)
      });

      console.log(
        `[customer-behavior:${analysis}] ${label} BigQuery completed ` +
        `(${Date.now() - startedAt}ms, ${result[0].length} rows)`
      );

      return result;
    } catch (error) {
      console.error(
        `[customer-behavior:${analysis}] ${label} BigQuery failed ` +
        `(${Date.now() - startedAt}ms)`,
        error instanceof Error ? error.message : String(error)
      );

      throw error;
    }
  };

  const [queryResult, guestResult] = await Promise.all([
    runBigQuery('primary', sql),
    runBigQuery('guest', guestSql)
  ]);

  return {
    analysis,
    start_date,
    end_date,
    results: queryResult[0],
    excluded_guest_orders: Number(guestResult[0][0]?.excluded_guest_orders || 0),
    semantics: {
      scope: 'Shopify-native customer/product behavioural analysis from persisted BigQuery tables.',
      matrixify_exclusion: `Orders whose source_app_id is ${MATRIXIFY_SOURCE_APP_ID} are excluded; these are 2,158 historical WooCommerce orders imported by Matrixify.`,
      available_history: `Synchronized Shopify-native history begins ${SHOPIFY_NATIVE_HISTORY_START}; available-history metrics are not necessarily true customer lifetime metrics.`,
      dates: dateSemantics,
      result_grain: analysis === 'product_customers'
        ? 'One row per stable customer_id and matched product_id. A broad product query can return the same customer on multiple rows; count distinct customer_id for a unique matched-customer count.'
        : analysis === 'product_affinity'
          ? 'Affinity is calculated independently for each matched seed_product_id. A broad product query creates multiple separate seed cohorts, never one combined seed-product cohort.'
          : 'Result grain is defined by the stable IDs returned for the selected analysis.',
      monetary_value: 'discounted_total_shop summed as operational purchased-line value in Shopify shop currency; it is not settled revenue and may not reflect subsequent refunds.',
      identity: 'customer_id is identity; customer_name is display-only and matching names are never merged.',
      guests: 'Guest orders have no synthesized identity and are excluded from individual-customer results; excluded_guest_orders reports the relevant excluded scope.',
      interpretation: analysis === 'product_affinity'
        ? 'Affinity is observed customer/product overlap, not causation.'
        : analysis === 'repeat_customer_products'
          ? 'Products are associated with repeat customers; this does not mean a product caused retention.'
          : 'Behavioural aggregates do not establish causation.',
      financial_truth: 'BigQuery finance.sales_master remains the accounting/financial source of truth.'
    }
  };
}

async function getShopifyReturnsAnalysis({
  start_date,
  end_date,
  limit = 25,
  group_by = 'reason',
  status = null
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error('start_date must be on or before end_date');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }

  const dimensionsByGroup = {
    reason: [
      'return_line_item_reason',
      'return_line_item_reason_note'
    ],
    product: ['product_title_at_time_of_sale'],
    variant: [
      'product_variant_title_at_time_of_sale',
      'product_variant_sku_at_time_of_sale'
    ],
    status: ['return_status']
  };
  let dimensions = dimensionsByGroup[group_by];

  if (!dimensions) {
    throw new Error('group_by must be one of: reason, product, variant, status');
  }

  const statusFilter = status === null || status === undefined
    ? ''
    : `WHERE return_status = ${shopifyqlStringLiteral(status, 'status')}\n`;
  const buildQuery = () => `FROM returns
SHOW returned_quantity
${statusFilter}GROUP BY ${dimensions.join(', ')}
SINCE ${start_date} UNTIL ${end_date}
ORDER BY returned_quantity DESC
LIMIT ${limit}`;
  const token = await getShopifyAccessToken();
  let rows;

  try {
    rows = await runShopifyqlReport(
      token,
      buildQuery(),
      'returns analysis'
    );
  } catch (error) {
    if (
      group_by !== 'reason' ||
      !String(error.message).includes(
        'return_line_item_reason_note'
      )
    ) {
      throw error;
    }

    dimensions = ['return_line_item_reason'];
    rows = await runShopifyqlReport(
      token,
      buildQuery(),
      'returns analysis'
    );
  }

  return {
    start_date,
    end_date,
    group_by,
    status,
    limit,
    returned_items: rows,
    unit: 'returned_quantity',
    semantics: 'Item quantities only; use BigQuery for accounting refund values.'
  };
}

async function getShopifyCustomerKpis({
  start_date,
  end_date,
  timeseries = 'none'
}) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');

  if (start_date > end_date) {
    throw new Error(
      'start_date must be on or before end_date'
    );
  }

  if (
    !['none', 'day', 'week', 'month'].includes(
      timeseries
    )
  ) {
    throw new Error(
      'timeseries must be one of: none, day, week, month'
    );
  }

  const dateRange =
    `SINCE ${start_date} UNTIL ${end_date}`;
  const overallQuery = `FROM sales
SHOW ${SHOPIFY_CUSTOMER_METRICS.join(', ')}
WHERE sales_channel = 'Online Store'
${timeseries === 'none'
    ? dateRange
    : `TIMESERIES ${timeseries}
${dateRange}
ORDER BY ${timeseries} ASC`}`;
  const token = await getShopifyAccessToken();
  const overallRows = await runShopifyqlReport(
    token,
    overallQuery,
    'customer KPI'
  );

  if (timeseries !== 'none') {
    return {
      start_date,
      end_date,
      sales_channel: 'Online Store',
      timeseries,
      periods: overallRows
    };
  }

  const customerTypeQuery = `FROM sales
SHOW ${SHOPIFY_CUSTOMER_TYPE_METRICS.join(', ')}
WHERE sales_channel = 'Online Store'
GROUP BY new_or_returning_customer
${dateRange}`;
  const customerTypeRows = await runShopifyqlReport(
    token,
    customerTypeQuery,
    'customer type breakdown'
  );
  const customerTypes = {};

  for (const row of customerTypeRows) {
    const rawType = row.new_or_returning_customer;
    const normalizedType = typeof rawType === 'string'
      ? rawType.toLowerCase()
      : '';
    const label = normalizedType === 'new'
      ? 'New'
      : normalizedType === 'returning'
        ? 'Returning'
        : rawType;

    if (label !== undefined && label !== null) {
      const { new_or_returning_customer, ...metrics } = row;
      customerTypes[label] = metrics;
    }
  }

  return {
    start_date,
    end_date,
    sales_channel: 'Online Store',
    timeseries,
    overall: overallRows[0] ?? null,
    customer_types: customerTypes
  };
}

async function searchShopifyProducts({
  query,
  limit = 10
}) {
  if (
    typeof query !== 'string' ||
    !query.trim()
  ) {
    throw new Error(
      'query must be a non-empty string'
    );
  }

  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 25
  ) {
    throw new Error(
      'limit must be an integer between 1 and 25'
    );
  }

  const token =
    await getShopifyAccessToken();

  const data =
    await shopifyGraphQL(
      token,
      `
        query SearchProducts(
          $query: String!
          $limit: Int!
        ) {
          products(
            first: $limit
            query: $query
          ) {
            nodes {
              id
              title
              handle
              status
              vendor
              productType
              tags
              variants(first: 100) {
                nodes {
                  id
                  title
                  sku
                  price
                  inventoryQuantity
                  availableForSale
                }
              }
            }
          }
        }
      `,
      {
        query: query.trim(),
        limit
      }
    );

  return data.products.nodes.map(
    product => ({
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      vendor: product.vendor,
      productType:
        product.productType,
      tags: product.tags,
      is_made_to_order: product.tags.some(
        tag => tag.toLowerCase() === 'made-to-order'
      ),
      variants:
        product.variants.nodes
    })
  );
}

// Keep connection pages conservative: Shopify rejects any Admin GraphQL query
// whose requested cost exceeds 1,000 points. In particular, the discovery
// query nests variants under products, so its two bounded connections use the
// smallest pages here and inventory levels are fetched separately.
const SHOPIFY_INVENTORY_PRODUCT_PAGE_SIZE = 25;
const SHOPIFY_INVENTORY_DISCOVERY_VARIANT_PAGE_SIZE = 20;
const SHOPIFY_INVENTORY_VARIANT_PAGE_SIZE = 50;
const SHOPIFY_INVENTORY_LEVEL_PAGE_SIZE = 50;

const SHOPIFY_INVENTORY_BY_LOCATION_PRODUCTS_QUERY = `
  query InventoryProductsByLocation(
    $query: String!
    $limit: Int!
    $variantPageSize: Int!
  ) {
    products(first: $limit, query: $query) {
      nodes {
        id
        title
        handle
        status
        tags
        variants(first: $variantPageSize) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            sku
            availableForSale
            inventoryItem {
              id
            }
          }
        }
      }
    }
  }
`;

const SHOPIFY_INVENTORY_BY_LOCATION_VARIANTS_QUERY = `
  query InventoryProductVariants(
    $productId: ID!
    $cursor: String!
    $pageSize: Int!
  ) {
    product(id: $productId) {
      variants(first: $pageSize, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          sku
          availableForSale
          inventoryItem {
            id
          }
        }
      }
    }
  }
`;

const SHOPIFY_INVENTORY_BY_LOCATION_LEVELS_QUERY = `
  query InventoryItemLevels(
    $inventoryItemId: ID!
    $cursor: String
    $pageSize: Int!
  ) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevels(first: $pageSize, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          location {
            id
            name
            isActive
          }
          quantities(names: ["available"]) {
            name
            quantity
          }
        }
      }
    }
  }
`;

async function getShopifyInventoryByLocation({
  query,
  location,
  limit = 10
}) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('query must be a non-empty string');
  }

  if (location !== null && (
    typeof location !== 'string' || !location.trim()
  )) {
    throw new Error('location must be null or a non-empty string');
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
    throw new Error('limit must be an integer between 1 and 25');
  }

  const token = await getShopifyAccessToken();
  const normalizedLocation = location === null
    ? null
    : location.trim().toLocaleLowerCase();
  const data = await shopifyGraphQL(
    token,
    SHOPIFY_INVENTORY_BY_LOCATION_PRODUCTS_QUERY,
    {
      query: query.trim(),
      limit: Math.min(limit, SHOPIFY_INVENTORY_PRODUCT_PAGE_SIZE),
      variantPageSize: SHOPIFY_INVENTORY_DISCOVERY_VARIANT_PAGE_SIZE
    }
  );
  const activeLocationNames = new Set();

  const collectInventoryLevels = async inventoryItem => {
    if (!inventoryItem) {
      return [];
    }

    const levels = [];
    let cursor = null;
    const seenCursors = new Set();

    while (true) {
      const page = await shopifyGraphQL(
        token,
        SHOPIFY_INVENTORY_BY_LOCATION_LEVELS_QUERY,
        {
          inventoryItemId: inventoryItem.id,
          cursor,
          pageSize: SHOPIFY_INVENTORY_LEVEL_PAGE_SIZE
        }
      );

      if (!page.inventoryItem) {
        throw new Error(`Shopify inventory item not found: ${inventoryItem.id}`);
      }

      levels.push(...page.inventoryItem.inventoryLevels.nodes);
      const pageInfo = page.inventoryItem.inventoryLevels.pageInfo;

      if (!pageInfo.hasNextPage) {
        break;
      }

      const nextCursor = pageInfo.endCursor;

      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new Error('Shopify inventory-level pagination returned an invalid cursor');
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return levels;
  };

  const products = [];

  for (const product of data.products.nodes) {
    const variants = [...product.variants.nodes];
    let pageInfo = product.variants.pageInfo;
    const seenCursors = new Set();

    while (pageInfo.hasNextPage) {
      const cursor = pageInfo.endCursor;

      if (!cursor || seenCursors.has(cursor)) {
        throw new Error('Shopify variant pagination returned an invalid cursor');
      }

      seenCursors.add(cursor);
      const page = await shopifyGraphQL(
        token,
        SHOPIFY_INVENTORY_BY_LOCATION_VARIANTS_QUERY,
        {
          productId: product.id,
          cursor,
          pageSize: SHOPIFY_INVENTORY_VARIANT_PAGE_SIZE
        }
      );

      if (!page.product) {
        throw new Error(`Shopify product not found: ${product.id}`);
      }

      variants.push(...page.product.variants.nodes);
      pageInfo = page.product.variants.pageInfo;
    }

    const normalizedVariants = [];

    for (const variant of variants) {
      const levels = await collectInventoryLevels(variant.inventoryItem);
      const activeLevels = levels.filter(level => level.location.isActive);

      for (const level of activeLevels) {
        activeLocationNames.add(level.location.name.toLocaleLowerCase());
      }

      normalizedVariants.push({
        id: variant.id,
        title: variant.title,
        sku: variant.sku,
        availableForSale: variant.availableForSale,
        inventory_item_id: variant.inventoryItem?.id ?? null,
        locations: activeLevels
          .filter(level => normalizedLocation === null ||
            level.location.name.toLocaleLowerCase() === normalizedLocation)
          .map(level => ({
            location_id: level.location.id,
            location_name: level.location.name,
            available: level.quantities.find(
              quantity => quantity.name === 'available'
            )?.quantity ?? null
          }))
      });
    }

    products.push({
      id: product.id,
      title: product.title,
      handle: product.handle,
      status: product.status,
      tags: product.tags,
      is_made_to_order: product.tags.some(
        tag => tag.toLowerCase() === 'made-to-order'
      ),
      variants: normalizedVariants
    });
  }

  const locationFound = normalizedLocation === null
    ? null
    : activeLocationNames.has(normalizedLocation);

  return {
    query: query.trim(),
    location_filter: location,
    location_found: locationFound,
    ...(locationFound === false
      ? { message: `Location not found: ${location.trim()}` }
      : {}),
    products
  };
}

async function getAllOrders() {
  const token =
    await getShopifyAccessToken();

  const query = `
    query GetOrders($cursor: String) {
      orders(
        first: 250
        after: $cursor
        sortKey: CREATED_AT
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }

        nodes {
          id
          name
          createdAt
          updatedAt
          cancelledAt
          displayFinancialStatus

          customer {
            id
            displayName
          }

          app {
            id
            name
          }

          retailLocation {
            id
            name
          }

          shippingAddress {
            countryCodeV2
            country
          }

          lineItems(first: 250) {
            nodes {
              id
              name
              title
              variantTitle
              sku
              quantity
              currentQuantity
              taxable
              requiresShipping
              isGiftCard
              vendor

              product {
                id
                title
                productType
                vendor
              }

              variant {
                id
                title
              }

              originalUnitPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
                presentmentMoney {
                  amount
                  currencyCode
                }
              }

              originalTotalSet {
                shopMoney {
                  amount
                  currencyCode
                }
                presentmentMoney {
                  amount
                  currencyCode
                }
              }

              discountedTotalSet(withCodeDiscounts: true) {
                shopMoney {
                  amount
                  currencyCode
                }
                presentmentMoney {
                  amount
                  currencyCode
                }
              }

              totalDiscountSet {
                shopMoney {
                  amount
                  currencyCode
                }
                presentmentMoney {
                  amount
                  currencyCode
                }
              }

              customAttributes {
                key
                value
              }

              taxLines {
                title
                rate
                ratePercentage

                priceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }

                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }

              discountAllocations {
                allocatedAmountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }

                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let cursor = null;
  let hasNextPage = true;
  let orders = [];
  let page = 0;

  while (hasNextPage) {
    page++;

    console.log(
      `Fetching Shopify page ${page}...`
    );

    const data =
      await shopifyGraphQL(
        token,
        query,
        { cursor }
      );

    const connection = data.orders;

    orders.push(
      ...connection.nodes
    );

    hasNextPage =
      connection.pageInfo.hasNextPage;

    cursor =
      connection.pageInfo.endCursor;

    console.log(
      `Fetched ${orders.length} orders so far`
    );
  }

  return orders;
}

async function getAllOrderFinancialsAndRefunds() {
  const token =
    await getShopifyAccessToken();

  const query = `
    query GetOrderFinancials($cursor: String) {
      orders(
        first: 50
        after: $cursor
        sortKey: CREATED_AT
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }

        nodes {
          id
          name
          createdAt
          updatedAt
          processedAt
          cancelledAt
          currencyCode
          presentmentCurrencyCode
          paymentGatewayNames

transactions {
  id
  kind
  status
  gateway
  createdAt
  processedAt

  amountSet {
    shopMoney {
      amount
      currencyCode
    }
    presentmentMoney {
      amount
      currencyCode
    }
  }
}

app {
            id
            name
          }

          totalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }

          subtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }

          totalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }

          totalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }

          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }

          totalRefundedSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }

          totalReceivedSet {
            shopMoney {
              amount
              currencyCode
            }
            presentmentMoney {
              amount
              currencyCode
            }
          }

          refunds {
            id
            createdAt
            processedAt
            updatedAt
            note

            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
              }
              presentmentMoney {
                amount
                currencyCode
              }
            }

            refundLineItems(first: 100) {
              nodes {
                id
                quantity
                restocked
                restockType

                lineItem {
                  id
                  name
                  title
                  sku
                }

                subtotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }

                totalTaxSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }

            refundShippingLines(first: 25) {
              nodes {
                id

                subtotalAmountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }

                taxAmountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }

            orderAdjustments(first: 25) {
              nodes {
                id
                reason

                amountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }

                taxAmountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }

            transactions(first: 50) {
              nodes {
                id
                kind
                status
                gateway
                createdAt
                processedAt

                amountSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  let cursor = null;
  let hasNextPage = true;
  let orders = [];
  let page = 0;

  while (hasNextPage) {
    page++;

    console.log(
      `Fetching Shopify financial/refund page ${page}...`
    );

    const data =
      await shopifyGraphQL(
        token,
        query,
        { cursor }
      );

    const connection =
      data.orders;

    orders.push(
      ...connection.nodes
    );

    hasNextPage =
      connection.pageInfo.hasNextPage;

    cursor =
      connection.pageInfo.endCursor;

    console.log(
      `Fetched ${orders.length} Shopify financial/refund orders so far`
    );
  }

  return orders;
}

async function ensureBigQueryTable() {
  const dataset =
    bigquery.dataset(DATASET);

  const table =
    dataset.table(TABLE);

  const [exists] =
    await table.exists();

  if (exists) {
    return;
  }

  console.log(
    `Creating ${GOOGLE_PROJECT_ID}.${DATASET}.${TABLE}`
  );

  await dataset.createTable(
    TABLE,
    {
      schema: [
        {
          name: 'order_id',
          type: 'STRING',
          mode: 'REQUIRED'
        },
        {
          name: 'order_name',
          type: 'STRING'
        },
        {
          name: 'created_at',
          type: 'TIMESTAMP'
        },
        {
          name: 'updated_at',
          type: 'TIMESTAMP'
        },
        {
          name: 'order_source',
          type: 'STRING'
        },
        {
          name: 'source_app_id',
          type: 'STRING'
        },
        {
          name: 'retail_location_id',
          type: 'STRING'
        },
        {
          name: 'retail_location_name',
          type: 'STRING'
        },
        {
          name: 'synced_at',
          type: 'TIMESTAMP'
        }
      ]
    }
  );
}

async function ensureLineItemsTable() {
  const dataset =
    bigquery.dataset(DATASET);

  const table =
    dataset.table(LINE_ITEMS_TABLE);

  const [exists] =
    await table.exists();

  if (exists) {
    return table;
  }

  console.log(
    `Creating ${GOOGLE_PROJECT_ID}.${DATASET}.${LINE_ITEMS_TABLE}`
  );

  await dataset.createTable(
    LINE_ITEMS_TABLE,
    {
      schema: [
        {
          name: 'order_id',
          type: 'STRING',
          mode: 'REQUIRED'
        },
        {
          name: 'order_name',
          type: 'STRING'
        },
        {
          name: 'order_created_at',
          type: 'TIMESTAMP'
        },

        {
          name: 'line_item_id',
          type: 'STRING',
          mode: 'REQUIRED'
        },

        {
          name: 'product_id',
          type: 'STRING'
        },
        {
          name: 'variant_id',
          type: 'STRING'
        },

        {
          name: 'name',
          type: 'STRING'
        },
        {
          name: 'title',
          type: 'STRING'
        },
        {
          name: 'variant_title',
          type: 'STRING'
        },
        {
          name: 'sku',
          type: 'STRING'
        },

        {
          name: 'quantity',
          type: 'INT64'
        },
        {
          name: 'current_quantity',
          type: 'INT64'
        },

        {
          name: 'is_gift_card',
          type: 'BOOL'
        },
        {
          name: 'taxable',
          type: 'BOOL'
        },
        {
          name: 'requires_shipping',
          type: 'BOOL'
        },

        {
          name: 'vendor',
          type: 'STRING'
        },
        {
          name: 'product_type',
          type: 'STRING'
        },

        {
          name: 'shop_currency',
          type: 'STRING'
        },
        {
          name: 'presentment_currency',
          type: 'STRING'
        },

        {
          name: 'original_unit_price_shop',
          type: 'NUMERIC'
        },
        {
          name: 'original_unit_price_presentment',
          type: 'NUMERIC'
        },

        {
          name: 'original_total_shop',
          type: 'NUMERIC'
        },
        {
          name: 'original_total_presentment',
          type: 'NUMERIC'
        },

        {
          name: 'discounted_total_shop',
          type: 'NUMERIC'
        },
        {
          name: 'discounted_total_presentment',
          type: 'NUMERIC'
        },

        {
          name: 'total_discount_shop',
          type: 'NUMERIC'
        },
        {
          name: 'total_discount_presentment',
          type: 'NUMERIC'
        },

        {
          name: 'tax_shop',
          type: 'NUMERIC'
        },
        {
          name: 'tax_presentment',
          type: 'NUMERIC'
        },

        {
          name: 'custom_attributes_json',
          type: 'STRING'
        },
        {
          name: 'tax_lines_json',
          type: 'STRING'
        },
        {
          name: 'discount_allocations_json',
          type: 'STRING'
        },

        {
          name: 'synced_at',
          type: 'TIMESTAMP'
        }
      ]
    }
  );

  return dataset.table(
    LINE_ITEMS_TABLE
  );
}

async function ensureOrderCustomersTable() {
  const dataset = bigquery.dataset(DATASET);
  const table = dataset.table(ORDER_CUSTOMERS_TABLE);

  const [exists] = await table.exists();

  if (exists) {
    return table;
  }

  console.log(
    `Creating ${GOOGLE_PROJECT_ID}.${DATASET}.${ORDER_CUSTOMERS_TABLE}`
  );

  await dataset.createTable(ORDER_CUSTOMERS_TABLE, {
    schema: [
      { name: 'order_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'order_name', type: 'STRING' },
      { name: 'order_created_at', type: 'TIMESTAMP' },
      { name: 'customer_id', type: 'STRING' },
      { name: 'customer_name', type: 'STRING' },
      { name: 'is_guest', type: 'BOOL', mode: 'REQUIRED' },
      { name: 'cancelled_at', type: 'TIMESTAMP' },
      { name: 'display_financial_status', type: 'STRING' },
      { name: 'source_app_id', type: 'STRING' },
      { name: 'source_app_name', type: 'STRING' },
      { name: 'synced_at', type: 'TIMESTAMP' }
    ]
  });

  return dataset.table(ORDER_CUSTOMERS_TABLE);
}

async function ensureFinancialsTable() {
  const dataset = bigquery.dataset(DATASET);
  const table = dataset.table(FINANCIALS_TABLE);

  const [exists] = await table.exists();

  if (exists) {
    return table;
  }

  console.log(
    `Creating ${GOOGLE_PROJECT_ID}.${DATASET}.${FINANCIALS_TABLE}`
  );

  await dataset.createTable(FINANCIALS_TABLE, {
    schema: [
      { name: 'order_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'order_name', type: 'STRING' },

      { name: 'created_at', type: 'TIMESTAMP' },
      { name: 'processed_at', type: 'TIMESTAMP' },
      { name: 'updated_at', type: 'TIMESTAMP' },
      { name: 'cancelled_at', type: 'TIMESTAMP' },

      { name: 'order_source', type: 'STRING' },

      { name: 'shop_currency', type: 'STRING' },
      { name: 'presentment_currency', type: 'STRING' },

      { name: 'original_total_shop', type: 'NUMERIC' },
      { name: 'original_total_presentment', type: 'NUMERIC' },

      { name: 'original_subtotal_shop', type: 'NUMERIC' },
      { name: 'original_subtotal_presentment', type: 'NUMERIC' },

      { name: 'original_tax_shop', type: 'NUMERIC' },
      { name: 'original_tax_presentment', type: 'NUMERIC' },

      { name: 'original_discounts_shop', type: 'NUMERIC' },
      { name: 'original_discounts_presentment', type: 'NUMERIC' },

      { name: 'original_shipping_shop', type: 'NUMERIC' },
      { name: 'original_shipping_presentment', type: 'NUMERIC' },

      { name: 'total_refunded_shop', type: 'NUMERIC' },
      { name: 'total_refunded_presentment', type: 'NUMERIC' },

      { name: 'total_received_shop', type: 'NUMERIC' },
      { name: 'total_received_presentment', type: 'NUMERIC' },

      { name: 'payment_gateway_names_json', type: 'STRING' },

      { name: 'transactions_json', type: 'STRING' },

      { name: 'synced_at', type: 'TIMESTAMP' }
    ]
  });

  return dataset.table(FINANCIALS_TABLE);
}


async function ensureRefundsTable() {
  const dataset = bigquery.dataset(DATASET);
  const table = dataset.table(REFUNDS_TABLE);

  const [exists] = await table.exists();

  if (exists) {
    return table;
  }

  console.log(
    `Creating ${GOOGLE_PROJECT_ID}.${DATASET}.${REFUNDS_TABLE}`
  );

  await dataset.createTable(REFUNDS_TABLE, {
    schema: [
      { name: 'refund_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'order_id', type: 'STRING', mode: 'REQUIRED' },
      { name: 'order_name', type: 'STRING' },

      { name: 'refund_created_at', type: 'TIMESTAMP' },
      { name: 'refund_processed_at', type: 'TIMESTAMP' },
      { name: 'refund_updated_at', type: 'TIMESTAMP' },

      { name: 'shop_currency', type: 'STRING' },
      { name: 'presentment_currency', type: 'STRING' },

      { name: 'refund_total_shop', type: 'NUMERIC' },
      { name: 'refund_total_presentment', type: 'NUMERIC' },

      { name: 'refund_line_subtotal_shop', type: 'NUMERIC' },
      { name: 'refund_line_subtotal_presentment', type: 'NUMERIC' },

      { name: 'refund_shipping_subtotal_shop', type: 'NUMERIC' },
      { name: 'refund_shipping_subtotal_presentment', type: 'NUMERIC' },

      { name: 'refund_line_tax_shop', type: 'NUMERIC' },
      { name: 'refund_line_tax_presentment', type: 'NUMERIC' },

      { name: 'refund_shipping_tax_shop', type: 'NUMERIC' },
      { name: 'refund_shipping_tax_presentment', type: 'NUMERIC' },

      { name: 'refund_adjustment_tax_shop', type: 'NUMERIC' },
      { name: 'refund_adjustment_tax_presentment', type: 'NUMERIC' },

      { name: 'refund_tax_shop', type: 'NUMERIC' },
      { name: 'refund_tax_presentment', type: 'NUMERIC' },

      { name: 'successful_transaction_shop', type: 'NUMERIC' },
      { name: 'successful_transaction_presentment', type: 'NUMERIC' },
      { name: 'has_successful_refund_transaction', type: 'BOOL' },

      { name: 'note', type: 'STRING' },

      { name: 'refund_line_items_json', type: 'STRING' },
      { name: 'refund_shipping_lines_json', type: 'STRING' },
      { name: 'order_adjustments_json', type: 'STRING' },
      { name: 'transactions_json', type: 'STRING' },

      { name: 'synced_at', type: 'TIMESTAMP' }
    ]
  });

  return dataset.table(REFUNDS_TABLE);
}


function moneyAmount(moneyBag, side = 'shopMoney') {
  const value = moneyBag?.[side]?.amount;

  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return 0;
  }

  return Number(value);
}


function transformFinancials(orders) {
  const syncedAt = new Date().toISOString();

  return orders.map(order => ({
    order_id: order.id,
    order_name: order.name || null,

    created_at: order.createdAt || null,
    processed_at: order.processedAt || null,
    updated_at: order.updatedAt || null,
    cancelled_at: order.cancelledAt || null,

    order_source: order.app?.name || null,

    shop_currency:
      order.totalPriceSet?.shopMoney?.currencyCode ||
      order.currencyCode ||
      null,

    presentment_currency:
      order.totalPriceSet?.presentmentMoney?.currencyCode ||
      order.presentmentCurrencyCode ||
      null,

    original_total_shop:
      moneyAmount(order.totalPriceSet, 'shopMoney'),

    original_total_presentment:
      moneyAmount(order.totalPriceSet, 'presentmentMoney'),

    original_subtotal_shop:
      moneyAmount(order.subtotalPriceSet, 'shopMoney'),

    original_subtotal_presentment:
      moneyAmount(order.subtotalPriceSet, 'presentmentMoney'),

    original_tax_shop:
      moneyAmount(order.totalTaxSet, 'shopMoney'),

    original_tax_presentment:
      moneyAmount(order.totalTaxSet, 'presentmentMoney'),

    original_discounts_shop:
      moneyAmount(order.totalDiscountsSet, 'shopMoney'),

    original_discounts_presentment:
      moneyAmount(order.totalDiscountsSet, 'presentmentMoney'),

    original_shipping_shop:
      moneyAmount(order.totalShippingPriceSet, 'shopMoney'),

    original_shipping_presentment:
      moneyAmount(order.totalShippingPriceSet, 'presentmentMoney'),

    total_refunded_shop:
      moneyAmount(order.totalRefundedSet, 'shopMoney'),

    total_refunded_presentment:
      moneyAmount(order.totalRefundedSet, 'presentmentMoney'),

    total_received_shop:
      moneyAmount(order.totalReceivedSet, 'shopMoney'),

    total_received_presentment:
      moneyAmount(order.totalReceivedSet, 'presentmentMoney'),

    payment_gateway_names_json:
      JSON.stringify(order.paymentGatewayNames || []),

    transactions_json:
      JSON.stringify(order.transactions || []),

    synced_at: syncedAt
  }));
}


function transformRefunds(orders) {
  const syncedAt = new Date().toISOString();
  const rows = [];

  for (const order of orders) {
    const refunds = order.refunds || [];

    for (const refund of refunds) {
      const lineItems =
        refund.refundLineItems?.nodes || [];

      const shippingLines =
        refund.refundShippingLines?.nodes || [];

      const adjustments =
        refund.orderAdjustments?.nodes || [];

      const transactions =
        refund.transactions?.nodes || [];

      const lineSubtotalShop =
        lineItems.reduce(
          (sum, item) =>
            sum + moneyAmount(item.subtotalSet, 'shopMoney'),
          0
        );

      const lineSubtotalPresentment =
        lineItems.reduce(
          (sum, item) =>
            sum + moneyAmount(item.subtotalSet, 'presentmentMoney'),
          0
        );

      const shippingSubtotalShop =
        shippingLines.reduce(
          (sum, item) =>
            sum + moneyAmount(item.subtotalAmountSet, 'shopMoney'),
          0
        );

      const shippingSubtotalPresentment =
        shippingLines.reduce(
          (sum, item) =>
            sum + moneyAmount(item.subtotalAmountSet, 'presentmentMoney'),
          0
        );

      const lineTaxShop =
        lineItems.reduce(
          (sum, item) =>
            sum + moneyAmount(item.totalTaxSet, 'shopMoney'),
          0
        );

      const lineTaxPresentment =
        lineItems.reduce(
          (sum, item) =>
            sum + moneyAmount(item.totalTaxSet, 'presentmentMoney'),
          0
        );

      const shippingTaxShop =
        shippingLines.reduce(
          (sum, item) =>
            sum + moneyAmount(item.taxAmountSet, 'shopMoney'),
          0
        );

      const shippingTaxPresentment =
        shippingLines.reduce(
          (sum, item) =>
            sum + moneyAmount(item.taxAmountSet, 'presentmentMoney'),
          0
        );

      const adjustmentTaxShop =
        adjustments.reduce(
          (sum, item) =>
            sum + moneyAmount(item.taxAmountSet, 'shopMoney'),
          0
        );

      const adjustmentTaxPresentment =
        adjustments.reduce(
          (sum, item) =>
            sum + moneyAmount(item.taxAmountSet, 'presentmentMoney'),
          0
        );

      const successfulRefundTransactions =
        transactions.filter(
          transaction =>
            transaction.kind === 'REFUND' &&
            transaction.status === 'SUCCESS'
        );

      const successfulTransactionShop =
        successfulRefundTransactions.reduce(
          (sum, transaction) =>
            sum + moneyAmount(transaction.amountSet, 'shopMoney'),
          0
        );

      const successfulTransactionPresentment =
        successfulRefundTransactions.reduce(
          (sum, transaction) =>
            sum + moneyAmount(transaction.amountSet, 'presentmentMoney'),
          0
        );

      rows.push({
        refund_id: refund.id,
        order_id: order.id,
        order_name: order.name || null,

        refund_created_at:
          refund.createdAt || null,

        refund_processed_at:
          refund.processedAt || null,

        refund_updated_at:
          refund.updatedAt || null,

        shop_currency:
          refund.totalRefundedSet?.shopMoney?.currencyCode ||
          order.currencyCode ||
          null,

        presentment_currency:
          refund.totalRefundedSet?.presentmentMoney?.currencyCode ||
          order.presentmentCurrencyCode ||
          null,

        refund_total_shop:
          moneyAmount(refund.totalRefundedSet, 'shopMoney'),

        refund_total_presentment:
          moneyAmount(refund.totalRefundedSet, 'presentmentMoney'),

        refund_line_subtotal_shop:
          Number(lineSubtotalShop.toFixed(2)),

        refund_line_subtotal_presentment:
          Number(lineSubtotalPresentment.toFixed(2)),

        refund_shipping_subtotal_shop:
          Number(shippingSubtotalShop.toFixed(2)),

        refund_shipping_subtotal_presentment:
          Number(shippingSubtotalPresentment.toFixed(2)),

        refund_line_tax_shop:
          Number(lineTaxShop.toFixed(2)),

        refund_line_tax_presentment:
          Number(lineTaxPresentment.toFixed(2)),

        refund_shipping_tax_shop:
          Number(shippingTaxShop.toFixed(2)),

        refund_shipping_tax_presentment:
          Number(shippingTaxPresentment.toFixed(2)),

        refund_adjustment_tax_shop:
          Number(adjustmentTaxShop.toFixed(2)),

        refund_adjustment_tax_presentment:
          Number(adjustmentTaxPresentment.toFixed(2)),

        refund_tax_shop:
          Number(
            (
              lineTaxShop +
              shippingTaxShop +
              adjustmentTaxShop
            ).toFixed(2)
          ),

        refund_tax_presentment:
          Number(
            (
              lineTaxPresentment +
              shippingTaxPresentment +
              adjustmentTaxPresentment
            ).toFixed(2)
          ),

        successful_transaction_shop:
          Number(successfulTransactionShop.toFixed(2)),

        successful_transaction_presentment:
          Number(successfulTransactionPresentment.toFixed(2)),

        has_successful_refund_transaction:
          successfulRefundTransactions.length > 0,

        note: refund.note || null,

        refund_line_items_json:
          JSON.stringify(lineItems),

        refund_shipping_lines_json:
          JSON.stringify(shippingLines),

        order_adjustments_json:
          JSON.stringify(adjustments),

        transactions_json:
          JSON.stringify(transactions),

        synced_at: syncedAt
      });
    }
  }

  return rows;
}

function transformOrders(orders) {
  const syncedAt =
    new Date().toISOString();

  return orders.map(order => ({
    order_id:
      order.id,

    order_name:
      order.name || null,

    created_at:
      order.createdAt || null,

    updated_at:
      order.updatedAt || null,

    order_source:
      order.app?.name || null,

    source_app_id:
      order.app?.id || null,

    retail_location_id:
      order.retailLocation?.id || null,

    retail_location_name:
      order.retailLocation?.name || null,

    synced_at:
      syncedAt
  }));
}

function transformLineItems(orders) {
  const syncedAt =
    new Date().toISOString();

  const rows = [];

  for (const order of orders) {
    const lineItems =
      order.lineItems?.nodes || [];

    for (const item of lineItems) {
      const taxLines =
        item.taxLines || [];

      const taxShop =
        taxLines.reduce(
          (sum, tax) =>
            sum +
            Number(
              tax.priceSet
                ?.shopMoney
                ?.amount || 0
            ),
          0
        );

      const taxPresentment =
        taxLines.reduce(
          (sum, tax) =>
            sum +
            Number(
              tax.priceSet
                ?.presentmentMoney
                ?.amount || 0
            ),
          0
        );

      rows.push({
        order_id:
          order.id,

        order_name:
          order.name || null,

        order_created_at:
          order.createdAt || null,

        line_item_id:
          item.id,

        product_id:
          item.product?.id || null,

        variant_id:
          item.variant?.id || null,

        name:
          item.name || null,

        title:
          item.title || null,

        variant_title:
          item.variantTitle || null,

        sku:
          item.sku || null,

        quantity:
          item.quantity ?? 0,

        current_quantity:
          item.currentQuantity ?? 0,

        is_gift_card:
          item.isGiftCard === true,

        taxable:
          item.taxable === true,

        requires_shipping:
          item.requiresShipping === true,

        vendor:
          item.vendor ||
          item.product?.vendor ||
          null,

        product_type:
          item.product?.productType ||
          null,

        shop_currency:
          item.originalTotalSet
            ?.shopMoney
            ?.currencyCode || null,

        presentment_currency:
          item.originalTotalSet
            ?.presentmentMoney
            ?.currencyCode || null,

        original_unit_price_shop:
          Number(
            item.originalUnitPriceSet
              ?.shopMoney
              ?.amount || 0
          ),

        original_unit_price_presentment:
          Number(
            item.originalUnitPriceSet
              ?.presentmentMoney
              ?.amount || 0
          ),

        original_total_shop:
          Number(
            item.originalTotalSet
              ?.shopMoney
              ?.amount || 0
          ),

        original_total_presentment:
          Number(
            item.originalTotalSet
              ?.presentmentMoney
              ?.amount || 0
          ),

        discounted_total_shop:
          Number(
            item.discountedTotalSet
              ?.shopMoney
              ?.amount || 0
          ),

        discounted_total_presentment:
          Number(
            item.discountedTotalSet
              ?.presentmentMoney
              ?.amount || 0
          ),

        total_discount_shop:
          Number(
            item.totalDiscountSet
              ?.shopMoney
              ?.amount || 0
          ),

        total_discount_presentment:
          Number(
            item.totalDiscountSet
              ?.presentmentMoney
              ?.amount || 0
          ),

        tax_shop:
          Number(
            taxShop.toFixed(2)
          ),

        tax_presentment:
          Number(
            taxPresentment.toFixed(2)
          ),

        custom_attributes_json:
          JSON.stringify(
            item.customAttributes || []
          ),

        tax_lines_json:
          JSON.stringify(
            item.taxLines || []
          ),

        discount_allocations_json:
          JSON.stringify(
            item.discountAllocations || []
          ),

        synced_at:
          syncedAt
      });
    }
  }

  return rows;
}

function transformOrderCustomers(orders) {
  const syncedAt = new Date().toISOString();

  return orders.map(order => ({
    order_id: order.id,
    order_name: order.name || null,
    order_created_at: order.createdAt || null,
    customer_id: order.customer?.id || null,
    customer_name: order.customer?.displayName || null,
    is_guest: !order.customer?.id,
    cancelled_at: order.cancelledAt || null,
    display_financial_status:
      order.displayFinancialStatus || null,
    source_app_id: order.app?.id || null,
    source_app_name: order.app?.name || null,
    synced_at: syncedAt
  }));
}

async function replaceBigQueryData(
  rows
) {
  await ensureBigQueryTable();

  console.log(
    'Clearing existing order location data...'
  );

  await bigquery.query({
    query: `
      TRUNCATE TABLE
      \`${GOOGLE_PROJECT_ID}.${DATASET}.${TABLE}\`
    `
  });

  console.log(
    `Writing ${rows.length} rows to BigQuery...`
  );

  const table = bigquery
    .dataset(DATASET)
    .table(TABLE);

  const batchSize = 500;

  for (
    let i = 0;
    i < rows.length;
    i += batchSize
  ) {
    const batch = rows.slice(
      i,
      i + batchSize
    );

    await table.insert(batch);

    console.log(
      `Inserted ${Math.min(
        i + batch.length,
        rows.length
      )}/${rows.length}`
    );
  }
}

async function replaceLineItemsData(
  rows
) {
  const table =
    await ensureLineItemsTable();

  console.log(
    'Clearing existing Shopify line item data...'
  );

  await bigquery.query({
    query: `
      TRUNCATE TABLE
      \`${GOOGLE_PROJECT_ID}.${DATASET}.${LINE_ITEMS_TABLE}\`
    `
  });

  console.log(
    `Writing ${rows.length} Shopify line items to BigQuery...`
  );

  const batchSize = 500;

  for (
    let i = 0;
    i < rows.length;
    i += batchSize
  ) {
    const batch = rows.slice(
      i,
      i + batchSize
    );

    await table.insert(batch);

    console.log(
      `Inserted ${Math.min(
        i + batch.length,
        rows.length
      )}/${rows.length} Shopify line items`
    );
  }
}

async function replaceOrderCustomersData(rows) {
  const table = await ensureOrderCustomersTable();

  console.log(
    'Clearing existing Shopify order customer data...'
  );

  await bigquery.query({
    query: `
      TRUNCATE TABLE
      \`${GOOGLE_PROJECT_ID}.${DATASET}.${ORDER_CUSTOMERS_TABLE}\`
    `
  });

  console.log(
    `Writing ${rows.length} Shopify order customer rows to BigQuery...`
  );

  const batchSize = 500;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    await table.insert(batch);

    console.log(
      `Inserted ${Math.min(
        i + batch.length,
        rows.length
      )}/${rows.length} Shopify order customer rows`
    );
  }
}

async function replaceFinancialsData(rows) {
  const table = await ensureFinancialsTable();

  console.log(
    'Clearing existing Shopify financial data...'
  );

  await bigquery.query({
    query: `
      TRUNCATE TABLE
      \`${GOOGLE_PROJECT_ID}.${DATASET}.${FINANCIALS_TABLE}\`
    `
  });

  console.log(
    `Writing ${rows.length} Shopify financial rows to BigQuery...`
  );

  const batchSize = 500;

  for (
    let i = 0;
    i < rows.length;
    i += batchSize
  ) {
    const batch = rows.slice(i, i + batchSize);

    await table.insert(batch);

    console.log(
      `Inserted ${Math.min(
        i + batch.length,
        rows.length
      )}/${rows.length} Shopify financial rows`
    );
  }
}


async function replaceRefundsData(rows) {
  const table = await ensureRefundsTable();

  console.log(
    'Clearing existing Shopify refund data...'
  );

  await bigquery.query({
    query: `
      TRUNCATE TABLE
      \`${GOOGLE_PROJECT_ID}.${DATASET}.${REFUNDS_TABLE}\`
    `
  });

  console.log(
    `Writing ${rows.length} Shopify refunds to BigQuery...`
  );

  const batchSize = 500;

  for (
    let i = 0;
    i < rows.length;
    i += batchSize
  ) {
    const batch = rows.slice(i, i + batchSize);

    await table.insert(batch);

    console.log(
      `Inserted ${Math.min(
        i + batch.length,
        rows.length
      )}/${rows.length} Shopify refunds`
    );
  }
}

async function syncShopify() {
  console.log(
    'Starting Shopify sync'
  );

  const orders =
    await getAllOrders();

  console.log(
    `Shopify returned ${orders.length} orders for metadata/line items`
  );

  const financialOrders =
    await getAllOrderFinancialsAndRefunds();

  console.log(
    `Shopify returned ${financialOrders.length} orders for financials/refunds`
  );

  const orderRows =
    transformOrders(orders);

  const shippingGeographyRows =
    orders.filter(order => order.app?.id !== MATRIXIFY_SOURCE_APP_ID)
      .map(order => normalizeShippingGeography(order));

  const lineItemRows =
    transformLineItems(orders);

  const orderCustomerRows =
    transformOrderCustomers(orders);

  const financialRows =
    transformFinancials(financialOrders);

  const refundRows =
    transformRefunds(financialOrders);

  console.log(
    `Extracted ${lineItemRows.length} Shopify line items`
  );

  console.log(
    `Extracted ${orderCustomerRows.length} Shopify order customer rows`
  );

  console.log(
    `Extracted ${financialRows.length} Shopify financial rows`
  );

  console.log(
    `Extracted ${refundRows.length} Shopify refunds`
  );

  await replaceBigQueryData(
    orderRows
  );

  await replaceLineItemsData(
    lineItemRows
  );

  await replaceOrderCustomersData(
    orderCustomerRows
  );

  await replaceFinancialsData(
    financialRows
  );

  await replaceRefundsData(
    refundRows
  );

  await persistShippingGeography({ bigquery, project: GOOGLE_PROJECT_ID,
    rows: shippingGeographyRows, mode: 'backfill' });

  console.log(
    'Shopify sync complete'
  );

  return {
    ordersFetched:
      orders.length,

    financialOrdersFetched:
      financialOrders.length,

    orderRowsWritten:
      orderRows.length,

    lineItemsWritten:
      lineItemRows.length,

    orderCustomerRowsWritten:
      orderCustomerRows.length,

    financialRowsWritten:
      financialRows.length,

    refundsWritten:
      refundRows.length,

    shippingGeographyRowsWritten:
      shippingGeographyRows.length
  };
}

/* =========================================================
   AUTH
========================================================= */

function requireSyncSecret(
  req,
  res,
  next
) {
  if (!SYNC_SECRET) {
    return res
      .status(500)
      .json({
        success: false,
        error:
          'SYNC_SECRET is not configured'
      });
  }

  const auth =
    req.headers.authorization;

  if (
    auth !==
    `Bearer ${SYNC_SECRET}`
  ) {
    return res
      .status(401)
      .json({
        success: false,
        error: 'Unauthorized'
      });
  }

  next();
}

/* =========================================================
   WOO REFUNDS
========================================================= */

async function syncWooRefunds({
  storeName,
  datasetName,
  wooUrlRaw,
  consumerKey,
  consumerSecret
}) {
  if (
    !wooUrlRaw ||
    !consumerKey ||
    !consumerSecret
  ) {
    throw new Error(
      `Missing WooCommerce ${storeName} environment variables`
    );
  }

  const wooUrl =
    wooUrlRaw.replace(
      /\/$/,
      ''
    );

  console.log(
    `Starting WooCommerce ${storeName} refund sync`
  );

  /*
   * Coupler flattens Woo orders by line item,
   * so DISTINCT order IDs are essential.
   *
   * We only need to hit the API for orders where
   * the Coupler orders table tells us refund data exists.
   */
  const [orders] =
    await bigquery.query({
      query: `
        SELECT DISTINCT
          CAST(id AS STRING) AS order_id
        FROM
          \`${GOOGLE_PROJECT_ID}.${datasetName}.orders\`
        WHERE
          refunds IS NOT NULL
          AND TRIM(refunds) NOT IN (
            '',
            '[]',
            '{}'
          )
        ORDER BY
          order_id
      `
    });

  console.log(
    `Found ${orders.length} Woo ${storeName} orders containing refunds`
  );

  const auth =
    Buffer.from(
      `${consumerKey}:${consumerSecret}`
    ).toString('base64');

  const refundRows = [];

  let failedOrders = 0;

  for (const order of orders) {
    const orderId =
      order.order_id;

    const endpoint =
      `${wooUrl}/wp-json/wc/v3/orders/${orderId}/refunds?per_page=100`;

    const response =
      await fetch(
        endpoint,
        {
          headers: {
            Authorization:
              `Basic ${auth}`,

            Accept:
              'application/json'
          }
        }
      );

    if (!response.ok) {
      failedOrders++;

      const body =
        await response.text();

      console.error(
        `Woo ${storeName} refund fetch failed for order ${orderId}:`,
        response.status,
        body
      );

      continue;
    }

    const refunds =
      await response.json();

    if (
      !Array.isArray(refunds)
    ) {
      console.error(
        `Unexpected Woo ${storeName} refund response for order ${orderId}:`,
        refunds
      );

      failedOrders++;
      continue;
    }

    for (
      const refund of refunds
    ) {
      refundRows.push({
        refund_id:
          String(refund.id),

        order_id:
          String(orderId),

        refund_date:
          refund.date_created_gmt
            ? new Date(
                `${refund.date_created_gmt}Z`
              ).toISOString()
            : null,

        refund_amount:
          refund.amount !==
            undefined &&
          refund.amount !== null &&
          refund.amount !== ''
            ? Number(refund.amount)
            : 0,

        reason:
          refund.reason || null,

        refunded_by:
          refund.refunded_by !==
            undefined &&
          refund.refunded_by !== null
            ? String(
                refund.refunded_by
              )
            : null,

        api_refunded:
          refund.api_refund ===
          true,

        line_items_json:
          refund.line_items
            ? JSON.stringify(
                refund.line_items
              )
            : null,

        synced_at:
          new Date().toISOString()
      });
    }
  }

  console.log(
    `Found ${refundRows.length} individual Woo ${storeName} refunds`
  );

  if (failedOrders > 0) {
    console.warn(
      `${failedOrders} Woo ${storeName} orders failed during refund sync`
    );
  }

  const dataset =
    bigquery.dataset(
      datasetName
    );

  const tableName =
    'refunds_api';

  const table =
    dataset.table(
      tableName
    );

  const [exists] =
    await table.exists();

  if (!exists) {
    console.log(
      `Creating ${GOOGLE_PROJECT_ID}.${datasetName}.${tableName}`
    );

    await dataset.createTable(
      tableName,
      {
        schema: [
          {
            name: 'refund_id',
            type: 'STRING',
            mode: 'REQUIRED'
          },
          {
            name: 'order_id',
            type: 'STRING',
            mode: 'REQUIRED'
          },
          {
            name: 'refund_date',
            type: 'TIMESTAMP'
          },
          {
            name: 'refund_amount',
            type: 'NUMERIC'
          },
          {
            name: 'reason',
            type: 'STRING'
          },
          {
            name: 'refunded_by',
            type: 'STRING'
          },
          {
            name: 'api_refunded',
            type: 'BOOL'
          },
          {
            name: 'line_items_json',
            type: 'STRING'
          },
          {
            name: 'synced_at',
            type: 'TIMESTAMP'
          }
        ]
      }
    );
  } else {
    console.log(
      `Clearing ${GOOGLE_PROJECT_ID}.${datasetName}.${tableName}`
    );

    await bigquery.query({
      query: `
        TRUNCATE TABLE
        \`${GOOGLE_PROJECT_ID}.${datasetName}.${tableName}\`
      `
    });
  }

  if (
    refundRows.length > 0
  ) {
    const freshTable =
      dataset.table(
        tableName
      );

    const batchSize = 500;

    for (
      let i = 0;
      i < refundRows.length;
      i += batchSize
    ) {
      const batch =
        refundRows.slice(
          i,
          i + batchSize
        );

      await freshTable.insert(
        batch
      );

      console.log(
        `Woo ${storeName}: inserted ${Math.min(
          i + batch.length,
          refundRows.length
        )}/${refundRows.length} refunds`
      );
    }
  }

  console.log(
    `WooCommerce ${storeName} refund sync complete`
  );

  return {
    store: storeName,
    dataset: datasetName,

    refund_orders_checked:
      orders.length,

    refunds_imported:
      refundRows.length,

    failed_orders:
      failedOrders
  };
}

/* =========================================================
   ACCOUNTANT EXPORT HELPERS
========================================================= */

function getAccountantColumnWidth(header) {
  const name = header.toLowerCase();

  if (name.includes('transaction_id') || name === 'order_id') {
    return 30;
  }

  if (name.includes('timestamp')) {
    return 22;
  }

  if ([
    'location',
    'sales_location',
    'payment_method',
    'country',
    'order_status',
    'tax_method',
    'source_transaction_kind'
  ].includes(name)) {
    return 24;
  }

  if (name === 'date' || name === 'month') {
    return 14;
  }

  return 17;
}

function styleHeaderRow(row) {
  row.height = 24;
  row.font = {
    bold: true,
    color: { argb: 'FFFFFFFF' }
  };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF202124' }
  };
  row.alignment = { vertical: 'middle' };
}

function cleanBigQueryValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    'value' in value
  ) {
    return value.value;
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    value.constructor?.name !== 'Date' &&
    typeof value.toString === 'function'
  ) {
    const stringValue = value.toString();

    if (stringValue !== '[object Object]') {
      const numberValue = Number(stringValue);

      if (!Number.isNaN(numberValue)) {
        return numberValue;
      }

      return stringValue;
    }
  }

  return value;
}

function formatDataRow(row, headers) {
  headers.forEach((header, index) => {
    const name = header.toLowerCase();
    const cell = row.getCell(index + 1);

    if ([
      'gross',
      'tax',
      'net',
      'discount',
      'shipping',
      'refund',
      'gift_card'
    ].some(word => name.includes(word))) {
      cell.numFmt = '#,##0.00;[Red](#,##0.00);-';
    }
  });
}

async function exportBigQueryViewToWorksheet(
  workbook,
  sheetName,
  tableName
) {
  const worksheet = workbook.addWorksheet(sheetName);

  const query = `
    SELECT *
    FROM \`${tableName}\`
  `;

  const [job] = await bigquery.createQueryJob({ query });

  console.log(`${sheetName}: BigQuery job ${job.id}`);

  let [rows, nextQuery] = await job.getQueryResults({
    maxResults: 2000,
    autoPaginate: false
  });

  if (!rows.length) {
    worksheet.addRow(['No data']).commit();
    worksheet.commit();
    return;
  }

  const headers = Object.keys(rows[0]);

  worksheet.columns = headers.map(header => ({
    header,
    key: header,
    width: getAccountantColumnWidth(header)
  }));

  styleHeaderRow(worksheet.getRow(1));
  worksheet.getRow(1).commit();

  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length }
  };

  let rowCount = 0;

  while (true) {
    for (const sourceRow of rows) {
      const cleanRow = {};

      for (const header of headers) {
        cleanRow[header] = cleanBigQueryValue(sourceRow[header]);
      }

      const excelRow = worksheet.addRow(cleanRow);
      formatDataRow(excelRow, headers);
      excelRow.commit();
      rowCount++;
    }

    console.log(`${sheetName}: ${rowCount} rows written`);

    if (!nextQuery || !nextQuery.pageToken) {
      break;
    }

    [rows, nextQuery] = await job.getQueryResults({
      maxResults: 2000,
      pageToken: nextQuery.pageToken,
      autoPaginate: false
    });
  }

  worksheet.commit();

  console.log(`${sheetName}: complete — ${rowCount} rows`);
}

async function getSalesByMonth({
  start_date,
  end_date,
  currency = 'GBP',
  location = null,
  channel = null,
  source = null
}) {
  const filters = [
    'date >= @start_date',
    'date <= @end_date',
    'currency = @currency'
  ];

  const params = {
    start_date,
    end_date,
    currency
  };

  if (location) {
    filters.push('LOWER(location) = LOWER(@location)');
    params.location = location;
  }

  if (channel) {
    filters.push('LOWER(channel) = LOWER(@channel)');
    params.channel = channel;
  }

  if (source) {
    filters.push('LOWER(source) = LOWER(@source)');
    params.source = source;
  }

  const query = `
    SELECT
      FORMAT_DATE('%Y-%m', date) AS month,

      COUNT(*) AS transaction_count,

      SUM(
        CASE
          WHEN transaction_type = 'sale'
          THEN gross
          ELSE 0
        END
      ) AS sales_gross,

      SUM(
        CASE
          WHEN transaction_type = 'refund'
          THEN gross
          ELSE 0
        END
      ) AS refunds_gross,

      SUM(gross) AS net_gross,

      SUM(tax) AS net_tax,

      SUM(net_ex_tax) AS net_ex_tax

    FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_transactions\`

    WHERE ${filters.join('\nAND ')}

    GROUP BY month
    ORDER BY month
  `;

  const [rows] = await bigquery.query({
    query,
    params
  });

  return rows;
}

async function getSalesSummary({
  start_date,
  end_date,
  currency = 'GBP',
  location = null,
  channel = null,
  source = null
}) {
  const filters = [
    'date >= @start_date',
    'date <= @end_date',
    'currency = @currency'
  ];

  const params = {
    start_date,
    end_date,
    currency
  };

  if (location) {
    filters.push('LOWER(location) = LOWER(@location)');
    params.location = location;
  }

  if (channel) {
    filters.push('LOWER(channel) = LOWER(@channel)');
    params.channel = channel;
  }

  if (source) {
    filters.push('LOWER(source) = LOWER(@source)');
    params.source = source;
  }

  const query = `
    SELECT
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN transaction_type = 'sale' THEN gross ELSE 0 END) AS sales_gross,
      SUM(CASE WHEN transaction_type = 'refund' THEN gross ELSE 0 END) AS refunds_gross,
      SUM(gross) AS net_gross,
      SUM(tax) AS net_tax,
      SUM(net_ex_tax) AS net_ex_tax
    FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_transactions\`
    WHERE ${filters.join('\nAND ')}
  `;

  const [rows] = await bigquery.query({
    query,
    params
  });

  return rows[0] || {};
}

async function getEcommerceFinanceReport({ start_date, end_date }) {
  const query = `
    SELECT
      currency,
      COUNTIF(transaction_type = 'sale') AS sales_transaction_count,
      COUNTIF(transaction_type = 'refund') AS refund_transaction_count,
      CAST(SUM(IF(transaction_type = 'sale', gross, 0)) AS FLOAT64) AS gross_sales,
      CAST(SUM(IF(transaction_type = 'refund', gross, 0)) AS FLOAT64) AS refunds,
      CAST(SUM(gross) AS FLOAT64) AS net_gross,
      CAST(SUM(tax) AS FLOAT64) AS tax,
      CAST(SUM(net_ex_tax) AS FLOAT64) AS net_ex_tax
    FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_transactions\`
    WHERE date >= @start_date AND date <= @end_date
    GROUP BY currency
    ORDER BY currency
  `;
  const [rows] = await bigquery.query({
    query,
    params: { start_date, end_date }
  });
  return rows;
}

async function getMetorikEcommerceEvidence({ start_date, end_date }) {
  validateShopifyReportDate(start_date, 'start_date');
  validateShopifyReportDate(end_date, 'end_date');
  if (start_date > end_date) {
    throw new Error('start_date must be on or before end_date');
  }

  const period = { start_date, end_date };
  const stores = Object.values(METORIK_STORES);
  const sources = await Promise.all(stores.map(async store => {
    // Dataset names come only from the fixed METORIK_STORES configuration, never
    // from report input. Currency remains a grouping key and is never converted.
    const customerQuery = `
      WITH order_metrics AS (
        SELECT
          currency,
          COUNT(*) AS orders,
          COUNT(DISTINCT customer_id) AS registered_purchasing_customers,
          COUNTIF(customer_id IS NULL) AS guest_orders
        FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDERS_TABLE}\`
        WHERE DATE(order_created_at) BETWEEN @start_date AND @end_date
        GROUP BY currency
      ),
      new_customer_metrics AS (
        SELECT
          currency,
          COUNT(DISTINCT metorik_customer_id) AS canonical_new_customers
        FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_CUSTOMERS_TABLE}\`
        WHERE DATE(first_order_date) BETWEEN @start_date AND @end_date
        GROUP BY currency
      )
      SELECT
        COALESCE(o.currency, n.currency) AS currency,
        CAST(COALESCE(o.orders, 0) AS FLOAT64) AS orders,
        CAST(COALESCE(o.registered_purchasing_customers, 0) AS FLOAT64)
          AS registered_purchasing_customers,
        CAST(COALESCE(o.guest_orders, 0) AS FLOAT64) AS guest_orders,
        CAST(COALESCE(n.canonical_new_customers, 0) AS FLOAT64)
          AS canonical_new_customers,
        SAFE_DIVIDE(o.orders, o.registered_purchasing_customers)
          AS orders_per_registered_customer
      FROM order_metrics o
      FULL OUTER JOIN new_customer_metrics n USING (currency)
      ORDER BY currency`;
    const productQuery = `
      WITH products AS (
        SELECT
          currency,
          product_id,
          variation_id,
          sku,
          ANY_VALUE(name HAVING MAX order_created_at) AS product_name,
          CAST(SUM(quantity) AS FLOAT64) AS quantity_sold,
          CAST(COUNT(DISTINCT order_id) AS FLOAT64) AS order_count,
          CAST(SUM(subtotal) AS FLOAT64) AS gross_line_sales,
          CAST(SUM(total) AS FLOAT64) AS net_line_sales
        FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDER_LINE_ITEMS_TABLE}\`
        WHERE DATE(order_created_at) BETWEEN @start_date AND @end_date
        GROUP BY currency, product_id, variation_id, sku
      )
      SELECT *
      FROM products
      QUALIFY ROW_NUMBER() OVER (
        PARTITION BY currency ORDER BY net_line_sales DESC, product_id, variation_id
      ) <= 10
      ORDER BY currency, net_line_sales DESC`;
    const params = { start_date, end_date };
    const [[customerRows], [productRows]] = await Promise.all([
      bigquery.query({ query: customerQuery, params }),
      bigquery.query({ query: productQuery, params })
    ]);
    const available = customerRows.length > 0 || productRows.length > 0;
    return {
      source: store.dataset,
      system: 'Metorik / WooCommerce',
      dataset: store.dataset,
      period,
      available,
      customers: {
        by_currency: customerRows,
        identity_models: {
          registered_purchasing_customers: 'Distinct non-null orders.customer_id (Woo identity); guests excluded.',
          canonical_new_customers: 'Distinct customers.metorik_customer_id with first_order_date in period; not joined to orders.'
        }
      },
      products: productRows,
      product_metrics: {
        quantity_sold: 'Sum of Metorik line-item quantity.',
        order_count: 'Distinct Woo order_id count containing the source-native product/variation/SKU grouping.',
        gross_line_sales: 'Sum of Metorik line-item subtotal, separated by source currency.',
        net_line_sales: 'Sum of Metorik line-item total, separated by source currency.'
      },
      product_identity: 'Source-native Woo product_id and variation_id; SKU is descriptive only and is not a cross-platform key.',
      attribution: {
        available_in_source: available,
        exposed_by_report: false,
        fields: ['landing_path', 'referer', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id']
      }
    };
  }));

  return { period, sources };
}

const getEcommerceManagementReport = createEcommerceManagementReportService({
  getFinanceReport: getEcommerceFinanceReport,
  getConversionKpis: getShopifyConversionKpis,
  getCustomerKpis: getShopifyCustomerKpis,
  getProductPerformance: getShopifyProductPerformance,
  getHistoricalEcommerce: getMetorikEcommerceEvidence
});

async function getSalesByLocation({
  start_date,
  end_date,
  currency = 'GBP'
}) {
  const query = `
    SELECT
      COALESCE(location, 'Unknown') AS location,
      COUNT(*) AS transaction_count,
      SUM(CASE WHEN transaction_type = 'sale' THEN gross ELSE 0 END) AS sales_gross,
      SUM(CASE WHEN transaction_type = 'refund' THEN gross ELSE 0 END) AS refunds_gross,
      SUM(gross) AS net_gross
    FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_transactions\`
    WHERE date >= @start_date
      AND date <= @end_date
      AND currency = @currency
    GROUP BY location
    ORDER BY net_gross DESC
  `;

  const [rows] = await bigquery.query({
    query,
    params: {
      start_date,
      end_date,
      currency
    }
  });

  return rows;
}

async function compareSalesPeriods({
  period_1_start,
  period_1_end,
  period_2_start,
  period_2_end,
  currency = 'GBP',
  location = null,
  channel = null,
  source = null
}) {
  const period1 = await getSalesSummary({
    start_date: period_1_start,
    end_date: period_1_end,
    currency,
    location,
    channel,
    source
  });

  const period2 = await getSalesSummary({
    start_date: period_2_start,
    end_date: period_2_end,
    currency,
    location,
    channel,
    source
  });

  const a = Number(period1.net_gross || 0);
  const b = Number(period2.net_gross || 0);

  return {
    period_1: period1,
    period_2: period2,
    difference: a - b,
    percentage_change:
      b !== 0 ? ((a - b) / Math.abs(b)) * 100 : null
  };
}
async function getSalesByChannel({
  start_date,
  end_date,
  currency = 'GBP',
  location = null,
  source = null
}) {
  const filters = [
    'date >= @start_date',
    'date <= @end_date',
    'currency = @currency'
  ];

  const params = {
    start_date,
    end_date,
    currency
  };

  if (location) {
    filters.push('LOWER(location) = LOWER(@location)');
    params.location = location;
  }

  if (source) {
    filters.push('LOWER(source) = LOWER(@source)');
    params.source = source;
  }

  const query = `
    SELECT
      COALESCE(channel, 'Unknown') AS channel,
      COUNT(*) AS transaction_count,

      SUM(
        CASE
          WHEN transaction_type = 'sale'
          THEN gross
          ELSE 0
        END
      ) AS sales_gross,

      SUM(
        CASE
          WHEN transaction_type = 'refund'
          THEN gross
          ELSE 0
        END
      ) AS refunds_gross,

      SUM(gross) AS net_gross,

      SUM(tax) AS net_tax,

      SUM(net_ex_tax) AS net_ex_tax

    FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_transactions\`

    WHERE ${filters.join('\nAND ')}

    GROUP BY channel
    ORDER BY net_gross DESC
  `;

  const [rows] = await bigquery.query({
    query,
    params
  });

  return rows;
}


async function getRefunds({
  start_date,
  end_date,
  currency = 'GBP',
  location = null,
  channel = null,
  source = null,
  group_by = 'summary'
}) {
  return oracleFinance.getRefunds({start_date,end_date,currency,location,channel,source,group_by});
}


async function getGiftCardIssuance({
  start_date,
  end_date,
  currency = 'GBP',
  location = null,
  channel = null,
  source = null,
  group_by = 'summary'
}) {
  const filters = [
    'date >= @start_date',
    'date <= @end_date',
    'currency = @currency'
  ];

  const params = {
    start_date,
    end_date,
    currency
  };

  if (location) {
    filters.push('LOWER(location) = LOWER(@location)');
    params.location = location;
  }

  if (channel) {
    filters.push('LOWER(channel) = LOWER(@channel)');
    params.channel = channel;
  }

  if (source) {
    filters.push('LOWER(source) = LOWER(@source)');
    params.source = source;
  }

  let groupExpression = null;
  let groupAlias = null;

  if (group_by === 'month') {
    groupExpression = "FORMAT_DATE('%Y-%m', date)";
    groupAlias = 'month';
  }

  if (group_by === 'location') {
    groupExpression = "COALESCE(location, 'Unknown')";
    groupAlias = 'location';
  }

  if (group_by === 'channel') {
    groupExpression = "COALESCE(channel, 'Unknown')";
    groupAlias = 'channel';
  }

  if (group_by === 'source') {
    groupExpression = "COALESCE(source, 'Unknown')";
    groupAlias = 'source';
  }

  const query = groupExpression
    ? `
      SELECT
        ${groupExpression} AS ${groupAlias},
        COUNT(*) AS gift_card_transactions,
        SUM(gift_card_issuance) AS gift_card_issuance,
        SUM(transaction_gross) AS transaction_gross

      FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_gift_cards\`

      WHERE ${filters.join('\nAND ')}

      GROUP BY ${groupAlias}
      ORDER BY gift_card_issuance DESC
    `
    : `
      SELECT
        COUNT(*) AS gift_card_transactions,
        SUM(gift_card_issuance) AS gift_card_issuance,
        SUM(transaction_gross) AS transaction_gross

      FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_gift_cards\`

      WHERE ${filters.join('\nAND ')}
    `;

  const [rows] = await bigquery.query({
    query,
    params
  });

  return groupExpression ? rows : (rows[0] || {});
}

/* =========================================================
   ROUTES
========================================================= */

app.get(
  '/export-accountant',
  requireSyncSecret,
  async (req, res) => {
    let tempFile = null;

    try {
      const filename =
        `TGF_Accountant_Finance_Export_${new Date()
          .toISOString()
          .slice(0, 10)}.xlsx`;

      tempFile = path.join(os.tmpdir(), filename);

      console.log('Starting accountant export:', tempFile);

      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: tempFile,
        useStyles: true,
        useSharedStrings: false
      });

      const notesSheet = workbook.addWorksheet('Notes & Methodology');

      notesSheet.columns = [
        {
          header: 'Item',
          key: 'item',
          width: 28
        },
        {
          header: 'Methodology / note',
          key: 'note',
          width: 90
        }
      ];

      styleHeaderRow(notesSheet.getRow(1));
      notesSheet.getRow(1).commit();

      const notes = [
        [
          'Purpose',
          'Unified historical transaction dataset for finance/accounting review, combining Shopify, Square and historical WooCommerce stores.'
        ],
        [
          'Source of truth',
          'BigQuery finance.sales_master and accountant-facing views.'
        ],
        [
          'Currencies',
          'GBP, USD and JPY are preserved in their original transaction currency. No FX conversion to GBP is included.'
        ],
        [
          'Sales / refunds',
          'Sales and refunds are separate transaction rows. Refund amounts are negative.'
        ],
        [
          'Shopify',
          'Successful SALE and CAPTURE transactions represent money received. Successful REFUND transactions represent money returned. AUTHORIZATION, FAILURE/ERROR and PENDING transactions are excluded.'
        ],
        [
          'Migrated Shopify orders',
          'Matrixify-migrated WooCommerce orders are excluded from Shopify finance data to prevent double counting.'
        ],
        [
          'Square VAT',
          'VAT is derived from VAT-inclusive taxable sales where Square source tax was unreliable. Identified gift-card issuance is excluded from taxable/ex-VAT Square sales.'
        ],
        [
          'Square gift cards',
          'Identified Square gift-card issuance is reported separately and explains the expected difference between Square gross and tax plus ex-tax sales.'
        ],
        [
          'Shopify gift cards',
          'Shopify gift-card product sales are shown separately. Shopify tax/net figures are not reduced again by this gift-card amount.'
        ],
        [
          'WooCommerce gift cards',
          'Historical WooCommerce voucher/gift-card issuance is not separately identified in the current accountant views, so Gift Cards is not complete historical issuance across all systems.'
        ],
        [
          'WooCommerce UK',
          'Historical UK/Worldwide WooCommerce sales preserve recorded source tax. Refund records were deduplicated before inclusion.'
        ],
        [
          'WooCommerce US / JP',
          'USD and JPY remain in source currency. Recorded tax is retained where available.'
        ],
        [
          'Migration pattern',
          'WooCommerce online sales transition to Shopify in November 2025 with trailing WooCommerce refunds afterward. POS migration from Square to Shopify is staggered through early 2026. Legitimate residual Square Wedding, Gold and legacy activity remains included.'
        ],
        [
          'Tax treatment',
          'This workbook is a reporting dataset rather than a legal VAT determination. Gift-card/voucher treatment and unusual historical transactions should be confirmed by the accountant.'
        ],
        [
          'Generated',
          new Date().toISOString()
        ]
      ];

      for (const [item, note] of notes) {
        const row = notesSheet.addRow({ item, note });
        row.getCell(1).font = { bold: true };
        row.commit();
      }

      notesSheet.commit();

      const sheets = [
        {
          name: 'All Transactions',
          view: 'accountant_transactions'
        },
        {
          name: 'Monthly Summary',
          view: 'accountant_monthly_summary'
        },
        {
          name: 'Annual Summary',
          view: 'accountant_annual_summary'
        },
        {
          name: 'Source & Location',
          view: 'accountant_location_summary'
        },
        {
          name: 'Gift Cards',
          view: 'accountant_gift_cards'
        }
      ];

      for (const config of sheets) {
        console.log(`Exporting ${config.name}`);

        await exportBigQueryViewToWorksheet(
          workbook,
          config.name,
          `${GOOGLE_PROJECT_ID}.finance.${config.view}`
        );
      }

      console.log('Committing workbook...');
      await workbook.commit();
      console.log('Workbook complete');

      res.download(tempFile, filename, error => {
        if (error) {
          console.error('Download error:', error);
        }

        fs.unlink(tempFile, () => {});
      });
    } catch (error) {
      console.error('Accountant export error:', error);

      if (tempFile && fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }

      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    }
  }
);

app.get(
  '/',
  (req, res) => {
    res.json({
      status: 'ok',
      service:
        'TGF BigQuery Sync',
      revision: DEPLOYED_GIT_REVISION
    });
  }
);

/* ---------------------------------------------------------
   METORIK DISCOVERY TESTS
--------------------------------------------------------- */

const METORIK_API_BASE_URL =
  'https://app.metorik.com/api/v1/store/';
const METORIK_DISCOVERY_START_DATE = '2025-01-01';
const METORIK_DISCOVERY_END_DATE = '2025-09-30';
const METORIK_DISCOVERY_PER_PAGE = '10';
const METORIK_PAGINATION_TEST_PER_PAGE = '3';
const METORIK_REQUEST_RETRY_COUNT = 2;
const METORIK_RETRY_BASE_DELAY_MS = 500;
const METORIK_MAX_RETRY_DELAY_MS = 30000;
const METORIK_DISCOVERY_RESOURCES = [
  'products',
  'orders',
  'customers'
];
const METORIK_DATE_FILTER_SEMANTICS = {
  startDateAndEndDate:
    'Analytical date range used for calculated values; it does not filter the resources returned.',
  resourceDateFilters: {
    orders: ['filter[created_at_min]', 'filter[created_at_max]'],
    customers: ['filter[created_at_min]', 'filter[created_at_max]']
  }
};

function sanitizeMetorikValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeMetorikValue);
  }

  if (
    value === null ||
    typeof value !== 'object'
  ) {
    if (typeof value === 'string') {
      const secretsRedacted = [
        METORIK_UK_API_KEY,
        METORIK_US_API_KEY,
        SYNC_SECRET
      ]
        .filter(Boolean)
        .reduce(
          (sanitized, secret) =>
            sanitized.split(secret).join('[REDACTED]'),
          value
        );
      return secretsRedacted
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]')
        .replace(/(?:\+?\d[\d ().-]{7,}\d)/g, '[REDACTED]');
    }

    return value;
  }

  const sanitized = {};

  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = key
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');

    if (
      normalizedKey.includes('email') ||
      normalizedKey.includes('phone') ||
      normalizedKey.includes('address') ||
      normalizedKey.includes('firstname') ||
      normalizedKey.includes('lastname') ||
      normalizedKey.includes('displayname') ||
      normalizedKey.includes('username') ||
      normalizedKey.includes('ipaddress') ||
      normalizedKey.includes('authorization') ||
      normalizedKey.includes('credential') ||
      normalizedKey.includes('apikey') ||
      normalizedKey.includes('secret') ||
      normalizedKey.includes('token') ||
      normalizedKey === 'company' ||
      normalizedKey === 'postcode' ||
      normalizedKey === 'zipcode' ||
      normalizedKey === 'city' ||
      normalizedKey === 'state'
    ) {
      sanitized[key] = '[REDACTED]';
      continue;
    }

    sanitized[key] = sanitizeMetorikValue(childValue);
  }

  return sanitized;
}

function getMetorikResponseRecords(data, resource) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.[resource])) {
    return data[resource];
  }

  return [];
}

function hasMetorikRecordCollection(data, resource) {
  return Array.isArray(data) ||
    Array.isArray(data?.data) ||
    Array.isArray(data?.[resource]);
}

function getMetorikErrorFields(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object') return null;

  const fields = ['error', 'errors', 'message', 'messages'];
  const summarize = value => {
    if (typeof value === 'string') {
      return sanitizeMetorikValue(value).slice(0, 500);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return value;
    }
    if (Array.isArray(value)) return value.slice(0, 10).map(summarize);
    if (typeof value !== 'object') return String(value).slice(0, 500);

    const safeNestedFields = ['code', 'type', 'title', 'status', 'error', 'message', 'detail'];
    return Object.fromEntries(
      safeNestedFields
        .filter(field => value[field] !== undefined)
        .map(field => [field, summarize(value[field])])
    );
  };
  const errors = Object.fromEntries(
    fields
      .filter(field => data[field] !== undefined)
      .map(field => [field, summarize(data[field])])
  );
  return Object.keys(errors).length > 0 ? errors : null;
}

function getMetorikPagination(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object') return null;

  const pagination = data.pagination || data.meta || data.links;
  if (!pagination || Array.isArray(pagination) || typeof pagination !== 'object') {
    return null;
  }

  const fields = [
    'current_page', 'per_page', 'has_more_pages', 'total', 'total_pages',
    'last_page', 'from', 'to', 'next_page', 'previous_page'
  ];
  const relevantPagination = Object.fromEntries(
    fields
      .filter(field => pagination[field] !== undefined)
      .map(field => [field, sanitizeMetorikValue(pagination[field])])
  );
  return Object.keys(relevantPagination).length > 0
    ? relevantPagination
    : null;
}

function metorikRetryDelay(response, retryNumber) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const retryAt = Date.parse(retryAfter);
    const delay = Number.isFinite(seconds)
      ? seconds * 1000
      : retryAt - Date.now();
    if (Number.isFinite(delay) && delay >= 0) {
      return Math.min(delay, METORIK_MAX_RETRY_DELAY_MS);
    }
  }
  if (response.status === 429) {
    return [5000, 15000][retryNumber - 1] ??
      METORIK_MAX_RETRY_DELAY_MS;
  }
  return Math.min(
    METORIK_RETRY_BASE_DELAY_MS * (2 ** (retryNumber - 1)),
    METORIK_MAX_RETRY_DELAY_MS
  );
}

function waitForMetorikRetry(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

async function requestMetorikResource(
  resource,
  { apiKey, storeName },
  queryParameters = {},
  { includeDiscoveryDateRange = true, retryCount = 0 } = {}
) {
  const resourceUrl = new URL(
    resource,
    METORIK_API_BASE_URL
  );
  if (includeDiscoveryDateRange) {
    resourceUrl.searchParams.set(
      'start_date',
      METORIK_DISCOVERY_START_DATE
    );
    resourceUrl.searchParams.set(
      'end_date',
      METORIK_DISCOVERY_END_DATE
    );
  }
  resourceUrl.searchParams.set(
    'per_page',
    METORIK_DISCOVERY_PER_PAGE
  );

  for (const [key, value] of Object.entries(queryParameters)) {
    resourceUrl.searchParams.set(key, value);
  }

  for (let attempt = 1; attempt <= retryCount + 1; attempt++) {
    try {
      const response = await fetch(resourceUrl, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`
        }
      });
      const responseText = await response.text();
      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        if ((response.status === 429 || response.status >= 500) &&
            attempt <= retryCount) {
          await waitForMetorikRetry(metorikRetryDelay(response, attempt));
          continue;
        }
        return {
          success: false,
          apiStatus: response.status,
          responseWasJson: false,
          failureCategory: response.ok ? 'non_json_response' : 'http_error',
          attempts: attempt,
          records: [],
          pagination: null,
          metorikErrors: null,
          topLevelKeys: [],
          error: 'Metorik returned a non-JSON response'
        };
      }

      const records = getMetorikResponseRecords(data, resource);
      const pagination = getMetorikPagination(data);
      const metorikErrors = getMetorikErrorFields(data);
      if ((response.status === 429 || response.status >= 500) && attempt <= retryCount) {
        await waitForMetorikRetry(metorikRetryDelay(response, attempt));
        continue;
      }
      return {
        success: response.ok,
        apiStatus: response.status,
        responseWasJson: true,
        failureCategory: response.ok ? null : 'http_error',
        attempts: attempt,
        records,
        recordsShapeValid: hasMetorikRecordCollection(data, resource),
        pagination,
        metorikErrors,
        topLevelKeys: data && !Array.isArray(data) ? Object.keys(data) : ['array'],
        ...(response.ok ? {} : { error: 'Metorik returned an unsuccessful response' })
      };
    } catch (error) {
      if (attempt <= retryCount) {
        await waitForMetorikRetry(Math.min(
          METORIK_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)),
          METORIK_MAX_RETRY_DELAY_MS
        ));
        continue;
      }
      console.error(`Metorik ${storeName} ${resource} request failed:`, error.name);

      return {
        success: false,
        apiStatus: null,
        responseWasJson: false,
        failureCategory: 'network_error',
        attempts: attempt,
        records: [],
        pagination: null,
        metorikErrors: null,
        topLevelKeys: [],
        error: 'Unable to reach the Metorik API'
      };
    }
  }
}

async function discoverMetorikResource(resource, store) {
  const result = await requestMetorikResource(
    resource,
    store
  );
  const { records, ...diagnostics } = result;

  return {
    ...diagnostics,
    recordsReturned: records.length,
    sample: sanitizeMetorikValue(records.slice(0, 3))
  };
}

function getMetorikRecordIdentity(record) {
  const identityFields = [
    'id',
    'order_id',
    'customer_id',
    'metorik_customer_id',
    'created_at',
    'date_created',
    'date',
    'updated_at'
  ];

  return Object.fromEntries(
    identityFields
      .filter(field => record?.[field] !== undefined)
      .map(field => [field, record[field]])
  );
}

async function discoverMetorikOrderPagination(store) {
  const pages = await Promise.all(
    [1, 2].map(async page => {
      const result = await requestMetorikResource(
        'orders',
        store,
        {
          page: String(page),
          per_page: METORIK_PAGINATION_TEST_PER_PAGE
        }
      );
      const { records, ...diagnostics } = result;

      return {
        page,
        ...diagnostics,
        records: sanitizeMetorikValue(
          records.map(getMetorikRecordIdentity)
        )
      };
    })
  );
  const pageIds = pages.map(page =>
    page.records.map(record => record.order_id ?? record.id)
  );

  return {
    perPageRequested: Number(METORIK_PAGINATION_TEST_PER_PAGE),
    pages,
    differentRecords:
      pageIds[0].length > 0 &&
      pageIds[1].length > 0 &&
      !pageIds[0].some(id => pageIds[1].includes(id)),
    paginationBehavesAsExpected:
      pages[0].pagination?.current_page === 1 &&
      pages[1].pagination?.current_page === 2 &&
      pages[0].pagination?.per_page ===
        Number(METORIK_PAGINATION_TEST_PER_PAGE) &&
      pages[1].pagination?.per_page ===
        Number(METORIK_PAGINATION_TEST_PER_PAGE) &&
      pages[0].pagination?.has_more_pages === true
  };
}

async function runMetorikDiscovery(store) {
  const discoveryResults = await Promise.all([
    ...METORIK_DISCOVERY_RESOURCES.map(async resource => [
      resource,
      await discoverMetorikResource(resource, store)
    ]),
    [
      'refunds',
      await discoverMetorikResource('refunds', store)
    ],
    [
      'orderPaginationTest',
      await discoverMetorikOrderPagination(store)
    ]
  ]);

  return {
    store: store.storeName,
    dateFilterSemantics: METORIK_DATE_FILTER_SEMANTICS,
    ...Object.fromEntries(discoveryResults)
  };
}

function addMetorikDiscoveryRoute({
  path,
  storeName,
  apiKey,
  apiKeyEnvironmentVariable
}) {
  app.get(
    path,
    requireSyncSecret,
    async (req, res) => {
      if (!apiKey) {
        return res.status(500).json({
          success: false,
          store: storeName,
          error:
            `${apiKeyEnvironmentVariable} is not configured`
        });
      }

      return res.json(await runMetorikDiscovery({
        storeName,
        apiKey
      }));
    }
  );
}

addMetorikDiscoveryRoute({
  path: '/test-metorik-uk',
  storeName: 'UK',
  apiKey: METORIK_UK_API_KEY,
  apiKeyEnvironmentVariable: 'METORIK_UK_API_KEY'
});

addMetorikDiscoveryRoute({
  path: '/test-metorik-us',
  storeName: 'US',
  apiKey: METORIK_US_API_KEY,
  apiKeyEnvironmentVariable: 'METORIK_US_API_KEY'
});

/* ---------------------------------------------------------
   METORIK UK - HISTORIC ORDERS
--------------------------------------------------------- */

const METORIK_UK_DATASET = 'metorik_uk';
const METORIK_US_DATASET = 'metorik_us';
const METORIK_ORDERS_TABLE = 'orders';
const METORIK_ORDER_LINE_ITEMS_TABLE = 'order_line_items';
const METORIK_CUSTOMERS_TABLE = 'customers';
const METORIK_PRODUCTS_TABLE = 'products';
const METORIK_PRODUCT_VARIATIONS_TABLE = 'product_variations';
const METORIK_ORDERS_PER_PAGE = 100;
const METORIK_CUSTOMERS_PER_PAGE = 100;
const METORIK_CATALOGUE_PER_PAGE = 100;
const METORIK_MAX_ORDER_PAGES = 100000;
const METORIK_MAX_CUSTOMER_PAGES = 100000;
const METORIK_MAX_CATALOGUE_PAGES = 100000;
const METORIK_DEFAULT_PAGE_DELAY_MS = 1250;
const METORIK_MAX_PAGE_DELAY_MS = 60000;

const METORIK_STORES = Object.freeze({
  UK: Object.freeze({
    storeName: 'UK',
    apiKey: METORIK_UK_API_KEY,
    apiKeyEnvironmentVariable: 'METORIK_UK_API_KEY',
    dataset: METORIK_UK_DATASET,
    expectedOrderCurrencies: Object.freeze(['GBP'])
  }),
  US: Object.freeze({
    storeName: 'US',
    apiKey: METORIK_US_API_KEY,
    apiKeyEnvironmentVariable: 'METORIK_US_API_KEY',
    dataset: METORIK_US_DATASET,
    expectedOrderCurrencies: Object.freeze(['USD'])
  })
});

function getMetorikPageDelayMs(value) {
  if (value === undefined || value === '') {
    return METORIK_DEFAULT_PAGE_DELAY_MS;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('METORIK_PAGE_DELAY_MS must be a non-negative integer');
  }

  const delayMs = Number(value);
  if (!Number.isSafeInteger(delayMs) || delayMs > METORIK_MAX_PAGE_DELAY_MS) {
    throw new Error(
      `METORIK_PAGE_DELAY_MS must be between 0 and ${METORIK_MAX_PAGE_DELAY_MS}`
    );
  }
  return delayMs;
}

const METORIK_PAGE_DELAY_MS = getMetorikPageDelayMs(
  process.env.METORIK_PAGE_DELAY_MS
);

const METORIK_ORDERS_SCHEMA = [
  { name: 'order_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'customer_id', type: 'INT64' },
  { name: 'order_number', type: 'STRING' },
  { name: 'order_name', type: 'STRING' },
  { name: 'status', type: 'STRING' },
  { name: 'order_created_at', type: 'TIMESTAMP' },
  { name: 'order_updated_at', type: 'TIMESTAMP' },
  { name: 'order_paid_at', type: 'TIMESTAMP' },
  { name: 'order_completed_at', type: 'TIMESTAMP' },
  { name: 'currency', type: 'STRING' },
  { name: 'payment_method', type: 'STRING' },
  { name: 'payment_method_title', type: 'STRING' },
  { name: 'shipping_method_title', type: 'STRING' },
  { name: 'customer_note', type: 'STRING' },
  { name: 'created_via', type: 'STRING' },
  { name: 'referer', type: 'STRING' },
  { name: 'landing_path', type: 'STRING' },
  { name: 'utm_campaign', type: 'STRING' },
  { name: 'utm_medium', type: 'STRING' },
  { name: 'utm_source', type: 'STRING' },
  { name: 'utm_term', type: 'STRING' },
  { name: 'utm_content', type: 'STRING' },
  { name: 'utm_id', type: 'STRING' },
  { name: 'total', type: 'NUMERIC' },
  { name: 'total_discount', type: 'NUMERIC' },
  { name: 'total_items', type: 'INT64' },
  { name: 'total_refunds', type: 'NUMERIC' },
  { name: 'net', type: 'NUMERIC' },
  { name: 'net_original', type: 'NUMERIC' },
  { name: 'resource_link', type: 'STRING' },
  { name: 'billing_country', type: 'STRING' },
  { name: 'billing_state', type: 'STRING' },
  { name: 'shipping_country', type: 'STRING' },
  { name: 'shipping_state', type: 'STRING' },
  { name: 'discount_codes_json', type: 'STRING' },
  { name: 'coupon_lines_json', type: 'STRING' },
  { name: 'shipping_lines_json', type: 'STRING' },
  { name: 'fee_lines_json', type: 'STRING' },
  { name: 'tax_lines_json', type: 'STRING' },
  { name: 'synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
];

const METORIK_ORDER_LINE_ITEMS_SCHEMA = [
  { name: 'order_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'line_item_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'customer_id', type: 'INT64' },
  { name: 'order_created_at', type: 'TIMESTAMP' },
  { name: 'currency', type: 'STRING' },
  { name: 'name', type: 'STRING' },
  { name: 'sku', type: 'STRING' },
  { name: 'product_id', type: 'INT64' },
  { name: 'variation_id', type: 'INT64' },
  { name: 'quantity', type: 'INT64' },
  { name: 'tax_class', type: 'STRING' },
  { name: 'price', type: 'NUMERIC' },
  { name: 'subtotal', type: 'NUMERIC' },
  { name: 'subtotal_tax', type: 'NUMERIC' },
  { name: 'total', type: 'NUMERIC' },
  { name: 'total_tax', type: 'NUMERIC' },
  { name: 'price_original', type: 'NUMERIC' },
  { name: 'subtotal_original', type: 'NUMERIC' },
  { name: 'subtotal_tax_original', type: 'NUMERIC' },
  { name: 'total_original', type: 'NUMERIC' },
  { name: 'total_tax_original', type: 'NUMERIC' },
  { name: 'cogs', type: 'NUMERIC' },
  { name: 'ring_size', type: 'STRING' },
  { name: 'metadata_json', type: 'STRING', mode: 'REQUIRED' },
  { name: 'synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
];

// Current catalogue state only. Metorik can return product tags as an empty
// string, an array, or an object, so the complete value is retained as JSON.
// Metorik's date-window-dependent product analytics are deliberately excluded
// because BigQuery remains financial truth.
const METORIK_PRODUCTS_SCHEMA = [
  { name: 'product_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'title', type: 'STRING' },
  { name: 'sku', type: 'STRING' },
  { name: 'type', type: 'STRING' },
  { name: 'status', type: 'STRING' },
  { name: 'tags_json', type: 'STRING', mode: 'REQUIRED' },
  { name: 'image', type: 'STRING' },
  { name: 'current_price', type: 'NUMERIC' },
  { name: 'regular_price', type: 'NUMERIC' },
  { name: 'sale_price', type: 'NUMERIC' },
  { name: 'stock_quantity', type: 'INT64' },
  { name: 'in_stock', type: 'BOOL' },
  { name: 'product_created_at', type: 'TIMESTAMP' },
  { name: 'product_updated_at', type: 'TIMESTAMP' },
  { name: 'synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
];

const METORIK_PRODUCT_VARIATIONS_SCHEMA = [
  { name: 'variation_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'product_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'sku', type: 'STRING' },
  { name: 'name', type: 'STRING' },
  { name: 'image', type: 'STRING' },
  { name: 'attributes_json', type: 'STRING', mode: 'REQUIRED' },
  { name: 'current_price', type: 'NUMERIC' },
  { name: 'regular_price', type: 'NUMERIC' },
  { name: 'sale_price', type: 'NUMERIC' },
  { name: 'stock_quantity', type: 'INT64' },
  { name: 'in_stock', type: 'BOOL' },
  { name: 'variation_created_at', type: 'TIMESTAMP' },
  { name: 'variation_updated_at', type: 'TIMESTAMP' },
  { name: 'synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
];

// This is deliberately an analytics-only schema. In particular, it excludes
// names, email addresses, telephone numbers, street addresses, postcodes,
// companies, and notes even when those values are present in the API response.
const METORIK_CUSTOMERS_SCHEMA = [
  { name: 'metorik_customer_id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'customer_id', type: 'INT64' },
  { name: 'created_at', type: 'TIMESTAMP' },
  { name: 'first_order_date', type: 'TIMESTAMP' },
  { name: 'last_order_date', type: 'TIMESTAMP' },
  { name: 'order_count', type: 'INT64', mode: 'REQUIRED' },
  { name: 'total_spend', type: 'NUMERIC' },
  { name: 'net_spend', type: 'NUMERIC' },
  { name: 'average_order_value', type: 'NUMERIC' },
  { name: 'status', type: 'STRING' },
  { name: 'type', type: 'STRING' },
  { name: 'country', type: 'STRING' },
  { name: 'state', type: 'STRING' },
  { name: 'currency', type: 'STRING' },
  { name: 'resource_link', type: 'STRING' },
  { name: 'synced_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
];

class MetorikSyncValidationError extends Error {
  constructor(message, diagnostics = null) {
    super(message);
    this.name = 'MetorikSyncValidationError';
    this.diagnostics = diagnostics;
  }
}

function metorikPageDiagnostics(requestedPage, result, failureCategory) {
  return {
    requested_page: requestedPage,
    failure_category: failureCategory ?? result.failureCategory,
    http_status: result.apiStatus,
    response_was_json: result.responseWasJson,
    metorik_errors: result.metorikErrors,
    pagination: result.pagination,
    attempts: result.attempts
  };
}

function firstMetorikValue(source, fields) {
  for (const field of fields) {
    if (source?.[field] !== undefined && source[field] !== null) {
      return source[field];
    }
  }
  return null;
}

function firstMetorikNestedValue(source, paths) {
  for (const pathParts of paths) {
    let value = source;
    for (const pathPart of pathParts) value = value?.[pathPart];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function metorikString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  throw new MetorikSyncValidationError(`${field} is not a scalar value`);
}

function metorikInteger(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) {
      throw new MetorikSyncValidationError(`${field} is missing`);
    }
    return null;
  }

  const stringValue = String(value);
  if (!/^-?\d+$/.test(stringValue)) {
    throw new MetorikSyncValidationError(`${field} is not a valid integer`);
  }

  const integer = Number(stringValue);
  if (!Number.isSafeInteger(integer)) {
    throw new MetorikSyncValidationError(`${field} is outside the safe integer range`);
  }
  return integer;
}

function metorikNumeric(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const stringValue = String(value).trim();
  if (!/^-?(?:\d+)(?:\.\d+)?$/.test(stringValue)) {
    throw new MetorikSyncValidationError(`${field} is not a valid decimal`);
  }
  return stringValue;
}

function metorikTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MetorikSyncValidationError(`${field} is not a valid timestamp`);
  }
  return date.toISOString();
}

function metorikBoolean(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  throw new MetorikSyncValidationError(`${field} is not a boolean`);
}

function metorikJson(value, field) {
  try {
    return JSON.stringify(value ?? []);
  } catch {
    throw new MetorikSyncValidationError(`${field} is not valid JSON data`);
  }
}

function metorikProductTagsJson(value) {
  // Metorik uses both an empty string and an empty collection for "no tags".
  // Canonicalise only those semantically empty cases; populated arrays and
  // objects are serialized without flattening or scalar coercion.
  return metorikJson(
    value === undefined || value === null || value === '' ? [] : value,
    'product tags'
  );
}

function getMetorikLineItemMetadata(item) {
  return firstMetorikValue(item, ['meta_data', 'metadata', 'meta']) ?? [];
}

function extractMetorikRingSize(metadata) {
  if (!Array.isArray(metadata)) return null;

  for (const entry of metadata) {
    const labels = [entry?.key, entry?.display_key, entry?.name]
      .filter(value => value !== undefined && value !== null)
      .map(value => String(value).toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (labels.includes('paringsize') || labels.includes('ringsize')) {
      return metorikString(
        firstMetorikValue(entry, ['display_value', 'value']),
        'line item ring size'
      );
    }
  }
  return null;
}

function transformMetorikOrder(order, syncedAt) {
  const orderId = metorikInteger(
    firstMetorikValue(order, ['order_id', 'id']),
    'order_id',
    { required: true }
  );
  const timestamp = fields => metorikTimestamp(
    firstMetorikValue(order, fields),
    fields[0]
  );
  const numeric = field => metorikNumeric(order?.[field], field);

  return {
    order_id: orderId,
    customer_id: metorikInteger(order?.customer_id, 'customer_id'),
    order_number: metorikString(order?.order_number, 'order_number'),
    order_name: metorikString(order?.order_name, 'order_name'),
    status: metorikString(order?.status, 'status'),
    order_created_at: timestamp(['order_created_at', 'created_at', 'date_created']),
    order_updated_at: timestamp(['order_updated_at', 'updated_at', 'date_modified']),
    order_paid_at: timestamp(['order_paid_at', 'paid_at', 'date_paid']),
    order_completed_at: timestamp(['order_completed_at', 'completed_at', 'date_completed']),
    currency: metorikString(order?.currency, 'currency'),
    payment_method: metorikString(order?.payment_method, 'payment_method'),
    payment_method_title: metorikString(order?.payment_method_title, 'payment_method_title'),
    shipping_method_title: metorikString(order?.shipping_method_title, 'shipping_method_title'),
    customer_note: metorikString(order?.customer_note, 'customer_note'),
    created_via: metorikString(order?.created_via, 'created_via'),
    referer: metorikString(order?.referer, 'referer'),
    landing_path: metorikString(order?.landing_path, 'landing_path'),
    utm_campaign: metorikString(order?.utm_campaign, 'utm_campaign'),
    utm_medium: metorikString(order?.utm_medium, 'utm_medium'),
    utm_source: metorikString(order?.utm_source, 'utm_source'),
    utm_term: metorikString(order?.utm_term, 'utm_term'),
    utm_content: metorikString(order?.utm_content, 'utm_content'),
    utm_id: metorikString(order?.utm_id, 'utm_id'),
    total: numeric('total'),
    total_discount: numeric('total_discount'),
    total_items: metorikInteger(order?.total_items, 'total_items'),
    total_refunds: numeric('total_refunds'),
    net: numeric('net'),
    net_original: numeric('net_original'),
    resource_link: metorikString(order?.resource_link, 'resource_link'),
    billing_country: metorikString(firstMetorikNestedValue(order, [['billing_country'], ['billing', 'country']]), 'billing_country'),
    billing_state: metorikString(firstMetorikNestedValue(order, [['billing_state'], ['billing', 'state']]), 'billing_state'),
    shipping_country: metorikString(firstMetorikNestedValue(order, [['shipping_country'], ['shipping', 'country']]), 'shipping_country'),
    shipping_state: metorikString(firstMetorikNestedValue(order, [['shipping_state'], ['shipping', 'state']]), 'shipping_state'),
    discount_codes_json: metorikJson(order?.discount_codes, 'discount_codes'),
    coupon_lines_json: metorikJson(order?.coupon_lines, 'coupon_lines'),
    shipping_lines_json: metorikJson(order?.shipping_lines, 'shipping_lines'),
    fee_lines_json: metorikJson(order?.fee_lines, 'fee_lines'),
    tax_lines_json: metorikJson(order?.tax_lines, 'tax_lines'),
    synced_at: syncedAt
  };
}

function transformMetorikLineItems(order, orderRow, syncedAt) {
  const lineItems = firstMetorikValue(order, ['line_items', 'items']) ?? [];
  if (!Array.isArray(lineItems)) {
    throw new MetorikSyncValidationError('An order has a non-array line_items value');
  }

  return lineItems.map(item => {
    const metadata = getMetorikLineItemMetadata(item);
    const numeric = field => metorikNumeric(item?.[field], `line item ${field}`);
    return {
      order_id: orderRow.order_id,
      line_item_id: metorikInteger(
        firstMetorikValue(item, ['line_item_id', 'id']),
        'line_item_id',
        { required: true }
      ),
      customer_id: orderRow.customer_id,
      order_created_at: orderRow.order_created_at,
      currency: orderRow.currency,
      name: metorikString(item?.name, 'line item name'),
      sku: metorikString(item?.sku, 'line item sku'),
      product_id: metorikInteger(item?.product_id, 'product_id'),
      variation_id: metorikInteger(item?.variation_id, 'variation_id'),
      quantity: metorikInteger(item?.quantity, 'quantity'),
      tax_class: metorikString(item?.tax_class, 'tax_class'),
      price: numeric('price'),
      subtotal: numeric('subtotal'),
      subtotal_tax: numeric('subtotal_tax'),
      total: numeric('total'),
      total_tax: numeric('total_tax'),
      price_original: numeric('price_original'),
      subtotal_original: numeric('subtotal_original'),
      subtotal_tax_original: numeric('subtotal_tax_original'),
      total_original: numeric('total_original'),
      total_tax_original: numeric('total_tax_original'),
      cogs: numeric('cogs'),
      ring_size: extractMetorikRingSize(metadata),
      metadata_json: metorikJson(metadata, 'line item metadata'),
      synced_at: syncedAt
    };
  });
}

function transformMetorikProduct(product, syncedAt) {
  return {
    product_id: metorikInteger(product?.product_id, 'product_id', {
      required: true
    }),
    title: metorikString(product?.title, 'product title'),
    sku: metorikString(product?.sku, 'product sku'),
    type: metorikString(product?.type, 'product type'),
    status: metorikString(product?.status, 'product status'),
    tags_json: metorikProductTagsJson(product?.tags),
    image: metorikString(product?.image, 'product image'),
    current_price: metorikNumeric(product?.current_price, 'product current_price'),
    regular_price: metorikNumeric(product?.regular_price, 'product regular_price'),
    sale_price: metorikNumeric(product?.sale_price, 'product sale_price'),
    stock_quantity: metorikInteger(product?.stock_quantity, 'product stock_quantity'),
    in_stock: metorikBoolean(product?.in_stock, 'product in_stock'),
    product_created_at: metorikTimestamp(
      product?.product_created_at,
      'product_created_at'
    ),
    product_updated_at: metorikTimestamp(
      product?.product_updated_at,
      'product_updated_at'
    ),
    synced_at: syncedAt
  };
}

function transformMetorikProductVariation(variation, syncedAt) {
  return {
    variation_id: metorikInteger(variation?.variation_id, 'variation_id', {
      required: true
    }),
    product_id: metorikInteger(variation?.product_id, 'variation product_id', {
      required: true
    }),
    sku: metorikString(variation?.sku, 'variation sku'),
    name: metorikString(variation?.name, 'variation name'),
    image: metorikString(variation?.image, 'variation image'),
    attributes_json: metorikJson(variation?.atts, 'variation atts'),
    current_price: metorikNumeric(
      variation?.current_price,
      'variation current_price'
    ),
    regular_price: metorikNumeric(
      variation?.regular_price,
      'variation regular_price'
    ),
    sale_price: metorikNumeric(variation?.sale_price, 'variation sale_price'),
    stock_quantity: metorikInteger(
      variation?.stock_quantity,
      'variation stock_quantity'
    ),
    in_stock: metorikBoolean(variation?.in_stock, 'variation in_stock'),
    variation_created_at: metorikTimestamp(
      variation?.variation_created_at,
      'variation_created_at'
    ),
    variation_updated_at: metorikTimestamp(
      variation?.variation_updated_at,
      'variation_updated_at'
    ),
    synced_at: syncedAt
  };
}

function duplicateMetorikIds(rows, field) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    if (seen.has(row[field])) duplicates.add(row[field]);
    seen.add(row[field]);
  }
  return [...duplicates];
}

function duplicateMetorikLineItemIdentities(rows) {
  const seen = new Set();
  const duplicates = new Set();
  for (const row of rows) {
    const identity = `${row.order_id}:${row.line_item_id}`;
    if (seen.has(identity)) duplicates.add(identity);
    seen.add(identity);
  }
  return [...duplicates];
}

function transformMetorikCustomer(customer, syncedAt) {
  if (!customer || Array.isArray(customer) || typeof customer !== 'object') {
    throw new MetorikSyncValidationError('A Metorik customer record is not an object');
  }

  const metorikCustomerId = metorikInteger(
    customer.metorik_customer_id,
    'metorik_customer_id',
    { required: true }
  );
  const wooCustomerId = metorikInteger(customer.customer_id, 'customer_id');
  const orderCount = metorikInteger(customer.order_count, 'order_count', {
    required: true
  });
  if (metorikCustomerId <= 0) {
    throw new MetorikSyncValidationError('metorik_customer_id must be positive');
  }
  if (wooCustomerId !== null && wooCustomerId < 0) {
    throw new MetorikSyncValidationError('customer_id must not be negative');
  }
  if (orderCount < 0) {
    throw new MetorikSyncValidationError('order_count must not be negative');
  }

  return {
    metorik_customer_id: metorikCustomerId,
    customer_id: wooCustomerId,
    created_at: metorikTimestamp(customer.created_at, 'created_at'),
    first_order_date: metorikTimestamp(customer.first_order_date, 'first_order_date'),
    last_order_date: metorikTimestamp(customer.last_order_date, 'last_order_date'),
    order_count: orderCount,
    total_spend: metorikNumeric(customer.total_spend, 'total_spend'),
    net_spend: metorikNumeric(customer.net_spend, 'net_spend'),
    average_order_value: metorikNumeric(
      customer.average_order_value,
      'average_order_value'
    ),
    status: metorikString(customer.status, 'status'),
    type: metorikString(customer.type, 'type'),
    country: metorikString(customer.country, 'country'),
    state: metorikString(customer.state, 'state'),
    currency: metorikString(customer.currency, 'currency'),
    resource_link: metorikString(customer.resource_link, 'resource_link'),
    synced_at: syncedAt
  };
}

async function fetchAllMetorikCustomers(store) {
  const customers = [];
  const pageSignatures = new Set();

  for (
    let requestedPage = 1;
    requestedPage <= METORIK_MAX_CUSTOMER_PAGES;
    requestedPage++
  ) {
    const result = await requestMetorikResource(
      'customers',
      store,
      { page: String(requestedPage), per_page: String(METORIK_CUSTOMERS_PER_PAGE) },
      {
        includeDiscoveryDateRange: false,
        retryCount: METORIK_REQUEST_RETRY_COUNT
      }
    );
    if (!result.success) {
      throw new MetorikSyncValidationError(
        `Metorik customers request failed on page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result)
      );
    }
    if (!result.recordsShapeValid) {
      throw new MetorikSyncValidationError(
        `Metorik customers response has no record collection on page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'malformed_response')
      );
    }

    const pagination = result.pagination;
    let currentPage;
    let perPage;
    try {
      currentPage = metorikInteger(
        pagination?.current_page,
        'pagination.current_page',
        { required: true }
      );
      perPage = metorikInteger(
        pagination?.per_page,
        'pagination.per_page',
        { required: true }
      );
    } catch (error) {
      if (!(error instanceof MetorikSyncValidationError)) throw error;
      throw new MetorikSyncValidationError(
        error.message,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }
    if (currentPage !== requestedPage || perPage <= 0) {
      throw new MetorikSyncValidationError(
        `Metorik pagination did not advance to page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }
    if (typeof pagination?.has_more_pages !== 'boolean') {
      throw new MetorikSyncValidationError(
        'pagination.has_more_pages is missing or invalid',
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }
    if (result.records.some(record =>
      !record || Array.isArray(record) || typeof record !== 'object'
    )) {
      throw new MetorikSyncValidationError(
        `Metorik customers page ${requestedPage} contains a non-object record`,
        metorikPageDiagnostics(requestedPage, result, 'malformed_response')
      );
    }

    const signature = JSON.stringify(
      result.records.map(record => record.metorik_customer_id)
    );
    if (pageSignatures.has(signature)) {
      throw new MetorikSyncValidationError(
        `Metorik repeated page content at page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }
    pageSignatures.add(signature);
    customers.push(...result.records);

    if (!pagination.has_more_pages) {
      return {
        customers,
        pagesFetched: requestedPage,
        paginationCompleted: true,
        pageDelayMs: METORIK_PAGE_DELAY_MS
      };
    }
    if (result.records.length === 0) {
      throw new MetorikSyncValidationError(
        `Metorik returned an empty non-final page at page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }

    await sleep(METORIK_PAGE_DELAY_MS);
  }

  throw new MetorikSyncValidationError(
    'Metorik customer pagination exceeded the safety page limit'
  );
}

async function fetchAllMetorikOrders(store) {
  const orders = [];
  const pageSignatures = new Set();

  for (let requestedPage = 1; requestedPage <= METORIK_MAX_ORDER_PAGES; requestedPage++) {
    const result = await requestMetorikResource(
      'orders',
      store,
      { page: String(requestedPage), per_page: String(METORIK_ORDERS_PER_PAGE) },
      {
        includeDiscoveryDateRange: false,
        retryCount: METORIK_REQUEST_RETRY_COUNT
      }
    );
    if (!result.success) {
      throw new MetorikSyncValidationError(
        `Metorik orders request failed on page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result)
      );
    }
    if (!result.recordsShapeValid) {
      throw new MetorikSyncValidationError(
        `Metorik orders response has no record collection on page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'malformed_response')
      );
    }

    const pagination = result.pagination;
    let currentPage;
    let perPage;
    try {
      currentPage = metorikInteger(
        pagination?.current_page,
        'pagination.current_page',
        { required: true }
      );
      perPage = metorikInteger(
        pagination?.per_page,
        'pagination.per_page',
        { required: true }
      );
    } catch (error) {
      if (!(error instanceof MetorikSyncValidationError)) throw error;
      throw new MetorikSyncValidationError(
        error.message,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }
    if (currentPage !== requestedPage || perPage <= 0) {
      throw new MetorikSyncValidationError(
        `Metorik pagination did not advance to page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }
    if (typeof pagination?.has_more_pages !== 'boolean') {
      throw new MetorikSyncValidationError(
        'pagination.has_more_pages is missing or invalid',
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }

    const signature = JSON.stringify(result.records.map(record =>
      firstMetorikValue(record, ['order_id', 'id'])
    ));
    if (pageSignatures.has(signature)) {
      throw new MetorikSyncValidationError(
        `Metorik repeated page content at page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }
    pageSignatures.add(signature);
    orders.push(...result.records);

    if (!pagination.has_more_pages) {
      return {
        orders,
        pagesFetched: requestedPage,
        paginationCompleted: true,
        pageDelayMs: METORIK_PAGE_DELAY_MS
      };
    }
    if (result.records.length === 0) {
      throw new MetorikSyncValidationError(
        `Metorik returned an empty non-final page at page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'pagination_validation_failure')
      );
    }

    await sleep(METORIK_PAGE_DELAY_MS);
  }

  throw new MetorikSyncValidationError('Metorik pagination exceeded the safety page limit');
}

async function fetchAllMetorikCatalogueResource(store, resource, identityField) {
  const records = [];
  const pageSignatures = new Set();

  for (
    let requestedPage = 1;
    requestedPage <= METORIK_MAX_CATALOGUE_PAGES;
    requestedPage++
  ) {
    // These dates are required by Metorik solely as the calculation window for
    // analytics that this sync discards. They do not filter catalogue membership.
    const result = await requestMetorikResource(
      resource,
      store,
      {
        page: String(requestedPage),
        per_page: String(METORIK_CATALOGUE_PER_PAGE),
        start_date: METORIK_DISCOVERY_START_DATE,
        end_date: METORIK_DISCOVERY_END_DATE
      },
      {
        includeDiscoveryDateRange: false,
        retryCount: METORIK_REQUEST_RETRY_COUNT
      }
    );
    if (!result.success) {
      throw new MetorikSyncValidationError(
        `Metorik ${resource} request failed on page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result)
      );
    }
    if (!result.recordsShapeValid) {
      throw new MetorikSyncValidationError(
        `Metorik ${resource} response has no record collection on page ${requestedPage}`,
        metorikPageDiagnostics(requestedPage, result, 'malformed_response')
      );
    }

    const pagination = result.pagination;
    let currentPage;
    let perPage;
    try {
      currentPage = metorikInteger(
        pagination?.current_page,
        'pagination.current_page',
        { required: true }
      );
      perPage = metorikInteger(
        pagination?.per_page,
        'pagination.per_page',
        { required: true }
      );
    } catch (error) {
      if (!(error instanceof MetorikSyncValidationError)) throw error;
      throw new MetorikSyncValidationError(
        error.message,
        metorikPageDiagnostics(
          requestedPage,
          result,
          'pagination_validation_failure'
        )
      );
    }
    if (
      currentPage !== requestedPage ||
      perPage !== METORIK_CATALOGUE_PER_PAGE
    ) {
      throw new MetorikSyncValidationError(
        `Metorik ${resource} pagination did not match page ${requestedPage}`,
        metorikPageDiagnostics(
          requestedPage,
          result,
          'pagination_validation_failure'
        )
      );
    }
    if (typeof pagination?.has_more_pages !== 'boolean') {
      throw new MetorikSyncValidationError(
        'pagination.has_more_pages is missing or invalid',
        metorikPageDiagnostics(
          requestedPage,
          result,
          'pagination_validation_failure'
        )
      );
    }
    if (result.records.some(record =>
      !record || Array.isArray(record) || typeof record !== 'object'
    )) {
      throw new MetorikSyncValidationError(
        `Metorik ${resource} page ${requestedPage} contains a non-object record`,
        metorikPageDiagnostics(requestedPage, result, 'malformed_response')
      );
    }

    const signature = JSON.stringify(
      result.records.map(record => record[identityField])
    );
    if (pageSignatures.has(signature)) {
      throw new MetorikSyncValidationError(
        `Metorik repeated ${resource} page content at page ${requestedPage}`,
        metorikPageDiagnostics(
          requestedPage,
          result,
          'pagination_validation_failure'
        )
      );
    }
    pageSignatures.add(signature);
    records.push(...result.records);

    if (!pagination.has_more_pages) {
      return {
        records,
        pagesFetched: requestedPage,
        paginationCompleted: true,
        pageDelayMs: METORIK_PAGE_DELAY_MS
      };
    }
    if (result.records.length === 0) {
      throw new MetorikSyncValidationError(
        `Metorik returned an empty non-final ${resource} page at page ${requestedPage}`,
        metorikPageDiagnostics(
          requestedPage,
          result,
          'pagination_validation_failure'
        )
      );
    }
    await sleep(METORIK_PAGE_DELAY_MS);
  }

  throw new MetorikSyncValidationError(
    `Metorik ${resource} pagination exceeded the safety page limit`
  );
}

async function ensureMetorikDatasetAndTables(store) {
  const dataset = bigquery.dataset(store.dataset);
  const [datasetExists] = await dataset.exists();
  if (!datasetExists) {
    await bigquery.createDataset(store.dataset);
  }

  for (const [tableName, schema] of [
    [METORIK_ORDERS_TABLE, METORIK_ORDERS_SCHEMA],
    [METORIK_ORDER_LINE_ITEMS_TABLE, METORIK_ORDER_LINE_ITEMS_SCHEMA]
  ]) {
    const table = dataset.table(tableName);
    const [exists] = await table.exists();
    if (!exists) await dataset.createTable(tableName, { schema });
  }
  return dataset;
}

async function insertMetorikRows(table, rows) {
  const batchSize = 500;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await table.insert(rows.slice(offset, offset + batchSize));
  }
}

async function safelyReplaceMetorikTables(store, orderRows, lineItemRows) {
  const dataset = await ensureMetorikDatasetAndTables(store);
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const stagingOrdersName = `_staging_orders_${suffix}`;
  const stagingLinesName = `_staging_order_line_items_${suffix}`;
  const [stagingOrders] = await dataset.createTable(stagingOrdersName, {
    schema: METORIK_ORDERS_SCHEMA,
    expirationTime: Date.now() + 24 * 60 * 60 * 1000
  });
  let stagingLines;

  try {
    [stagingLines] = await dataset.createTable(stagingLinesName, {
      schema: METORIK_ORDER_LINE_ITEMS_SCHEMA,
      expirationTime: Date.now() + 24 * 60 * 60 * 1000
    });
    await insertMetorikRows(stagingOrders, orderRows);
    await insertMetorikRows(stagingLines, lineItemRows);

    const [counts] = await bigquery.query({ query: `
      SELECT
        (SELECT COUNT(*) FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingOrdersName}\`) AS orders_count,
        (SELECT COUNT(*) FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingLinesName}\`) AS lines_count
    ` });
    if (Number(counts[0]?.orders_count) !== orderRows.length ||
        Number(counts[0]?.lines_count) !== lineItemRows.length) {
      throw new MetorikSyncValidationError('BigQuery staging row counts did not match the validated source data');
    }

    await bigquery.query({ query: `
      BEGIN TRANSACTION;
      DELETE FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDERS_TABLE}\` WHERE TRUE;
      INSERT INTO \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDERS_TABLE}\`
        SELECT * FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingOrdersName}\`;
      DELETE FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDER_LINE_ITEMS_TABLE}\` WHERE TRUE;
      INSERT INTO \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDER_LINE_ITEMS_TABLE}\`
        SELECT * FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingLinesName}\`;
      COMMIT TRANSACTION;
    ` });

    return {
      staging_orders_count: orderRows.length,
      staging_line_items_count: lineItemRows.length,
      coordinated_transactional_replacement: true
    };
  } finally {
    await Promise.allSettled([
      stagingOrders.delete({ ignoreNotFound: true }),
      stagingLines?.delete({ ignoreNotFound: true })
    ]);
  }
}

async function syncMetorikOrders(store) {
  const fetched = await fetchAllMetorikOrders(store);
  if (!fetched.paginationCompleted || fetched.orders.length === 0) {
    throw new MetorikSyncValidationError('Metorik did not return a complete, non-empty order history');
  }

  const syncedAt = new Date().toISOString();
  const orderRows = [];
  const lineItemRows = [];
  for (const order of fetched.orders) {
    const orderRow = transformMetorikOrder(order, syncedAt);
    orderRows.push(orderRow);
    lineItemRows.push(...transformMetorikLineItems(order, orderRow, syncedAt));
  }

  const duplicateOrderIds = duplicateMetorikIds(orderRows, 'order_id');
  const duplicateLineItemIdentities =
    duplicateMetorikLineItemIdentities(lineItemRows);
  if (duplicateOrderIds.length > 0) {
    throw new MetorikSyncValidationError(`Duplicate order IDs detected (${duplicateOrderIds.length})`);
  }
  if (duplicateLineItemIdentities.length > 0) {
    throw new MetorikSyncValidationError(
      `Duplicate line-item identity pairs detected (${duplicateLineItemIdentities.length})`
    );
  }
  const orderIds = new Set(orderRows.map(row => row.order_id));
  const orphanLineItems = lineItemRows.filter(
    row => !orderIds.has(row.order_id)
  ).length;
  if (orphanLineItems > 0) {
    throw new MetorikSyncValidationError('A line item references an order outside the fetched order set');
  }

  const distribution = (rows, field) => Object.fromEntries(
    [...rows.reduce((counts, row) => {
      const value = row[field] ?? '(null)';
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => String(left).localeCompare(String(right)))
  );
  const currencyDistribution = distribution(orderRows, 'currency');
  const currencies = Object.keys(currencyDistribution).filter(
    currency => currency !== '(null)'
  );
  const unexpectedCurrencies = currencies.filter(
    currency => !store.expectedOrderCurrencies.includes(currency)
  );
  const orderDates = orderRows.map(row => row.order_created_at).filter(Boolean).sort();

  const replacement = await safelyReplaceMetorikTables(store, orderRows, lineItemRows);

  return {
    success: true,
    store: store.storeName,
    orders_fetched: orderRows.length,
    orders_imported: orderRows.length,
    line_items_fetched: lineItemRows.length,
    line_items_imported: lineItemRows.length,
    first_order_date: orderDates[0] ?? null,
    last_order_date: orderDates.at(-1) ?? null,
    currencies_observed: currencies,
    currency_distribution: currencyDistribution,
    status_distribution: distribution(orderRows, 'status'),
    unexpected_currencies: unexpectedCurrencies,
    pages_fetched: fetched.pagesFetched,
    page_delay_ms: fetched.pageDelayMs,
    duplicate_order_ids_detected: 0,
    duplicate_line_item_identity_pairs_detected: 0,
    orphan_line_items_detected: orphanLineItems,
    ...replacement,
    destination_tables: [
      `${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDERS_TABLE}`,
      `${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDER_LINE_ITEMS_TABLE}`
    ]
  };
}

async function ensureMetorikCatalogueTables(store) {
  const dataset = bigquery.dataset(store.dataset);
  const [datasetExists] = await dataset.exists();
  if (!datasetExists) await bigquery.createDataset(store.dataset);

  for (const [tableName, schema] of [
    [METORIK_PRODUCTS_TABLE, METORIK_PRODUCTS_SCHEMA],
    [METORIK_PRODUCT_VARIATIONS_TABLE, METORIK_PRODUCT_VARIATIONS_SCHEMA]
  ]) {
    const table = dataset.table(tableName);
    const [exists] = await table.exists();
    if (!exists) await dataset.createTable(tableName, { schema });
  }
  return dataset;
}

function normalizedBigQueryField(field) {
  const typeAliases = { INTEGER: 'INT64', BOOLEAN: 'BOOL' };
  return {
    name: field.name,
    type: typeAliases[field.type] ?? field.type,
    mode: field.mode ?? 'NULLABLE'
  };
}

function metorikSchemaMatches(actualFields, expectedFields) {
  if (actualFields.length !== expectedFields.length) return false;
  return actualFields.every((field, index) => {
    const actual = normalizedBigQueryField(field);
    const expected = normalizedBigQueryField(expectedFields[index]);
    return actual.name === expected.name &&
      actual.type === expected.type && actual.mode === expected.mode;
  });
}

async function reconcileMetorikProductsSchema(store, dataset) {
  const table = dataset.table(METORIK_PRODUCTS_TABLE);
  const [metadata] = await table.getMetadata();
  const actualFields = metadata.schema?.fields ?? [];
  if (metorikSchemaMatches(actualFields, METORIK_PRODUCTS_SCHEMA)) return;

  const oldProductsSchema = METORIK_PRODUCTS_SCHEMA.map(field =>
    field.name === 'tags_json'
      ? { name: 'tags', type: 'STRING' }
      : field
  );
  if (!metorikSchemaMatches(actualFields, oldProductsSchema)) {
    throw new MetorikSyncValidationError(
      'Existing Metorik products table has an unexpected schema'
    );
  }

  // CREATE OR REPLACE is atomic in BigQuery. This preserves every existing row
  // while upgrading a table created by the prior release; an empty/null legacy
  // tag becomes the canonical empty JSON array and a populated scalar remains
  // represented as that scalar's JSON value.
  await bigquery.query({ query: `
    CREATE OR REPLACE TABLE
      \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCTS_TABLE}\` (
        product_id INT64 NOT NULL,
        title STRING,
        sku STRING,
        type STRING,
        status STRING,
        tags_json STRING NOT NULL,
        image STRING,
        current_price NUMERIC,
        regular_price NUMERIC,
        sale_price NUMERIC,
        stock_quantity INT64,
        in_stock BOOL,
        product_created_at TIMESTAMP,
        product_updated_at TIMESTAMP,
        synced_at TIMESTAMP NOT NULL
      )
    AS SELECT
      product_id, title, sku, type, status,
      CASE
        WHEN tags IS NULL OR tags = '' THEN '[]'
        ELSE TO_JSON_STRING(tags)
      END AS tags_json,
      image, current_price, regular_price, sale_price, stock_quantity,
      in_stock, product_created_at, product_updated_at, synced_at
    FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCTS_TABLE}\`
  ` });

  const [updatedMetadata] = await table.getMetadata();
  if (!metorikSchemaMatches(
    updatedMetadata.schema?.fields ?? [],
    METORIK_PRODUCTS_SCHEMA
  )) {
    throw new MetorikSyncValidationError(
      'Metorik products table schema reconciliation did not succeed'
    );
  }
}

function numberFromBigQuery(value) {
  return Number(value?.value ?? value ?? 0);
}

async function getMetorikCatalogueDiagnostics(
  store,
  stagingProductsName,
  stagingVariationsName
) {
  const [relationshipRows] = await bigquery.query({ query: `
    SELECT
      COUNT(DISTINCT v.product_id) AS variation_parent_ids,
      COUNTIF(p.product_id IS NOT NULL) AS variation_parents_present,
      COUNTIF(p.product_id IS NULL) AS variation_parents_absent,
      COUNT(DISTINCT IF(p.product_id IS NOT NULL, v.product_id, NULL))
        AS distinct_variation_parents_present,
      COUNT(DISTINCT IF(p.product_id IS NULL, v.product_id, NULL))
        AS distinct_variation_parents_absent
    FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingVariationsName}\` v
    LEFT JOIN \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingProductsName}\` p
      USING (product_id)
  ` });
  const [historicalRows] = await bigquery.query({ query: `
    WITH historical_products AS (
      SELECT DISTINCT product_id
      FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDER_LINE_ITEMS_TABLE}\`
      WHERE product_id IS NOT NULL
    ), historical_variations AS (
      SELECT DISTINCT variation_id
      FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_ORDER_LINE_ITEMS_TABLE}\`
      WHERE variation_id IS NOT NULL AND variation_id != 0
    ), product_comparison AS (
      SELECT h.product_id, p.product_id IS NOT NULL AS is_present
      FROM historical_products h
      LEFT JOIN \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingProductsName}\` p
        USING (product_id)
    ), variation_comparison AS (
      SELECT h.variation_id, v.variation_id IS NOT NULL AS is_present
      FROM historical_variations h
      LEFT JOIN \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingVariationsName}\` v
        USING (variation_id)
    )
    SELECT
      (SELECT COUNT(*) FROM product_comparison) AS historical_product_ids,
      (SELECT COUNTIF(is_present) FROM product_comparison)
        AS historical_product_ids_present,
      (SELECT COUNTIF(NOT is_present) FROM product_comparison)
        AS historical_product_ids_absent,
      ARRAY(
        SELECT product_id FROM product_comparison
        WHERE NOT is_present ORDER BY product_id LIMIT 10
      ) AS sample_absent_product_ids,
      (SELECT COUNT(*) FROM variation_comparison) AS historical_variation_ids,
      (SELECT COUNTIF(is_present) FROM variation_comparison)
        AS historical_variation_ids_present,
      (SELECT COUNTIF(NOT is_present) FROM variation_comparison)
        AS historical_variation_ids_absent,
      ARRAY(
        SELECT variation_id FROM variation_comparison
        WHERE NOT is_present ORDER BY variation_id LIMIT 10
      ) AS sample_absent_variation_ids
  ` });

  const relationship = relationshipRows[0] ?? {};
  const historical = historicalRows[0] ?? {};
  const historicalProductIds = numberFromBigQuery(
    historical.historical_product_ids
  );
  const historicalProductIdsPresent = numberFromBigQuery(
    historical.historical_product_ids_present
  );
  const historicalVariationIds = numberFromBigQuery(
    historical.historical_variation_ids
  );
  const historicalVariationIdsPresent = numberFromBigQuery(
    historical.historical_variation_ids_present
  );

  return {
    variation_parent_ids: numberFromBigQuery(relationship.variation_parent_ids),
    variation_parents_present: numberFromBigQuery(
      relationship.variation_parents_present
    ),
    variation_parents_absent: numberFromBigQuery(
      relationship.variation_parents_absent
    ),
    distinct_variation_parents_present: numberFromBigQuery(
      relationship.distinct_variation_parents_present
    ),
    distinct_variation_parents_absent: numberFromBigQuery(
      relationship.distinct_variation_parents_absent
    ),
    historical_product_ids: historicalProductIds,
    historical_product_ids_present: historicalProductIdsPresent,
    historical_product_ids_absent: numberFromBigQuery(
      historical.historical_product_ids_absent
    ),
    historical_product_ids_present_percentage: historicalProductIds === 0
      ? null
      : 100 * historicalProductIdsPresent / historicalProductIds,
    sample_absent_product_ids: historical.sample_absent_product_ids ?? [],
    historical_variation_ids: historicalVariationIds,
    historical_variation_ids_present: historicalVariationIdsPresent,
    historical_variation_ids_absent: numberFromBigQuery(
      historical.historical_variation_ids_absent
    ),
    historical_variation_ids_present_percentage: historicalVariationIds === 0
      ? null
      : 100 * historicalVariationIdsPresent / historicalVariationIds,
    sample_absent_variation_ids: historical.sample_absent_variation_ids ?? []
  };
}

async function safelyReplaceMetorikCatalogue(store, productRows, variationRows) {
  const dataset = await ensureMetorikCatalogueTables(store);
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const stagingProductsName = `_staging_products_${suffix}`;
  const stagingVariationsName = `_staging_product_variations_${suffix}`;
  const [stagingProducts] = await dataset.createTable(stagingProductsName, {
    schema: METORIK_PRODUCTS_SCHEMA,
    expirationTime: Date.now() + 24 * 60 * 60 * 1000
  });
  let stagingVariations;

  try {
    [stagingVariations] = await dataset.createTable(stagingVariationsName, {
      schema: METORIK_PRODUCT_VARIATIONS_SCHEMA,
      expirationTime: Date.now() + 24 * 60 * 60 * 1000
    });
    await insertMetorikRows(stagingProducts, productRows);
    await insertMetorikRows(stagingVariations, variationRows);

    const [counts] = await bigquery.query({ query: `
      SELECT
        (SELECT COUNT(*) FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingProductsName}\`)
          AS products_count,
        (SELECT COUNT(*) FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingVariationsName}\`)
          AS variations_count
    ` });
    if (
      numberFromBigQuery(counts[0]?.products_count) !== productRows.length ||
      numberFromBigQuery(counts[0]?.variations_count) !== variationRows.length
    ) {
      throw new MetorikSyncValidationError(
        'BigQuery catalogue staging row counts did not match validated source data'
      );
    }

    const diagnostics = await getMetorikCatalogueDiagnostics(
      store,
      stagingProductsName,
      stagingVariationsName
    );

    // Reconcile only after the complete source has transformed and both
    // staging tables and diagnostics have succeeded. Unexpected schemas abort
    // without modifying production.
    await reconcileMetorikProductsSchema(store, dataset);

    // One transaction prevents current products and variations from ever
    // representing different successful ingestion runs.
    await bigquery.query({ query: `
      BEGIN TRANSACTION;
      DELETE FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCTS_TABLE}\`
        WHERE TRUE;
      INSERT INTO \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCTS_TABLE}\`
        SELECT * FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingProductsName}\`;
      DELETE FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCT_VARIATIONS_TABLE}\`
        WHERE TRUE;
      INSERT INTO \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCT_VARIATIONS_TABLE}\`
        SELECT * FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingVariationsName}\`;
      COMMIT TRANSACTION;
    ` });

    return {
      ...diagnostics,
      staging_products_count: productRows.length,
      staging_variations_count: variationRows.length,
      coordinated_transactional_replacement: true
    };
  } finally {
    await Promise.allSettled([
      stagingProducts.delete({ ignoreNotFound: true }),
      stagingVariations?.delete({ ignoreNotFound: true })
    ]);
  }
}

async function syncMetorikProducts(store) {
  const fetchedProducts = await fetchAllMetorikCatalogueResource(
    store,
    'products',
    'product_id'
  );
  const fetchedVariations = await fetchAllMetorikCatalogueResource(
    store,
    'variations',
    'variation_id'
  );
  if (!fetchedProducts.paginationCompleted || fetchedProducts.records.length === 0) {
    throw new MetorikSyncValidationError(
      'Metorik did not return a complete, non-empty product catalogue'
    );
  }
  if (!fetchedVariations.paginationCompleted || fetchedVariations.records.length === 0) {
    throw new MetorikSyncValidationError(
      'Metorik did not return a complete, non-empty variation catalogue'
    );
  }

  const syncedAt = new Date().toISOString();
  const productRows = fetchedProducts.records.map(product =>
    transformMetorikProduct(product, syncedAt)
  );
  const variationRows = fetchedVariations.records.map(variation =>
    transformMetorikProductVariation(variation, syncedAt)
  );
  if (productRows.length !== fetchedProducts.records.length ||
      variationRows.length !== fetchedVariations.records.length) {
    throw new MetorikSyncValidationError(
      'Transformed catalogue counts did not match fetched source counts'
    );
  }
  const duplicateProductIds = duplicateMetorikIds(productRows, 'product_id');
  const duplicateVariationIds = duplicateMetorikIds(variationRows, 'variation_id');
  if (duplicateProductIds.length > 0) {
    throw new MetorikSyncValidationError(
      `Duplicate product IDs detected (${duplicateProductIds.length})`
    );
  }
  if (duplicateVariationIds.length > 0) {
    throw new MetorikSyncValidationError(
      `Duplicate variation IDs detected (${duplicateVariationIds.length})`
    );
  }
  if (productRows.some(row => row.product_id === null)) {
    throw new MetorikSyncValidationError('A product is missing required product_id');
  }
  if (variationRows.some(row =>
    row.variation_id === null || row.product_id === null
  )) {
    throw new MetorikSyncValidationError(
      'A variation is missing required variation_id or product_id'
    );
  }

  const productTypes = {};
  const productStatuses = {};
  for (const row of productRows) {
    const type = row.type ?? '(null)';
    productTypes[type] = (productTypes[type] ?? 0) + 1;
    const status = row.status ?? '(null)';
    productStatuses[status] = (productStatuses[status] ?? 0) + 1;
  }
  const validation = await safelyReplaceMetorikCatalogue(
    store,
    productRows,
    variationRows
  );

  return {
    success: true,
    store: store.storeName,
    products_fetched: fetchedProducts.records.length,
    products_imported: productRows.length,
    variations_fetched: fetchedVariations.records.length,
    variations_imported: variationRows.length,
    product_types: productTypes,
    product_statuses: productStatuses,
    products_pages_fetched: fetchedProducts.pagesFetched,
    variations_pages_fetched: fetchedVariations.pagesFetched,
    page_delay_ms: METORIK_PAGE_DELAY_MS,
    duplicate_product_ids_detected: 0,
    duplicate_variation_ids_detected: 0,
    ...validation,
    destination_tables: [
      `${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCTS_TABLE}`,
      `${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_PRODUCT_VARIATIONS_TABLE}`
    ]
  };
}

async function ensureMetorikCustomersTable(store) {
  const dataset = bigquery.dataset(store.dataset);
  const [datasetExists] = await dataset.exists();
  if (!datasetExists) {
    await bigquery.createDataset(store.dataset);
  }

  const table = dataset.table(METORIK_CUSTOMERS_TABLE);
  const [tableExists] = await table.exists();
  if (!tableExists) {
    await dataset.createTable(METORIK_CUSTOMERS_TABLE, {
      schema: METORIK_CUSTOMERS_SCHEMA
    });
  }
  return dataset;
}

async function safelyReplaceMetorikCustomers(store, customerRows) {
  const dataset = await ensureMetorikCustomersTable(store);
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const stagingName = `_staging_customers_${suffix}`;
  const [stagingTable] = await dataset.createTable(stagingName, {
    schema: METORIK_CUSTOMERS_SCHEMA,
    expirationTime: Date.now() + 24 * 60 * 60 * 1000
  });

  try {
    await insertMetorikRows(stagingTable, customerRows);
    const [counts] = await bigquery.query({ query: `
      SELECT COUNT(*) AS customer_count
      FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingName}\`
    ` });
    if (Number(counts[0]?.customer_count) !== customerRows.length) {
      throw new MetorikSyncValidationError(
        'BigQuery customer staging row count did not match the validated source data'
      );
    }

    await bigquery.query({ query: `
      BEGIN TRANSACTION;
      DELETE FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_CUSTOMERS_TABLE}\` WHERE TRUE;
      INSERT INTO \`${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_CUSTOMERS_TABLE}\`
        SELECT * FROM \`${GOOGLE_PROJECT_ID}.${store.dataset}.${stagingName}\`;
      COMMIT TRANSACTION;
    ` });

    return {
      staging_customers_count: customerRows.length,
      transactional_replacement: true
    };
  } finally {
    await Promise.allSettled([
      stagingTable.delete({ ignoreNotFound: true })
    ]);
  }
}

async function syncMetorikCustomers(store) {
  const fetched = await fetchAllMetorikCustomers(store);
  if (!fetched.paginationCompleted || fetched.customers.length === 0) {
    throw new MetorikSyncValidationError(
      'Metorik did not return a complete, non-empty customer history'
    );
  }

  const syncedAt = new Date().toISOString();
  const customerRows = fetched.customers.map(customer =>
    transformMetorikCustomer(customer, syncedAt)
  );
  const duplicateCustomerIds = duplicateMetorikIds(
    customerRows,
    'metorik_customer_id'
  );
  if (duplicateCustomerIds.length > 0) {
    throw new MetorikSyncValidationError(
      `Duplicate metorik_customer_id identities detected (${duplicateCustomerIds.length})`
    );
  }

  const createdDates = customerRows
    .map(row => row.created_at)
    .filter(Boolean)
    .sort();
  const currencies = [...new Set(
    customerRows.map(row => row.currency).filter(Boolean)
  )].sort();

  const replacement = await safelyReplaceMetorikCustomers(store, customerRows);

  return {
    success: true,
    store: store.storeName,
    customers_fetched: customerRows.length,
    customers_imported: customerRows.length,
    metorik_customer_id_count: customerRows.filter(
      row => row.metorik_customer_id !== null
    ).length,
    registered_woo_linked_customers: customerRows.filter(
      row => row.customer_id !== null && row.customer_id > 0
    ).length,
    guest_customer_id_zero_count: customerRows.filter(
      row => row.customer_id === 0
    ).length,
    customers_with_orders: customerRows.filter(row => row.order_count > 0).length,
    customers_with_zero_orders: customerRows.filter(row => row.order_count === 0).length,
    first_order_date_populated_count: customerRows.filter(
      row => row.first_order_date !== null
    ).length,
    last_order_date_populated_count: customerRows.filter(
      row => row.last_order_date !== null
    ).length,
    first_customer_created_date: createdDates[0] ?? null,
    last_customer_created_date: createdDates.at(-1) ?? null,
    currencies_observed: currencies,
    pages_fetched: fetched.pagesFetched,
    page_delay_ms: fetched.pageDelayMs,
    duplicate_canonical_identities_detected: 0,
    ...replacement,
    destination_table:
      `${GOOGLE_PROJECT_ID}.${store.dataset}.${METORIK_CUSTOMERS_TABLE}`
  };
}

function addMetorikSyncRoute({ path, store, resourceLabel, sync }) {
  app.post(path, requireSyncSecret, async (req, res) => {
    if (!store.apiKey) {
      return res.status(500).json({
        success: false,
        store: store.storeName,
        error: `${store.apiKeyEnvironmentVariable} is not configured`
      });
    }

    try {
      return res.json(await sync(store));
    } catch (error) {
      console.error(
        `Metorik ${store.storeName} ${resourceLabel} sync failed:`,
        error.name
      );
      if (error instanceof MetorikSyncValidationError && error.diagnostics) {
        console.error(
          `Metorik ${store.storeName} ${resourceLabel} sync diagnostics:`,
          error.diagnostics
        );
      }
      return res.status(500).json({
        success: false,
        store: store.storeName,
        error: error instanceof MetorikSyncValidationError
          ? error.message
          : `Metorik ${store.storeName} ${resourceLabel} sync failed`,
        ...(error instanceof MetorikSyncValidationError && error.diagnostics
          ? { diagnostics: error.diagnostics }
          : {})
      });
    }
  });
}

for (const [slug, store] of Object.entries({
  uk: METORIK_STORES.UK,
  us: METORIK_STORES.US
})) {
  addMetorikSyncRoute({
    path: `/sync-metorik-${slug}-orders`,
    store,
    resourceLabel: 'orders',
    sync: syncMetorikOrders
  });
  addMetorikSyncRoute({
    path: `/sync-metorik-${slug}-customers`,
    store,
    resourceLabel: 'customers',
    sync: syncMetorikCustomers
  });
  addMetorikSyncRoute({
    path: `/sync-metorik-${slug}-products`,
    store,
    resourceLabel: 'product catalogue',
    sync: syncMetorikProducts
  });
}

/* ---------------------------------------------------------
   SHOPIFY TEST
--------------------------------------------------------- */

app.get(
  '/test-shopify',
  async (req, res) => {
    try {
      const token =
        await getShopifyAccessToken();

      const query = `
        query {
          orders(
            first: 20
            sortKey: CREATED_AT
            reverse: true
          ) {
            nodes {
              id
              name
              createdAt
              updatedAt

              app {
                id
                name
              }

              retailLocation {
                id
                name
              }
            }
          }
        }
      `;

      const data =
        await shopifyGraphQL(
          token,
          query
        );

      const orders =
        data.orders.nodes;

      res.json({
        success: true,

        count:
          orders.length,

        orders:
          orders.map(
            order => ({
              id:
                order.id,

              name:
                order.name,

              created_at:
                order.createdAt,

              source:
                order.app?.name ||
                null,

              retail_location_id:
                order
                  .retailLocation
                  ?.id ||
                null,

              retail_location_name:
                order
                  .retailLocation
                  ?.name ||
                null
            })
          )
      });
    } catch (error) {
      console.error(
        error
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

/* ---------------------------------------------------------
   SHOPIFY SYNC
--------------------------------------------------------- */

app.post(
  '/sync-shopify',
  requireSyncSecret,
  async (req, res) => {
    try {
      const result =
        await syncShopify();

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error(
        error
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

/* Shopify journeys are order-associated converting journeys, not evidence about
 * all traffic or non-converting sessions. Conversion/funnel claims require GA4
 * or an equivalent session analytics source. */
app.post(
  '/sync-shopify-acquisition',
  requireSyncSecret,
  express.json({ limit: '10kb' }),
  async (req, res) => {
    try {
      const token = await getShopifyAccessToken();
      const result = await syncShopifyAcquisition({
        body: req.body,
        graphql: (query, variables) => shopifyGraphQL(token, query, variables),
        bigquery,
        projectId: GOOGLE_PROJECT_ID
      });
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('Shopify acquisition sync failed:', error.name);
      res.status(error instanceof AcquisitionValidationError ? 400 : 500).json({
        success: false,
        error: error instanceof AcquisitionValidationError
          ? error.message
          : 'Shopify acquisition sync failed'
      });
    }
  }
);

/* Aggregate-only GA4 behavioural evidence. This never reads Shopify orders and
 * never treats GA4 purchases as transaction or revenue truth. */
app.post(
  '/sync-ga4',
  requireSyncSecret,
  express.json({ limit: '10kb' }),
  async (req, res) => {
    try {
      if (!GA4_PROPERTY_ID || !/^\d+$/.test(GA4_PROPERTY_ID)) throw new Error('GA4_PROPERTY_ID is not configured');
      const args = [];
      if (req.body?.start_date) args.push('--start', req.body.start_date);
      if (req.body?.end_date) args.push('--end', req.body.end_date);
      const options = parseGa4SyncArgs(args);
      const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
      const result = await syncGa4({ ...options, project: GOOGLE_PROJECT_ID, propertyId: GA4_PROPERTY_ID, client: new BetaAnalyticsDataClient({ credentials }), bigquery });
      res.json({ success: true, ...result });
    } catch (error) {
      console.error('GA4 semantic sync failed:', error.name);
      res.status(/date|range|configured|maximum/i.test(error.message) ? 400 : 500).json({ success: false, error: 'GA4 semantic sync failed', detail: String(error.message).slice(0, 300) });
    }
  }
);

/* ---------------------------------------------------------
   WOO US REFUNDS
--------------------------------------------------------- */

app.post(
  '/sync-woo-us-refunds',
  requireSyncSecret,
  async (req, res) => {
    try {
      const result =
        await syncWooRefunds({
          storeName: 'US',

          datasetName:
            'woocommerce_us',

          wooUrlRaw:
            WOO_US_URL,

          consumerKey:
            WOO_US_CONSUMER_KEY,

          consumerSecret:
            WOO_US_CONSUMER_SECRET
        });

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error(
        error
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

/* ---------------------------------------------------------
   WOO JP REFUNDS
--------------------------------------------------------- */

app.post(
  '/sync-woo-jp-refunds',
  requireSyncSecret,
  async (req, res) => {
    try {
      const result =
        await syncWooRefunds({
          storeName: 'JP',

          datasetName:
            'woocommerce_jp',

          wooUrlRaw:
            WOO_JP_URL,

          consumerKey:
            WOO_JP_CONSUMER_KEY,

          consumerSecret:
            WOO_JP_CONSUMER_SECRET
        });

      res.json({
        success: true,
        ...result
      });
    } catch (error) {
      console.error(
        error
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

/* =========================================================
   WOO UK - FULL HISTORIC ORDER IMPORT
========================================================= */

const {
  WOO_UK_URL,
  WOO_UK_CONSUMER_KEY,
  WOO_UK_CONSUMER_SECRET
} = process.env;

const WOO_UK_DATASET =
  'woocommerce_uk';

const WOO_UK_ORDERS_TABLE =
  'orders_api';

function wooBasicAuth(
  consumerKey,
  consumerSecret
) {
  return Buffer.from(
    `${consumerKey}:${consumerSecret}`
  ).toString('base64');
}

function wooDateToIso(value) {
  if (!value) return null;

  // Woo's *_gmt fields normally come without a timezone suffix.
  return new Date(
    `${value}Z`
  ).toISOString();
}

async function ensureWooUKDataset() {
  const dataset =
    bigquery.dataset(
      WOO_UK_DATASET
    );

  const [exists] =
    await dataset.exists();

  if (!exists) {
    throw new Error(
      `BigQuery dataset ${GOOGLE_PROJECT_ID}.${WOO_UK_DATASET} does not exist`
    );
  }

  return dataset;
}

async function ensureWooUKOrdersTable() {
  const dataset =
    await ensureWooUKDataset();

  const table =
    dataset.table(
      WOO_UK_ORDERS_TABLE
    );

  const [exists] =
    await table.exists();

  if (exists) {
    return table;
  }

  console.log(
    `Creating ${GOOGLE_PROJECT_ID}.${WOO_UK_DATASET}.${WOO_UK_ORDERS_TABLE}`
  );

  await dataset.createTable(
    WOO_UK_ORDERS_TABLE,
    {
      schema: [
        {
          name: 'order_id',
          type: 'STRING',
          mode: 'REQUIRED'
        },
        {
          name: 'order_number',
          type: 'STRING'
        },

        {
          name: 'status',
          type: 'STRING'
        },
        {
          name: 'currency',
          type: 'STRING'
        },

        {
          name: 'date_created',
          type: 'TIMESTAMP'
        },
        {
          name: 'date_modified',
          type: 'TIMESTAMP'
        },
        {
          name: 'date_paid',
          type: 'TIMESTAMP'
        },
        {
          name: 'date_completed',
          type: 'TIMESTAMP'
        },

        {
          name: 'total',
          type: 'NUMERIC'
        },
        {
          name: 'total_tax',
          type: 'NUMERIC'
        },

        {
          name: 'shipping_total',
          type: 'NUMERIC'
        },
        {
          name: 'shipping_tax',
          type: 'NUMERIC'
        },

        {
          name: 'discount_total',
          type: 'NUMERIC'
        },
        {
          name: 'discount_tax',
          type: 'NUMERIC'
        },

        {
          name: 'cart_tax',
          type: 'NUMERIC'
        },

        {
          name: 'prices_include_tax',
          type: 'BOOL'
        },

        {
          name: 'payment_method',
          type: 'STRING'
        },
        {
          name: 'payment_method_title',
          type: 'STRING'
        },
        {
          name: 'transaction_id',
          type: 'STRING'
        },

        {
          name: 'created_via',
          type: 'STRING'
        },

        {
          name: 'billing_country',
          type: 'STRING'
        },
        {
          name: 'shipping_country',
          type: 'STRING'
        },

        {
          name: 'customer_id',
          type: 'STRING'
        },

        // Keep full structures so we can properly inspect:
        // gift cards, vouchers, VAT, refunds, unusual historic metadata, etc.
        {
          name: 'line_items_json',
          type: 'STRING'
        },
        {
          name: 'tax_lines_json',
          type: 'STRING'
        },
        {
          name: 'shipping_lines_json',
          type: 'STRING'
        },
        {
          name: 'coupon_lines_json',
          type: 'STRING'
        },
        {
          name: 'fee_lines_json',
          type: 'STRING'
        },
        {
          name: 'refunds_json',
          type: 'STRING'
        },
        {
          name: 'meta_data_json',
          type: 'STRING'
        },

        // Preserve the complete Woo response as an escape hatch.
        {
          name: 'raw_json',
          type: 'STRING'
        },

        {
          name: 'synced_at',
          type: 'TIMESTAMP'
        }
      ]
    }
  );

  return dataset.table(
    WOO_UK_ORDERS_TABLE
  );
}

function transformWooUKOrder(order) {
  return {
    order_id:
      String(order.id),

    order_number:
      order.number !== undefined &&
      order.number !== null
        ? String(order.number)
        : null,

    status:
      order.status || null,

    currency:
      order.currency || null,

    date_created:
      wooDateToIso(
        order.date_created_gmt
      ),

    date_modified:
      wooDateToIso(
        order.date_modified_gmt
      ),

    date_paid:
      wooDateToIso(
        order.date_paid_gmt
      ),

    date_completed:
      wooDateToIso(
        order.date_completed_gmt
      ),

    total:
      Number(
        order.total || 0
      ),

    total_tax:
      Number(
        order.total_tax || 0
      ),

    shipping_total:
      Number(
        order.shipping_total || 0
      ),

    shipping_tax:
      Number(
        order.shipping_tax || 0
      ),

    discount_total:
      Number(
        order.discount_total || 0
      ),

    discount_tax:
      Number(
        order.discount_tax || 0
      ),

    cart_tax:
      Number(
        order.cart_tax || 0
      ),

    prices_include_tax:
      order.prices_include_tax === true,

    payment_method:
      order.payment_method || null,

    payment_method_title:
      order.payment_method_title || null,

    transaction_id:
      order.transaction_id || null,

    created_via:
      order.created_via || null,

    billing_country:
      order.billing?.country || null,

    shipping_country:
      order.shipping?.country || null,

    customer_id:
      order.customer_id !== undefined &&
      order.customer_id !== null
        ? String(order.customer_id)
        : null,

    line_items_json:
      JSON.stringify(
        order.line_items || []
      ),

    tax_lines_json:
      JSON.stringify(
        order.tax_lines || []
      ),

    shipping_lines_json:
      JSON.stringify(
        order.shipping_lines || []
      ),

    coupon_lines_json:
      JSON.stringify(
        order.coupon_lines || []
      ),

    fee_lines_json:
      JSON.stringify(
        order.fee_lines || []
      ),

    refunds_json:
      JSON.stringify(
        order.refunds || []
      ),

    meta_data_json:
      JSON.stringify(
        order.meta_data || []
      ),

    raw_json:
      JSON.stringify(order),

    synced_at:
      new Date().toISOString()
  };
}

async function syncWooUKOrders() {
  if (
    !WOO_UK_URL ||
    !WOO_UK_CONSUMER_KEY ||
    !WOO_UK_CONSUMER_SECRET
  ) {
    throw new Error(
      'Missing WooCommerce UK environment variables'
    );
  }

  console.log(
    'Starting paged WooCommerce UK historic order import'
  );

  const table =
    await ensureWooUKOrdersTable();

  const wooUrl =
    WOO_UK_URL.replace(/\/$/, '');

  const auth =
    wooBasicAuth(
      WOO_UK_CONSUMER_KEY,
      WOO_UK_CONSUMER_SECRET
    );

  /*
   * Clear the destination ONCE before we start.
   * After this, every Woo page is written immediately
   * instead of keeping the entire history in memory.
   */
  console.log(
    'Clearing existing Woo UK API order table...'
  );

  await bigquery.query({
    query: `
      TRUNCATE TABLE
      \`${GOOGLE_PROJECT_ID}.${WOO_UK_DATASET}.${WOO_UK_ORDERS_TABLE}\`
    `
  });

  let page = 1;
  let totalPages = null;
  let totalOrdersReported = null;
  let rowsWritten = 0;

  while (true) {
    console.log(
      `Fetching Woo UK orders page ${page}` +
      (totalPages ? `/${totalPages}` : '')
    );

    const url =
      `${wooUrl}/wp-json/wc/v3/orders` +
      `?per_page=100` +
      `&page=${page}` +
      `&status=any` +
      `&orderby=id` +
      `&order=asc`;

    const response =
      await fetch(
        url,
        {
          headers: {
            Authorization:
              `Basic ${auth}`,
            Accept:
              'application/json'
          }
        }
      );

    if (!response.ok) {
      const body =
        await response.text();

      throw new Error(
        `Woo UK order fetch failed on page ${page}: ` +
        `${response.status} ${body}`
      );
    }

    const orders =
      await response.json();

    if (!Array.isArray(orders)) {
      throw new Error(
        `Unexpected Woo UK response on page ${page}`
      );
    }

    if (totalPages === null) {
      totalPages =
        Number(
          response.headers.get(
            'x-wp-totalpages'
          ) || 0
        );

      totalOrdersReported =
        Number(
          response.headers.get(
            'x-wp-total'
          ) || 0
        );

      console.log(
        `Woo UK reports ${totalOrdersReported} total orders across ${totalPages} pages`
      );
    }

    if (orders.length === 0) {
      console.log(
        `Woo UK page ${page} returned no orders`
      );

      break;
    }

    /*
     * Transform ONLY this page.
     *
     * Once the loop moves on, these objects can be
     * garbage-collected. We never retain all 38k orders.
     */
    const rows =
      orders.map(
        transformWooUKOrder
      );

    await table.insert(rows);

    rowsWritten += rows.length;

    console.log(
      `Woo UK page ${page}/${totalPages}: ` +
      `inserted ${rows.length} orders - ` +
      `${rowsWritten}/${totalOrdersReported} total written`
    );

    if (
      totalPages &&
      page >= totalPages
    ) {
      break;
    }

    page++;
  }

  console.log(
    `Woo UK historic order import complete - ${rowsWritten} rows written`
  );

  return {
    orders_reported:
      totalOrdersReported,

    pages_processed:
      page,

    rows_written:
      rowsWritten
  };
}

/* =========================================================
   WOO UK - REFUNDS
========================================================= */

async function ensureWooUKRefundsTable() {
  const dataset =
    await ensureWooUKDataset();

  const tableName =
    'refunds_api';

  const table =
    dataset.table(
      tableName
    );

  const [exists] =
    await table.exists();

  if (!exists) {
    console.log(
      `Creating ${GOOGLE_PROJECT_ID}.${WOO_UK_DATASET}.${tableName}`
    );

    await dataset.createTable(
      tableName,
      {
        schema: [
          {
            name: 'refund_id',
            type: 'STRING',
            mode: 'REQUIRED'
          },
          {
            name: 'order_id',
            type: 'STRING',
            mode: 'REQUIRED'
          },
          {
            name: 'refund_date',
            type: 'TIMESTAMP'
          },
          {
            name: 'refund_amount',
            type: 'NUMERIC'
          },
          {
            name: 'reason',
            type: 'STRING'
          },
          {
            name: 'refunded_by',
            type: 'STRING'
          },
          {
            name: 'api_refunded',
            type: 'BOOL'
          },
          {
            name: 'line_items_json',
            type: 'STRING'
          },
          {
            name: 'raw_json',
            type: 'STRING'
          },
          {
            name: 'synced_at',
            type: 'TIMESTAMP'
          }
        ]
      }
    );
  }

  return dataset.table(
    tableName
  );
}

async function syncWooUKRefunds() {
  if (
    !WOO_UK_URL ||
    !WOO_UK_CONSUMER_KEY ||
    !WOO_UK_CONSUMER_SECRET
  ) {
    throw new Error(
      'Missing WooCommerce UK environment variables'
    );
  }

  const wooUrl =
    WOO_UK_URL.replace(
      /\/$/,
      ''
    );

  const auth =
    wooBasicAuth(
      WOO_UK_CONSUMER_KEY,
      WOO_UK_CONSUMER_SECRET
    );

  // Our UK API orders table is one row per order,
  // so no DISTINCT/deduping is necessary here.
  const [orders] =
    await bigquery.query({
      query: `
        SELECT
          order_id
        FROM
          \`${GOOGLE_PROJECT_ID}.${WOO_UK_DATASET}.${WOO_UK_ORDERS_TABLE}\`
        WHERE
          refunds_json IS NOT NULL
          AND TRIM(refunds_json) NOT IN (
            '',
            '[]',
            '{}'
          )
        ORDER BY
          SAFE_CAST(
            order_id AS INT64
          )
      `
    });

  console.log(
    `Found ${orders.length} Woo UK orders containing refund references`
  );

  const refundRows = [];
  const failedOrders = [];

  let checked = 0;

  for (
    const order of orders
  ) {
    const orderId =
      String(
        order.order_id
      );

    checked++;

    console.log(
      `Fetching Woo UK refunds ${checked}/${orders.length} - order ${orderId}`
    );

    const response =
      await fetch(
        `${wooUrl}/wp-json/wc/v3/orders/${orderId}/refunds?per_page=100`,
        {
          headers: {
            Authorization:
              `Basic ${auth}`,

            Accept:
              'application/json'
          }
        }
      );

    if (!response.ok) {
      const body =
        await response.text();

      console.error(
        `Woo UK refund fetch failed for order ${orderId}:`,
        response.status,
        body
      );

      failedOrders.push(
        orderId
      );

      continue;
    }

    const refunds =
      await response.json();

    for (
      const refund of refunds
    ) {
      refundRows.push({
        refund_id:
          String(
            refund.id
          ),

        order_id:
          orderId,

        refund_date:
          wooDateToIso(
            refund.date_created_gmt
          ),

        refund_amount:
          Number(
            refund.amount || 0
          ),

        reason:
          refund.reason || null,

        refunded_by:
          refund.refunded_by !==
            undefined &&
          refund.refunded_by !==
            null
            ? String(
                refund.refunded_by
              )
            : null,

        api_refunded:
          refund.api_refund ===
          true,

        line_items_json:
          JSON.stringify(
            refund.line_items || []
          ),

        raw_json:
          JSON.stringify(
            refund
          ),

        synced_at:
          new Date().toISOString()
      });
    }
  }

  console.log(
    `Found ${refundRows.length} individual Woo UK refunds`
  );

  const table =
    await ensureWooUKRefundsTable();

  await bigquery.query({
    query: `
      TRUNCATE TABLE
      \`${GOOGLE_PROJECT_ID}.${WOO_UK_DATASET}.refunds_api\`
    `
  });

  const batchSize = 500;

  for (
    let i = 0;
    i < refundRows.length;
    i += batchSize
  ) {
    const batch =
      refundRows.slice(
        i,
        i + batchSize
      );

    await table.insert(
      batch
    );

    console.log(
      `Inserted ${Math.min(
        i + batch.length,
        refundRows.length
      )}/${refundRows.length} Woo UK refunds`
    );
  }

  return {
    refund_orders_checked:
      orders.length,

    refunds_imported:
      refundRows.length,

    failed_orders:
      failedOrders.length,

    failed_order_ids:
      failedOrders
  };
}

/* =========================================================
   WOO UK ROUTES
========================================================= */

app.post(
  '/sync-woo-uk-orders',
  requireSyncSecret,
  async (req, res) => {
    try {
      const result =
        await syncWooUKOrders();

      res.json({
        success: true,
        store: 'UK',
        dataset:
          WOO_UK_DATASET,
        ...result
      });
    } catch (error) {
      console.error(
        'Woo UK order sync error:',
        error
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);

app.post(
  '/sync-woo-uk-refunds',
  requireSyncSecret,
  async (req, res) => {
    try {
      const result =
        await syncWooUKRefunds();

      res.json({
        success: true,
        store: 'UK',
        dataset:
          WOO_UK_DATASET,
        ...result
      });
    } catch (error) {
      console.error(
        'Woo UK refund sync error:',
        error
      );

      res
        .status(500)
        .json({
          success: false,
          error:
            error.message
        });
    }
  }
);



app.post(
  '/agent',
  requireSyncSecret,
  express.json(),
  async (req, res) => {
    const suppliedDeadline = Number(req.body?.deadline_at);
    const deadlineAt = Math.min(
      Number.isFinite(suppliedDeadline) ? suppliedDeadline : Date.now() + 90_000,
      Date.now() + 90_000
    );
    return requestBudget.run({ deadlineAt }, async () => {
    try {
      const message = req.body?.message;

      if (!message) {
        return res.status(400).json({
          success: false,
          error: 'message is required'
        });
      }

      const currentDate = new Date()
        .toISOString()
        .slice(0, 10);

      const tools = createOracleToolDefinitions();

      const toolsUsed = new Set();
      let remainingQueryBytes = 20_000_000_000;
      let inlineChart = null;
      const toolSignatures = new Set();
      let toolRounds = 0;
      let response = await openai.responses.create({
        model: 'gpt-5.6',
        instructions: `
You are The Great Frog ecommerce data analyst.

You answer questions using the supplied tools.

Current date: ${currentDate}

Important rules:
- For an ecommerce report, monthly ecommerce report, management ecommerce report or ecommerce performance overview, call get_ecommerce_management_report first. Analyse that semantic report, then use lower-level tools only for requested or necessary drill-downs.
- Never ask the user for an explicit date when their requested date range can be unambiguously resolved from the current date.
- Interpret "2026 so far", "2026 YTD", "year to date" when referring to 2026, and equivalent wording as 2026-01-01 through today's date.
- More generally, "<year> so far" means January 1 of that year through the earlier of today's date or December 31 of that year.
- "This year" and "year to date" mean January 1 of the current year through today.
- "This month" means the first day of the current month through today; "this week" means the start of the current calendar week through today.
- "Today" means today's date; "yesterday" means yesterday's date.
- "Last month" means the complete previous calendar month; "last year" means the complete previous calendar year.
- For a named complete past year such as 2025, use January 1 through December 31 of that year.
- An unqualified “after <date>” is an exclusive lower bound with no user-specified upper bound: set start_date to the following calendar day and end_date to null. Never cap it at the end of that date's month or year. Preserve an upper bound only when the user explicitly supplies one (for example “after 20 September 2025 and before 1 October 2025”). This differs from “in September 2025”, which is the complete named month.
- Only ask the user to clarify dates when the requested period is genuinely ambiguous. Do not ask for an as-of date merely because a historical Shopify tool requires explicit start_date and end_date; derive those arguments from the user's natural-language period.
- When reporting results, state the actual resolved date range used. When today's date creates a partial month, quarter or year, clearly identify it as a partial or year-to-date period where relevant.
- Never add GBP, USD and JPY together.
- Default to GBP if the user does not specify a currency and the context is UK retail.
- For phrases like "how much did we take", "how much did we make", "revenue", or "how did we do", use net_gross as the headline figure.
- Sales gross is positive sales before refunds.
- Refunds gross is negative.
- Net gross is sales after refunds.
- Be concise and commercially useful.
- State the date range and currency used.
- If comparing periods, show the absolute difference and percentage change where available.
- When discussing refunds, remember refund gross values are negative. Use refunded_amount when presenting a positive human-readable refund total.
- Gift card issuance data is incomplete for historical WooCommerce. Mention this limitation when relevant.
- BigQuery is the source of truth for historical financial reporting.
- Governed quantitative tools remain authoritative for measured numerical facts. Knowledge and memory provide context and must never override a current governed metric or be used as a numerical cache.
- For every two-period Report v2 investigation, build an evidence plan for finance, GA4, Search Console, customers, products, geography, Knowledge and relevant Memory. Determine current and comparison availability independently. Distinguish available/comparable, available/not directly comparable, and unavailable. Never turn an unavailable comparison period into “no evidence” when current-period evidence exists.
- For historical analysis, named campaigns/events/initiatives, or questions asking why a metric changed, retrieve governed business context for the current period AND comparison period with separate bounded calls. Do not use a single broad query: ranking limits can crowd out one side. Consider a nearby pre-period deadline only when materially relevant. For named comparisons, retrieve each governed campaign window before choosing dates; compare campaign windows rather than matching calendar dates. Never invent a missing campaign date or offer.
- Persisted governed GA4 and Search Console are separate from Shopify operational sessions. Never silently substitute Shopify sessions for GA4. Search Console uses canonical daily Domain-preferred/www-fallback evidence and never sums overlapping properties; query omission can reflect anonymization. Current-only evidence may still be analysed, but cannot support a direct period comparison.
- Woo and Shopify product rankings can be reported separately even without a cross-platform product identity bridge. Likewise customer evidence with differing identity/guest semantics is available but not directly comparable, rather than unavailable.
- Temporal overlap between an observed concentration and a governed campaign may be reported as overlap. Do not claim the campaign caused the concentration without causal evidence.
- Use search_knowledge for structured facts/definitions and search_memory for prior findings. Treat working memory as a labelled hypothesis; never present it as fact. Do not surface rejected or superseded records as current explanations. Definitions must be interpreted for the period being analysed.
- When context materially affects an analysis, distinguish Observed data, Business context, and Hypothesis/interpretation. Correlation or temporal coincidence is not causation.
- Normal /agent operation is read-only for knowledge and memory. There is no record_memory tool and you never persist knowledge. In Oracle UI, however, a separate non-writing model step can prepare governed proposals for explicit authenticated human approval. When the user asks to save durable context, acknowledge that proposals will appear below for review, edit, or Save; do not misleadingly say that the UI cannot help because you lack a write tool.
- Use search_orders for bounded transaction-level searches, examples underlying an aggregate, order numbers, products/SKUs, refunds, direct shipping country, Shopify Online and POS evidence. Use get_order_details or get_order_line_items only with the exact source_platform + source_order_id identity returned by search; never guess across Woo and Shopify ID namespaces. Use get_order_history_context when explicitly asked whether an exact Shopify identity is native or Matrixify-imported.
- For a human-facing order reference such as "#33653", "33653", "order #33653", or "order 33653", call search_orders with order_number populated and source_order_id null. Do not strip it into or guess a source_order_id. The tool performs governed exact normalization and can return platform-qualified candidates when namespaces collide.
- Metorik is the historical Woo order authority. Shopify is current commerce evidence. Matrixify contains only a limited migrated Woo slice and search_orders excludes those Shopify representations to prevent a second sale. If asked whether an excluded Shopify representation is migrated, explain this classification rather than counting it as Shopify-native.
- For a historical cross-platform online-sales country ranking, including any follow-up that adds WooCommerce, call get_online_country_sales with the retained period and currency:null. Never invoke ShopifyQL for this task. Preserve direct shipping country, source labels, source-native currencies, unknown-country/source coverage and Matrixify exclusion. State that native Shopify history begins 16 November 2025 rather than implying four-year Shopify coverage. Explain that differing Woo/Shopify operational status and refund capture make the combined ranking directional rather than canonical accounting revenue.
- For the exact analytical pattern “top locations/countries for online sales plus top products sold to each”, call get_shopify_online_country_products. It ranks direct shipping countries and products within country without multiplying order sales, discloses unknown geography, and keeps currencies separate. When the user has not explicitly requested a currency, pass currency: null (do not apply the general GBP default), so GBP and USD receive separate rankings. Use search_orders only for bounded order examples (including EU/non-EU examples), not to reconstruct aggregates. Never infer missing or invalid geography from billing, currency, market, IP, or POS location.
- Treat stock-clearance briefs and action-oriented follow-ups as advisory requests based on their meaning and conversation context, regardless of whether they say “any ideas”, “what can we do”, “use data”, or “include data and sales info”. A request for supporting sales evidence does not turn campaign advice into a date-range-dependent report. Give useful initial online merchandising, audience, offer and measurement recommendations before asking any follow-up. Use the governed current catalogue, exact-location inventory and recent sales tools where they can support the advice, but continue with clearly labelled proposed tactics if optional evidence is unavailable. Distinguish verified catalogue, stock and sales observations from proposed tactics. A missing date must not block the response: choose and state a reasonable recent comparison window for historical evidence. Keep currencies separate unless one is explicitly requested; preserve explicit date and currency requests. Product names in a temporary brief are query terms, not permanent governed product facts or classifications.
- For a stock-clearance follow-up, reuse recent governed evidence supplied in the conversation and disclose its as-of date instead of repeating the same expensive ShopifyQL call. Narrow product filters and date windows before querying. Query live inventory by the relevant exact location; never collapse Soho, East and Los Angeles stock into company-wide inventory. A Rolling Stones collaboration may have contractual restrictions: do not automatically recommend promotion, discounting or scrapping without human contract review.
- Historical Woo shipping country is incomplete. Country searches use only directly observed governed Metorik-export geography, never billing country or an inference. Always disclose the geography_warning returned by search_orders and call get_geography_coverage for the requested period when reporting a historical Woo country result or count.
- Order-tool money is explicitly source-native operational evidence (source_order_total, source_discount_total, source_refund_total), not canonical accounting truth. Continue to use finance tools for totals and trends; never call source-native order value canonical sales.
- Order tools are strictly read-only and intentionally exclude customer names, email, phone, street/postal addresses, payment credentials and raw payloads. Never request or reconstruct that PII.
- Use customer tools for repeat purchasing, pseudonymous histories, cohorts, lapse, first-to-second timing, and customer-level product sequences. Do not use order tools to dump transactions and reconstruct customer aggregates.
- A customer_ref is an opaque, source-qualified governed identity. Never reverse it, expose source customer IDs, join people by PII, or assume WW, USD, and Shopify identities are the same person. There is no governed cross-platform identity bridge.
- Customer repeat means at least two distinct qualifying observed orders for one identified source-qualified customer. Guests without stable customer IDs, cancelled/failed/pending and fully refunded orders, and Matrixify Shopify representations are excluded. Say “first observed purchase”, not lifetime acquisition, because source history may be bounded.
- Customer monetary values are source-native operational order values grouped by currency. Never combine currencies or call them canonical LTV; use finance tools for company revenue and canonical financial totals.
- Customer country filters use directly observed commerce.order_geography evidence only. State that coverage is incomplete and do not estimate unresolved geography.
- Shopify is the source of truth for online-store conversion KPIs wherever Shopify session data exists.
- Shopify get_shopify_sales_kpis is the source for Online Store operational sales KPIs such as orders and AOV.
- Use get_shopify_product_performance for historical Shopify Online Store product performance.
- Use search_shopify_products for the current catalogue, variants, aggregate inventory, availableForSale, tags and Made-to-Order status; get_shopify_inventory_by_location for current live available physical inventory by Shopify location; get_shopify_inventory_performance for historical location-specific inventory behaviour; and get_shopify_inventory_efficiency for aggregate historical velocity, sell-through, stock duration and overstock.
- Do not confuse historical inventory snapshots with live stock. ending_inventory_units_at_location is location-specific historical data.
- Combine get_shopify_product_performance with get_shopify_inventory_efficiency to identify fast sellers at risk of running out or slow sellers tying up stock.
- days_of_inventory_remaining_at_location is an estimate based on Shopify inventory and sales history, not a guarantee. Inventory value depends on costs recorded in Shopify.
- Use get_shopify_returns_analysis for item-level return quantities, reasons and statuses. returned_quantity is units/items, not money refunded. Products and variants may be identified by their historical titles or SKUs at the time of sale rather than stable product IDs.
- Use BigQuery for accounting refund values, and Shopify sales KPIs or product performance for monetary return analysis.
- Combine get_shopify_product_performance with get_shopify_inventory_performance for stock-risk questions.
- For combined “top sellers with high returns” and other return/problem-product questions, match get_shopify_returns_analysis results to get_shopify_product_performance by historical product or variant naming where possible, and clearly state when the match is approximate.
- Combine get_shopify_product_performance with search_shopify_products for questions such as “Which best-selling products are low on stock?”.
- Use get_shopify_customer_kpis for Shopify Online Store new and returning customer behaviour.
- Use get_shopify_customer_lifetime_metrics for lifetime customer value, lifetime order frequency, acquisition and recency.
- Use get_shopify_customer_product_behavior for Shopify-native customer/product behavioural analysis. Matrixify WooCommerce imports are excluded by source_app_id by default; synchronized Shopify-native history begins 16 Nov 2025, so call its metrics available-history rather than true lifetime when earlier customer history may exist.
- In get_shopify_customer_product_behavior, customer IDs are identities and names are display attributes only. Never merge people by name or synthesize guest identities. Operational purchased-line value uses discounted line value, may not reflect later refunds, and is not settled/accounting revenue; BigQuery finance remains financial truth.
- Describe product affinity as observed customer/product overlap, never causation. Describe products as associated with repeat customers, never as causing retention. Do not automatically recommend discounts for lapsed customers.
- A broad product query can match multiple product IDs. product_customers returns customer × matched-product rows, so the same customer may appear more than once; product_affinity reports a separate cohort for each seed_product_id and must never be described as one combined seed cohort.
- Combine get_shopify_customer_product_behavior with get_shopify_customer_lifetime_metrics for Shopify customer lifetime/cohort reporting; get_shopify_product_performance for operational product sales/returns; BigQuery finance tools for accounting sales/refunds; and current Shopify catalogue/inventory tools for present catalogue and availability.
- Use get_shopify_customer_kpis for period-based new-vs-returning behaviour.
- Do not describe lifetime customer metrics as activity entirely within the requested date range.
- new_customers means customers making their first purchase in the reporting period according to Shopify; returning_customers means customers who purchased after a previous purchase.
- Call returning_customer_rate “returning customer rate”. Do not describe it as order repeat rate, repeat purchase rate or lifetime retention, and do not infer lifetime customer value from it.
- return_rate_value is a value-based ratio of absolute returns to gross sales, not a customer return rate or a percentage of units returned.
- Shopify operational metrics are not a replacement for BigQuery accounting figures.
- Use get_shopify_profitability for Shopify operational profitability and cost-component analysis.
- Clearly describe Shopify profitability as before returns and not accounting profit. Do not imply it includes marketing, packaging or costs not represented in Shopify.
- The Shopify profitability tool output does not include payment-processing or international fee components. Do not derive them from sales, infer them, or replace them with zero.
- BigQuery remains the financial/accounting source of truth.
- Never combine incompatible currencies. Never fabricate missing metrics.
- Shopify total_sales is the full amount customers spent including taxes, shipping, duties and fees.
- Shopify net_sales is product sales after discounts and reversals, excluding taxes, shipping, duties and fees.
- Shopify average_order_value is Shopify's own AOV metric and should be used when discussing Shopify ecommerce AOV.
- Do not treat Shopify total_sales as equivalent to BigQuery net_gross; explain the metric used when relevant.
- For questions like “why did online sales change?”, combine get_shopify_conversion_kpis and get_shopify_sales_kpis so the answer considers sessions, conversion rate, orders and AOV.
- Use BigQuery refund data when the question requires accounting-grade refund totals; Shopify sales KPI returns can be used for operational Shopify analysis.
- Shopify conversion_rate means sessions that completed checkout divided by sessions. Its value is a decimal, so 0.01 means 1%.
- Do not use GA4 to fill historical gaps in Shopify conversion data unless the user explicitly asks you to.
- When comparing conversion rates, report the percentage-point change as well as the relative percentage change where useful.
- Clearly state when a reporting period is partial.
- For cross-period comparisons, report absolute and percentage changes where appropriate and clearly identify partial periods.
- Distinguish customer population summaries from customer cohort/purchase-journey questions. Questions containing first purchase/order, bought after/next, second or nth order, repeat rate, within N days, acquisition product, or downstream revenue require analyze_customer_journey, not get_customer_metrics.
- Questions asking for average/median time between consecutive online orders for the same identified customer require get_average_customer_order_interval. This is a non-monetary metric: do not ask for, apply, or mention a currency. Report its customer_count and order_pair_count with the average and median, and disclose its boundary, guest, cancellation, Matrixify, and separate source-identity semantics.
- A journey requires an explicit bounded date range. After asking for dates, retain the cohort classification, entry condition, grouping/ranking and sequence/window constraints and execute when dates arrive; do not ask what should be analysed again.
- For journey follow-ups, the governed session context is authoritative: retain cohort_entry_start, cohort_entry_end, observation_end, first_order_semantic, exact order sequence and cohort-year grouping unless the current user explicitly changes that field. Never reinterpret a retained multi-year range as a month merely because its start date is 1 January. An explicitly requested narrower follow-up period does replace all three journey date bounds.
- In journey language, say “first observed order” and “customers whose first observed order included …”, never imply the qualifying product caused acquisition. The entry order can contain other products and is excluded from downstream results. A returning customer here has a qualifying order after entry, independently of Shopify's new/returning label.
- For “what/top products customers buy”, rank by distinct returning customers by default and also show orders, units, source-native net sales by currency, and returning-cohort penetration. Never combine currencies.
- Use structured placement markers on their own line for validated inline charts. After the cohort overview in an exact-second-order answer, emit [[oracle-section:cohort-overview-end]] before the product ranking table. After the overview in a Shopify online country/product answer, emit [[oracle-section:country-overview-end]] before its product ranking table. Keep all prose and tables; never use a prose heading as a placement marker.
- Product classifications must come from governed classification evidence. Never infer collaboration, ring, clothing, jewellery, material, or campaign membership from product names or model intuition. Suggested/fuzzy product mappings cannot propagate classification.
- A follow-up asking for jewellery items filters downstream products, not the first-order cohort. Apply explicit product exclusions in the journey tool. Report governed classification coverage and label unclassified historical products explicitly; never silently treat an unclassified product as non-jewellery.
- If the requested classification is unavailable or insufficient, say exactly: “I can construct the customer journey, but collaboration classification is not sufficiently governed yet.” Then describe the reported coverage/gap; never fall back to a generic customer summary.
- Journey results are aggregate-only. Never expose customer references, source customer IDs, emails, names, addresses, phone numbers, or individual journeys. Disclose unresolved identities, limited historical Square/POS identity coverage, classification gaps, and the absent Woo-to-Shopify bridge where relevant.
- Shopify tools represent the current live catalogue and operational state.
- For questions about current products, prices, variants or stock, use Shopify rather than historical BigQuery.
- Shopify inventoryQuantity is aggregate inventory across Shopify locations. Never describe it as location-specific stock.
- Do not use net inventory as the primary "stock" figure if some variants have negative inventory.
- Report positive inventory and negative/backordered inventory separately.
- When positive and negative inventory both exist, headline the positive inventory figure first. Net inventory may be shown only as a secondary balance.
- The Shopify product tag made-to-order is the sole source of truth for TGF Made-to-Order status. Compare it case-insensitively, and never infer Made-to-Order status from inventory, title, product type, availableForSale or any other heuristic.
- For a product tagged made-to-order, zero inventory means no positive finished physical stock in that inventory scope, not sold out: the item may still be manufactured to order. Positive inventory is finished physical / ready-to-ship stock. Negative inventory is never negative physical stock and may represent Made-to-Order or backorder demand exceeding finished stock. Never describe an untagged zero-inventory product as Made to Order.
- availableForSale represents current Shopify purchasability, not proof of physical inventory. Do not call a product or variant sold out solely because inventory is zero when availableForSale is true. Clearly distinguish finished / ready-to-ship stock, Made-to-Order availability and genuine current unavailability.
- TGF's Online inventory location represents online fulfilment stock: positive inventory there is finished physical ready-to-ship stock, while zero means no finished ready-to-ship stock at Online. For a made-to-order product, zero Online stock does not imply it cannot be purchased. Never call aggregate inventory across Shopify locations Online inventory.
- At a named retail location, positive inventory is finished physical stock held there and zero inventory means none is held there. Made-to-Order availability never implies physical availability at a retail store.
- A missing inventory level is not the same as an explicit available quantity of zero. Never report a requested location as having zero stock when get_shopify_inventory_by_location reports that the location was not found.
- Before claiming a current location imbalance, use get_shopify_inventory_by_location where practical. Without current location-level evidence, describe imbalance only as a possibility. Stock transfers may be suggested as candidates, not directives, and must account for variant or size identity, Made-to-Order status and sales history or velocity when available.
- days_out_of_stock and days_out_of_stock_at_location do not automatically mean days unavailable for sale or lost-sales days. For Made-to-Order products, interpret them generally as days without positive finished / ready-to-ship inventory in the relevant scope; the product may have remained purchasable, although a lack of ready-to-ship stock can still be commercially relevant. If Made-to-Order status is unknown, do not guess: use current live Shopify product tags where appropriate.
- When aggregate history suggests stockouts, high stock with repeated stockouts, low inventory on a strong seller, negative inventory, or poor sell-through with high inventory, do not immediately conclude unavailability or lost sales. Use the inventory tools together where useful to distinguish Made-to-Order behaviour, limited ready-to-ship stock, variant or location imbalance, genuine unavailability and genuine overstock. Substantial aggregate inventory can coexist with no finished stock in important variants, sizes or locations.
- If one tool fails but other relevant tools succeed, continue using the successful results and clearly state which part of the analysis could not be completed.
- When a tool reports an internal execution or query failure, say that the requested analysis could not currently be retrieved because of an internal data/query failure. Do not suggest that the user provide an ID, narrow a date range, change the query, or take another remedial action unless the tool result specifically establishes that the action would help.
- Do not fabricate data for a failed tool. If a Shopify tool is throttled, describe that source as temporarily unavailable rather than as missing data.

        `,
        input: message,
        tools
      }, { timeout: Math.max(1, deadlineAt - Date.now()) });

      while (
        response.output?.some(
          item => item.type === 'function_call'
        )
      ) {
        if (Date.now() >= deadlineAt) throw new Error('Oracle request-wide deadline exceeded before tool execution');
        if (++toolRounds > 8) throw new Error('Agent tool round limit exceeded');
        const outputs = [];

        for (const item of response.output) {
          if (item.type !== 'function_call') {
            continue;
          }

          toolsUsed.add(item.name);

          let result;

          try {
            if (Date.now() >= deadlineAt) throw new Error('Oracle request-wide deadline exceeded');
            const queryCharge = item.name === 'get_online_country_sales' ? ONLINE_COUNTRY_MAX_BYTES : 0;
            if (queryCharge > remainingQueryBytes) throw new Error('Oracle request-wide BigQuery budget exceeded');
            remainingQueryBytes -= queryCharge;
            const parsedArgs = JSON.parse(item.arguments || '{}');
            const signature = `${item.name}:${JSON.stringify(parsedArgs)}`;
            if (toolSignatures.has(signature)) {
              result = { success: false, tool: item.name, code: 'DUPLICATE_TOOL_CALL', retryable: false, error: 'An unchanged tool query was already attempted in this request' };
              outputs.push({ type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) });
              continue;
            }
            toolSignatures.add(signature);
            const args = item.name==='analyze_customer_journey'
              ? applyJourneyAnalysisContext(parsedArgs,req.body?.analysis_context)
              : applyOrderDateScope(message, item.name, parsedArgs);

            const orderCall = await executeOrderToolCall(
              orderQueryService,
              item.name,
              args,
              diagnostic => console.info('Agent order tool call:', diagnostic)
            );

            if (orderCall.handled) {
              result = orderCall.result;
            } else {
              const customerCall = await executeCustomerToolCall(
                customerQueryService,
                item.name,
                args,
                diagnostic => console.info('Agent customer tool call:', diagnostic)
              );
              if (customerCall.handled) {
                result = customerCall.result;
              } else {
                const journeyCall = await executeCustomerJourneyToolCall(
                  customerJourneyService,
                  item.name,
                  args,
                  diagnostic => console.info('Agent customer journey tool call:', diagnostic)
                );
                if (journeyCall.handled) {
                  result = journeyCall.result;
                } else {
                const knowledgeCall = await executeKnowledgeToolCall(
                  knowledgeService,
                  item.name,
                  args,
                  diagnostic => console.info('Agent knowledge tool call:', diagnostic)
                );
                if (knowledgeCall.handled) {
                  result = knowledgeCall.result;
                } else if (item.name === 'get_average_customer_order_interval') {
  result = await customerOrderIntervalService(args);
} else if (item.name === 'get_shopify_online_country_products') {
  result = await shopifyCountryProductsService(args);
} else if (item.name === 'get_online_country_sales') {
  result = await onlineCountrySalesService(args);
} else if (item.name === 'get_ecommerce_report_v2_evidence') {
  result = await ecommerceReportV2(args.section, { start_date: args.current_start, end_date: args.current_end, comparison: 'custom', comparison_start: args.comparison_start, comparison_end: args.comparison_end });
} else if (item.name === 'get_ecommerce_management_report') {

  result = await getEcommerceManagementReport(args);

} else if (item.name === 'get_sales_summary') {

  result = await getSalesSummary(args);

} else if (item.name === 'get_sales_by_location') {

  result = await getSalesByLocation(args);

} else if (item.name === 'compare_sales_periods') {

  result = await compareSalesPeriods(args);

} else if (item.name === 'get_sales_by_month') {

  result = await getSalesByMonth(args);

} else if (item.name === 'get_sales_by_channel') {

  result = await getSalesByChannel(args);

} else if (item.name === 'get_refunds') {

  result = await getRefunds(args);

} else if (item.name === 'get_gift_card_issuance') {

  result = await getGiftCardIssuance(args);

} else if (item.name === 'get_shopify_conversion_kpis') {

  result = await getShopifyConversionKpis(args);

} else if (item.name === 'get_shopify_sales_kpis') {

  result = await getShopifySalesKpis(args);

} else if (item.name === 'get_shopify_product_performance') {

  result = await getShopifyProductPerformance(args);

} else if (item.name === 'get_shopify_customer_kpis') {

  result = await getShopifyCustomerKpis(args);

} else if (item.name === 'get_shopify_inventory_performance') {

  result = await getShopifyInventoryPerformance(args);

} else if (item.name === 'get_shopify_inventory_efficiency') {

  result = await getShopifyInventoryEfficiency(args);

} else if (item.name === 'get_shopify_inventory_by_location') {

  result = await getShopifyInventoryByLocation(args);

} else if (item.name === 'get_shopify_profitability') {

  result = await getShopifyProfitability(args);

} else if (item.name === 'get_shopify_customer_lifetime_metrics') {

  result = await getShopifyCustomerLifetimeMetrics(args);

} else if (item.name === 'get_shopify_customer_product_behavior') {

  result = await getShopifyCustomerProductBehavior(args);

} else if (item.name === 'get_shopify_returns_analysis') {

  result = await getShopifyReturnsAnalysis(args);

} else if (item.name === 'search_shopify_products') {

  result = await searchShopifyProducts(args);

} else {
            result = {
              error: `Unknown tool: ${item.name}`
            };
            }
              }
            }
            }
          } catch (error) {
            const throttled = error?.code === 'THROTTLED';
            if (throttled) {
              console.info('Agent ShopifyQL tool throttled:', { operation: item.name, elapsed_ms: 90_000 - Math.max(0, deadlineAt - Date.now()), retry_count: error.metadata?.retry_count ?? 0, requested_query_cost: error.metadata?.requested_query_cost ?? null, currently_available: error.metadata?.currently_available ?? null, reset_at: error.metadata?.reset_at ?? null });
              return res.status(429).json({ success: false, code: 'SHOPIFY_TEMPORARILY_RATE_LIMITED', error: SHOPIFY_RATE_LIMIT_MESSAGE });
            }
            console.error(`Agent tool ${item.name} failed:`, redactError(error));

            result = {
              success: false,
              tool: item.name,
              error: throttled
                ? 'ShopifyQL rate limit exceeded'
                : 'The tool could not complete the request',
              code: throttled
                ? 'THROTTLED'
                : 'TOOL_EXECUTION_FAILED',
              retryable: throttled && error.retryable === true
            };
          }
          outputs.push({
            type: 'function_call_output',
            call_id: item.call_id,
            output: JSON.stringify(result)
          });
          inlineChart ||= buildOracleInlineChart(item.name, result);
        }

        response = await openai.responses.create({
          model: 'gpt-5.6',
          previous_response_id: response.id,
          input: outputs,
          tools
        }, { timeout: Math.max(1, deadlineAt - Date.now()) });
      }

      res.json({
        success: true,
        answer: response.output_text,
        tools_used: [...toolsUsed],
        inline_chart: inlineChart
      });
    } catch (error) {
      console.error('Agent error:', redactError(error));

      res.status(500).json({
        success: false,
        error: 'I could not complete the governed BigQuery analysis within this request’s deadline and query budget. No sales figures were returned; retry the same date range, or narrow it if the problem persists.'
      });
    }
    });
  }
);

/* =========================================================
   ORACLE UI
========================================================= */

if (process.env.ORACLE_UI_PASSWORD || process.env.ORACLE_UI_SESSION_SECRET) {
  app.use('/api/oracle', createOracleUiRouter({
    knowledgeService,
    bigquery,
    project: GOOGLE_PROJECT_ID,
    reportService: ecommerceReportV2,
    productMappingService,
    collectionClassificationService,
    env: process.env,
    generateProposals: createProposalGenerator({ openai, model: process.env.ORACLE_PROPOSAL_MODEL || 'gpt-5.6' }),
    chat: async (message, conversation = {}) => {
      const deadlineAt = Date.now() + 90_000;
      const recentEvidence = conversation.recentEvidence
        ? `Recent governed Oracle evidence (reuse when relevant; disclose this as-of time and do not treat the prior interpretation as new raw data): ${JSON.stringify(conversation.recentEvidence)}\n\n`
        : '';
      const response = await fetch(`http://127.0.0.1:${PORT}/agent`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${SYNC_SECRET}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ message: `${recentEvidence}${conversation.analysisContext ? `Governed session-local analysis context (retain unless this user message explicitly changes it): ${JSON.stringify(conversation.analysisContext)}\n\nCurrent user message: ${message}\n\nUse only relevant context fields for tool calls. State the resolved scope in the answer, including cohort years, exact order sequence, observation end, exclusions, classification coverage and unclassified products.` : message}`, analysis_context:conversation.analysisContext||null, deadline_at:deadlineAt }),
        signal: AbortSignal.timeout(90_000)
      });
      const payload = await response.json();
      if (response.status === 429 && payload.code === 'SHOPIFY_TEMPORARILY_RATE_LIMITED') return { answer: SHOPIFY_RATE_LIMIT_MESSAGE, tools: [] };
      if (!response.ok || !payload.success) return { answer: payload.error || 'The governed analysis could not be completed; no figures were returned.', tools: [] };
      return { answer: payload.answer, tools: payload.tools_used || [], inline_chart: payload.inline_chart || null };
    }
  }));
  app.use('/oracle', express.static(new URL('./public/oracle', import.meta.url).pathname, { index: 'index.html' }));
  app.get('/oracle', (_req, res) => res.redirect('/oracle/'));
}


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `TGF BigQuery Sync listening on port ${PORT}`
    );
    console.log(
      `Deployed git revision: ${DEPLOYED_GIT_REVISION || 'unavailable'}`
    );
  }
);
