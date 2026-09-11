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

async function syncShopify() {
  console.log(
    'Starting Shopify order metadata sync'
  );

  const orders =
    await getAllOrders();

  console.log(
    `Shopify returned ${orders.length} orders`
  );

  const rows =
    transformOrders(orders);

  await replaceBigQueryData(
    rows
  );

  console.log(
    'Shopify sync complete'
  );

  return {
    ordersFetched:
      orders.length,

    rowsWritten:
      rows.length
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
