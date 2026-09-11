import express from 'express';
import { BigQuery } from '@google-cloud/bigquery';

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

  const data = await response.json();

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

  const data = await response.json();

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

async function syncShopify() {
  console.log(
    'Starting Shopify order metadata + line item sync'
  );

  const orders =
    await getAllOrders();

  console.log(
    `Shopify returned ${orders.length} orders`
  );

  const orderRows =
    transformOrders(orders);

  const lineItemRows =
    transformLineItems(orders);

  console.log(
    `Extracted ${lineItemRows.length} Shopify line items`
  );

  await replaceBigQueryData(
    orderRows
  );

  await replaceLineItemsData(
    lineItemRows
  );

  console.log(
    'Shopify sync complete'
  );

  return {
    ordersFetched:
      orders.length,

    orderRowsWritten:
      orderRows.length,

    lineItemsWritten:
      lineItemRows.length
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
   ROUTES
========================================================= */

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
