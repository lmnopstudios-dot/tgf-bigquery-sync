import express from 'express';
import { BigQuery } from '@google-cloud/bigquery';
import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3000;

const {
  SHOPIFY_SHOP,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,

  GOOGLE_PROJECT_ID = 'gf-full-data',
  GOOGLE_SERVICE_ACCOUNT_JSON,

  SYNC_SECRET,

  WOO_US_URL,
  WOO_US_CONSUMER_KEY,
  WOO_US_CONSUMER_SECRET,

  WOO_JP_URL,
  WOO_JP_CONSUMER_KEY,
  WOO_JP_CONSUMER_SECRET
} = process.env;

const DATASET = 'shopify_data';
const TABLE = 'order_locations';
const LINE_ITEMS_TABLE = 'order_line_items';
const FINANCIALS_TABLE = 'order_financials';
const REFUNDS_TABLE = 'order_refunds';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

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

    throw new Error(
      JSON.stringify(
        data.errors || data,
        null,
        2
      )
    );
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
  const data = await shopifyGraphQL(
    token,
    `
      query ShopifyConversionKpis($query: String!) {
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
    `,
    { query: shopifyql }
  );
  const response = data.shopifyqlQuery;

  if (response.parseErrors?.length) {
    const details = response.parseErrors.join('; ');

    throw new Error(
      `ShopifyQL could not run the conversion KPI report: ${details}`
    );
  }

  if (!response.tableData) {
    throw new Error(
      'ShopifyQL returned an unexpected response without table data'
    );
  }

  const { columns = [], rows: tableRows = [] } =
    response.tableData;
  const rows = tableRows.map(row => {
    const values = Array.isArray(row)
      ? row
      : columns.map(column => row?.[column.name]);
    const metrics = {};

    columns.forEach((column, index) => {
      const value = values[index];

      if (value !== undefined) {
        metrics[column.name] = parseShopifyqlValue(
          value,
          column.dataType
        );
      }
    });

    return addCalculatedConversionRates(metrics);
  });

  return {
    start_date,
    end_date,
    timeseries,
    ...(timeseries === 'none'
      ? { metrics: rows[0] ?? null }
      : { periods: rows })
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
      variants:
        product.variants.nodes
    })
  );
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

          app {
            id
            name
          }

          retailLocation {
            id
            name
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

  const lineItemRows =
    transformLineItems(orders);

  const financialRows =
    transformFinancials(financialOrders);

  const refundRows =
    transformRefunds(financialOrders);

  console.log(
    `Extracted ${lineItemRows.length} Shopify line items`
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

  await replaceFinancialsData(
    financialRows
  );

  await replaceRefundsData(
    refundRows
  );

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

    financialRowsWritten:
      financialRows.length,

    refundsWritten:
      refundRows.length
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
  const filters = [
    'date >= @start_date',
    'date <= @end_date',
    'currency = @currency',
    "transaction_type = 'refund'"
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
        COUNT(*) AS refund_count,
        SUM(gross) AS refunds_gross,
        ABS(SUM(gross)) AS refunded_amount,
        SUM(tax) AS refunded_tax,
        SUM(net_ex_tax) AS refunded_net_ex_tax

      FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_transactions\`

      WHERE ${filters.join('\nAND ')}

      GROUP BY ${groupAlias}
      ORDER BY refunded_amount DESC
    `
    : `
      SELECT
        COUNT(*) AS refund_count,
        SUM(gross) AS refunds_gross,
        ABS(SUM(gross)) AS refunded_amount,
        SUM(tax) AS refunded_tax,
        SUM(net_ex_tax) AS refunded_net_ex_tax

      FROM \`${GOOGLE_PROJECT_ID}.finance.accountant_transactions\`

      WHERE ${filters.join('\nAND ')}
    `;

  const [rows] = await bigquery.query({
    query,
    params
  });

  return groupExpression ? rows : (rows[0] || {});
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
        'TGF BigQuery Sync'
    });
  }
);

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
    try {
      const message = req.body?.message;

      if (!message) {
        return res.status(400).json({
          success: false,
          error: 'message is required'
        });
      }

      const tools = [
        {
          type: 'function',
          name: 'get_sales_summary',
          description:
            'Get TGF sales totals for a date range, optionally filtered by location, channel or source.',
          parameters: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format'
              },
              end_date: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              },
              location: {
                type: ['string', 'null']
              },
              channel: {
                type: ['string', 'null']
              },
              source: {
                type: ['string', 'null']
              }
            },
            required: ['start_date', 'end_date']
          }
        },
        {
          type: 'function',
          name: 'get_sales_by_location',
          description:
            'Get TGF sales totals grouped by retail location for a date range.',
          parameters: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string'
              },
              end_date: {
                type: 'string'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              }
            },
            required: ['start_date', 'end_date']
          }
        },
        {
          type: 'function',
          name: 'compare_sales_periods',
          description:
            'Compare TGF sales performance between two date periods.',
          parameters: {
            type: 'object',
            properties: {
              period_1_start: {
                type: 'string'
              },
              period_1_end: {
                type: 'string'
              },
              period_2_start: {
                type: 'string'
              },
              period_2_end: {
                type: 'string'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              },
              location: {
                type: ['string', 'null']
              },
              channel: {
                type: ['string', 'null']
              },
              source: {
                type: ['string', 'null']
              }
            },
            required: [
              'period_1_start',
              'period_1_end',
              'period_2_start',
              'period_2_end'
            ]
          }
        },
        {
          type: 'function',
          name: 'get_sales_by_month',
          description:
            'Get TGF sales grouped by month for trend analysis over a date range.',
          parameters: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format'
              },
              end_date: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              },
              location: {
                type: ['string', 'null']
              },
              channel: {
                type: ['string', 'null']
              },
              source: {
                type: ['string', 'null']
              }
            },
            required: [
              'start_date',
              'end_date'
            ]
          }
        },
        {
  type: 'function',
  name: 'get_sales_by_channel',
  description:
    'Get TGF sales grouped by sales channel for a date range, such as Online or Retail.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      currency: {
        type: 'string',
        enum: ['GBP', 'USD', 'JPY']
      },
      location: {
        type: ['string', 'null']
      },
      source: {
        type: ['string', 'null']
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_refunds',
  description:
    'Analyse TGF refunds for a date range. Can return an overall summary or group refunds by month, location, channel or source.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string'
      },
      end_date: {
        type: 'string'
      },
      currency: {
        type: 'string',
        enum: ['GBP', 'USD', 'JPY']
      },
      location: {
        type: ['string', 'null']
      },
      channel: {
        type: ['string', 'null']
      },
      source: {
        type: ['string', 'null']
      },
      group_by: {
        type: 'string',
        enum: [
          'summary',
          'month',
          'location',
          'channel',
          'source'
        ]
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_gift_card_issuance',
  description:
    'Get identified TGF gift card issuance. Can return an overall total or group by month, location, channel or source. Historical WooCommerce gift card identification is incomplete, so results primarily cover identified Shopify and Square issuance.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string'
      },
      end_date: {
        type: 'string'
      },
      currency: {
        type: 'string',
        enum: ['GBP', 'USD', 'JPY']
      },
      location: {
        type: ['string', 'null']
      },
      channel: {
        type: ['string', 'null']
      },
      source: {
        type: ['string', 'null']
      },
      group_by: {
        type: 'string',
        enum: [
          'summary',
          'month',
          'location',
          'channel',
          'source'
        ]
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_conversion_kpis',
  description:
    'Get Shopify online-store conversion KPIs for human sessions over an explicit date range, optionally as a daily, weekly or monthly timeseries.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      timeseries: {
        type: 'string',
        enum: ['none', 'day', 'week', 'month'],
        default: 'none',
        description:
          'Return one total or metrics grouped by this period.'
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'search_shopify_products',
  description:
    'Search the current live Shopify product catalogue, including variants, prices and aggregate inventory across Shopify locations.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'A Shopify product search query.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        default: 10,
        description:
          'Maximum number of products to return.'
      }
    },
    required: ['query']
  }
}
      ];

      let response = await openai.responses.create({
        model: 'gpt-5.6',
        instructions: `
You are The Great Frog ecommerce data analyst.

You answer questions using the supplied tools.

Important rules:
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
- Shopify is the source of truth for online-store conversion KPIs wherever Shopify session data exists.
- Shopify conversion_rate means sessions that completed checkout divided by sessions. Its value is a decimal, so 0.01 means 1%.
- Do not use GA4 to fill historical gaps in Shopify conversion data unless the user explicitly asks you to.
- When comparing conversion rates, report the percentage-point change as well as the relative percentage change where useful.
- Clearly state when a reporting period is partial.
- Shopify tools represent the current live catalogue and operational state.
- For questions about current products, prices, variants or stock, use Shopify rather than historical BigQuery.
- Shopify inventoryQuantity is aggregate inventory across Shopify locations. Never describe it as location-specific stock.
- Do not use net inventory as the primary "stock" figure if some variants have negative inventory.
- Report positive inventory and negative/backordered inventory separately.
- Treat availableForSale as purchasability, not proof of physical stock.
- When positive and negative inventory both exist, headline the positive inventory figure first. Net inventory may be shown only as a secondary balance.

        `,
        input: message,
        tools
      });

      while (
        response.output?.some(
          item => item.type === 'function_call'
        )
      ) {
        const outputs = [];

        for (const item of response.output) {
          if (item.type !== 'function_call') {
            continue;
          }

          const args = JSON.parse(item.arguments || '{}');

          let result;

          if (item.name === 'get_sales_summary') {

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

} else if (item.name === 'search_shopify_products') {

  result = await searchShopifyProducts(args);

} else {
            result = {
              error: `Unknown tool: ${item.name}`
            };
          }

          outputs.push({
            type: 'function_call_output',
            call_id: item.call_id,
            output: JSON.stringify(result)
          });
        }

        response = await openai.responses.create({
          model: 'gpt-5.6',
          previous_response_id: response.id,
          input: outputs,
          tools
        });
      }

      res.json({
        success: true,
        answer: response.output_text
      });
    } catch (error) {
      console.error('Agent error:', error);

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {
    console.log(
      `TGF BigQuery Sync listening on port ${PORT}`
    );
  }
);
