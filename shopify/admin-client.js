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

export async function getShopifyAccessToken(config, fetchImpl = fetch, signal = undefined) {
  const response = await fetchImpl(`https://${config.shop}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret }),signal
  });
  let body;try{body=await response.json();}catch{throw Object.assign(new Error('Shopify authentication response unavailable'),{code:'SHOPIFY_AUTH_INVALID_RESPONSE',http_status:response.status});}
  if (!response.ok || !body.access_token) throw Object.assign(new Error('Shopify authentication failed'),{code:'SHOPIFY_AUTH_FAILED',http_status:response.status});
  return body.access_token;
}

export function createShopifyGraphql({ shop, token, fetchImpl = fetch, apiVersion = '2026-07' }) {
  return async (query, variables = {}, signal = undefined) => {
    const response = await fetchImpl(`https://${shop}.myshopify.com/admin/api/${apiVersion}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
      body: JSON.stringify({ query, variables }),signal
    });
    let body;try{body=await response.json();}catch{throw Object.assign(new Error('Shopify response unavailable'),{code:'SHOPIFY_INVALID_RESPONSE',http_status:response.status});}
    if (!response.ok || body.errors) throw Object.assign(new Error('Shopify GraphQL request failed'),{code:body.errors?.[0]?.extensions?.code||(response.status===401?'SHOPIFY_AUTH_FAILED':response.status===403?'SHOPIFY_PERMISSION_DENIED':response.status===429?'THROTTLED':'SHOPIFY_HTTP_FAILED'),http_status:response.status,cost:body.extensions?.cost,errors:(body.errors||[]).slice(0,5).map(e=>({extensions:{code:e.extensions?.code,cost:e.extensions?.cost}}))});
    if(body.data&&typeof body.data==='object')Object.defineProperty(body.data,'shopify_metadata',{value:{http_status:response.status,cost:body.extensions?.cost},enumerable:false});
    return body.data;
  };
}
