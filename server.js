import express from 'express';

const app = express();

const PORT = process.env.PORT || 3000;

const {
  SHOPIFY_SHOP,
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET
} = process.env;

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
    console.error(data);
    throw new Error('Failed to get Shopify access token');
  }

  return data.access_token;
}

async function getLatestOrders() {
  const token = await getShopifyAccessToken();

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

  const response = await fetch(
    `https://${SHOPIFY_SHOP}.myshopify.com/admin/api/2026-07/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: JSON.stringify({ query })
    }
  );

  const data = await response.json();

  if (!response.ok || data.errors) {
    console.error('Shopify GraphQL error:', JSON.stringify(data, null, 2));
  
    throw new Error(
      JSON.stringify(data.errors || data, null, 2)
    );
  }

  return data.data.orders.nodes;
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'TGF BigQuery Sync'
  });
});

app.get('/test-shopify', async (req, res) => {
  try {
    const orders = await getLatestOrders();

    res.json({
      success: true,
      count: orders.length,
      orders: orders.map(order => ({
        id: order.id,
        name: order.name,
        created_at: order.createdAt,
        source: order.app?.name || null,
        retail_location_id: order.retailLocation?.id || null,
        retail_location_name: order.retailLocation?.name || null
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

app.listen(PORT, () => {
  console.log(`TGF BigQuery Sync listening on port ${PORT}`);
});
