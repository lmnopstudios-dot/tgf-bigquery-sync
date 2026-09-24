import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';

export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';
export const TABLE = 'order_shipping_geography';
export const PROVENANCE = 'shopify_admin_graphql.order.shippingAddress.countryCodeV2';

// ISO 3166-1 alpha-2 codes. This is deliberately validation, not an EU list.
const ISO2 = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

export const GEOGRAPHY_QUERY = `
  query OrderShippingGeography($cursor: String, $query: String) {
    orders(first: 250, after: $cursor, sortKey: UPDATED_AT, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt updatedAt
        app { id }
        retailLocation { id }
        shippingAddress { countryCodeV2 country }
      }
    }
  }
`;

export function normalizeShippingGeography(order, syncedAt = new Date().toISOString()) {
  const address = order.shippingAddress;
  const raw = address?.countryCodeV2 == null ? null : String(address.countryCodeV2);
  const normalized = raw?.trim().toUpperCase() || null;
  const valid = normalized !== null && ISO2.has(normalized);
  const status = !address ? 'missing_address' : !normalized ? 'missing_code' : valid ? 'valid' : 'invalid_code';
  return {
    order_id: order.id,
    order_name: order.name || null,
    order_created_at: order.createdAt || null,
    order_updated_at: order.updatedAt || null,
    source_app_id: order.app?.id || null,
    retail_location_id: order.retailLocation?.id || null,
    shipping_country_code: valid ? normalized : null,
    shipping_country_code_source: raw,
    shipping_country_name: valid && address.country?.trim() ? address.country.trim() : null,
    geography_status: status,
    geography_provenance: status === 'missing_address' ? 'shopify_admin_graphql.order.shippingAddress_absent' : PROVENANCE,
    synced_at: syncedAt
  };
}

export async function fetchShippingGeography({ graphql, updatedSince = null }) {
  let cursor = null;
  const orders = [];
  do {
    const data = await graphql(GEOGRAPHY_QUERY, { cursor, query: updatedSince ? `updated_at:>=${updatedSince}` : null });
    orders.push(...data.orders.nodes);
    cursor = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (cursor);
  return orders.filter(order => order.app?.id !== MATRIXIFY_APP_ID).map(order => normalizeShippingGeography(order));
}

export async function ensureGeographyTable(bigquery, project) {
  await bigquery.query({ query: `CREATE TABLE IF NOT EXISTS \`${project}.shopify_data.${TABLE}\` (
    order_id STRING NOT NULL, order_name STRING, order_created_at TIMESTAMP, order_updated_at TIMESTAMP,
    source_app_id STRING, retail_location_id STRING, shipping_country_code STRING,
    shipping_country_code_source STRING, shipping_country_name STRING, geography_status STRING NOT NULL,
    geography_provenance STRING NOT NULL, synced_at TIMESTAMP NOT NULL
  ) CLUSTER BY order_id` });
}

export async function persistShippingGeography({ bigquery, project, rows, mode = 'incremental' }) {
  await ensureGeographyTable(bigquery, project);
  if (!['backfill', 'incremental'].includes(mode)) throw new Error('mode must be backfill or incremental');
  if (!rows.length) return { rows_written: 0, mode };
  const stage = `${TABLE}_stage_${Date.now()}`;
  const dataset = bigquery.dataset('shopify_data');
  await dataset.createTable(stage, { schema: [
    ['order_id','STRING'],['order_name','STRING'],['order_created_at','TIMESTAMP'],['order_updated_at','TIMESTAMP'],
    ['source_app_id','STRING'],['retail_location_id','STRING'],['shipping_country_code','STRING'],
    ['shipping_country_code_source','STRING'],['shipping_country_name','STRING'],['geography_status','STRING'],
    ['geography_provenance','STRING'],['synced_at','TIMESTAMP']
  ].map(([name,type]) => ({ name, type })) });
  try {
    await dataset.table(stage).insert(rows);
    const columns = Object.keys(rows[0]);
    const update = columns.filter(c => c !== 'order_id').map(c => `T.${c}=S.${c}`).join(',');
    const merge = `MERGE \`${project}.shopify_data.${TABLE}\` T USING \`${project}.shopify_data.${stage}\` S ON T.order_id=S.order_id
      WHEN MATCHED THEN UPDATE SET ${update}
      WHEN NOT MATCHED THEN INSERT (${columns.join(',')}) VALUES (${columns.map(c => `S.${c}`).join(',')})`;
    await bigquery.query({ query: mode === 'backfill' ? `BEGIN TRANSACTION; TRUNCATE TABLE \`${project}.shopify_data.${TABLE}\`; ${merge}; COMMIT TRANSACTION;` : merge });
  } finally { await dataset.table(stage).delete({ ignoreNotFound: true }); }
  return { rows_written: rows.length, mode };
}

async function main() {
  const mode = process.argv.includes('--backfill') ? 'backfill' : 'incremental';
  const project = process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!credentials) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const shop = process.env.SHOPIFY_SHOP, clientId = process.env.SHOPIFY_CLIENT_ID, secret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!shop || !clientId || !secret) throw new Error('Missing Shopify environment variables');
  const auth = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({client_id:clientId,client_secret:secret,grant_type:'client_credentials'}) });
  if (!auth.ok) throw new Error(`Shopify authentication failed (${auth.status})`);
  const token = (await auth.json()).access_token;
  const graphql = async (query, variables) => {
    const response = await fetch(`https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`, { method:'POST', headers:{'content-type':'application/json','X-Shopify-Access-Token':token}, body:JSON.stringify({query,variables}) });
    const body = await response.json();
    if (!response.ok || body.errors) throw new Error(`Shopify GraphQL failed (${response.status})`);
    return body.data;
  };
  const bigquery = new BigQuery({ projectId: project, credentials });
  let updatedSince = null;
  if (mode === 'incremental') {
    await ensureGeographyTable(bigquery, project);
    const [found] = await bigquery.query({ query:`SELECT TIMESTAMP_SUB(COALESCE(MAX(order_updated_at),TIMESTAMP '1970-01-01'),INTERVAL 1 DAY) watermark FROM \`${project}.shopify_data.${TABLE}\`` });
    updatedSince = new Date(found[0].watermark.value || found[0].watermark).toISOString();
  }
  const rows = await fetchShippingGeography({ graphql, updatedSince });
  console.log(JSON.stringify(await persistShippingGeography({ bigquery, project, rows, mode })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode=1; });
