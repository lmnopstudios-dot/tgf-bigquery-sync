export const SHOPIFY_CONFIG_NAMES = Object.freeze([
  'SHOPIFY_SHOP',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET'
]);

export function missingShopifyConfig(env = process.env) {
  return SHOPIFY_CONFIG_NAMES.filter(name => !env[name]);
}

export function loadShopifyConfig(env = process.env) {
  const missing = missingShopifyConfig(env);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
  return { shop: env.SHOPIFY_SHOP, clientId: env.SHOPIFY_CLIENT_ID, clientSecret: env.SHOPIFY_CLIENT_SECRET };
}

export async function getShopifyAccessToken(config, fetchImpl = fetch) {
  const response = await fetchImpl(`https://${config.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret })
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) throw new Error(`Shopify OAuth failed with HTTP ${response.status}`);
  return body.access_token;
}

export function createShopifyGraphql({ shop, token, fetchImpl = fetch, apiVersion = '2026-07' }) {
  return async (query, variables = {}) => {
    const response = await fetchImpl(`https://${shop}.myshopify.com/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables })
    });
    const body = await response.json();
    if (!response.ok || body.errors) throw new Error(`Shopify GraphQL failed with HTTP ${response.status}`);
    return body.data;
  };
}
