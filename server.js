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

  SYNC_SECRET
} = process.env;

const DATASET = 'shopify_data';
const TABLE = 'order_locations';

if (!SHOPIFY_SHOP || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
  throw new Error('Missing Shopify environment variables');
}

if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
}

const credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

const bigquery = new BigQuery({
  projectId: GOOGLE_PROJECT_ID,
  credentials
});

async function getShopifyAccessToken() {
  const response = await fetch(
    `https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
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
    console.error('Shopify auth error:', data);
    throw new Error('Could not get Shopify access token');
  }

  return data.access_token;
}

async function shopifyGraphQL(token, query, variables = {}) {
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
      JSON.stringify(data.errors || data, null, 2)
    );
  }

  return data.data;
}

async function getAllOrders() {
  const token = await getShopifyAccessToken();

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

    console.log(`Fetching Shopify page ${page}...`);

    const data = await shopifyGraphQL(
      token,
      query,
      { cursor }
    );

    const connection = data.orders;

    orders.push(...connection.nodes);

    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;

    console.log(
      `Fetched ${orders.length} orders so far`
    );
  }

  return orders;
}

async function ensureBigQueryTable() {
  const dataset = bigquery.dataset(DATASET);
  const table = dataset.table(TABLE);

  const [exists] = await table.exists();

  if (exists) {
    return;
  }

  console.log(
    `Creating ${GOOGLE_PROJECT_ID}.${DATASET}.${TABLE}`
  );

  await dataset.createTable(TABLE, {
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
  });
}

function transformOrders(orders) {
  const syncedAt = new Date().toISOString();

  return orders.map(order => ({
    order_id: order.id,
    order_name: order.name || null,

    created_at: order.createdAt || null,
    updated_at: order.updatedAt || null,

    order_source: order.app?.name || null,
    source_app_id: order.app?.id || null,

    retail_location_id:
      order.retailLocation?.id || null,

    retail_location_name:
      order.retailLocation?.name || null,

    synced_at: syncedAt
  }));
}

async function replaceBigQueryData(rows) {
  await ensureBigQueryTable();

  console.log('Clearing existing order location data...');

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

  for (let i = 0; i < rows.length; i += batchSize) {
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
  console.log('Starting Shopify order metadata sync');

  const orders = await getAllOrders();

  console.log(
    `Shopify returned ${orders.length} orders`
  );

  const rows = transformOrders(orders);

  await replaceBigQueryData(rows);

  console.log('Sync complete');

  return {
    ordersFetched: orders.length,
    rowsWritten: rows.length
  };
}

function requireSyncSecret(req, res, next) {
  if (!SYNC_SECRET) {
    return res.status(500).json({
      success: false,
      error: 'SYNC_SECRET is not configured'
    });
  }

  const auth = req.headers.authorization;

  if (auth !== `Bearer ${SYNC_SECRET}`) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized'
    });
  }

  next();
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TGF BigQuery Sync'
  });
});

app.get('/test-shopify', async (req, res) => {
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

    const orders = data.orders.nodes;

    res.json({
      success: true,
      count: orders.length,

      orders: orders.map(order => ({
        id: order.id,
        name: order.name,

        created_at:
          order.createdAt,

        source:
          order.app?.name || null,

        retail_location_id:
          order.retailLocation?.id || null,

        retail_location_name:
          order.retailLocation?.name || null
      }))
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
      console.error(error);

      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `TGF BigQuery Sync listening on port ${PORT}`
  );
});
