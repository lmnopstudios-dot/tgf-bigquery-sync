import { pathToFileURL } from 'node:url';
import { BigQuery } from '@google-cloud/bigquery';
import { createShopifyCountryProductsService } from '../oracle/shopify-country-products.js';

export function parseArguments(argv, now = new Date()) {
  const value = flag => argv.find(x => x.startsWith(`--${flag}=`))?.slice(flag.length + 3) || null;
  const year = now.toISOString().slice(0, 4);
  return { start_date: value('start') || `${year}-01-01`, end_date: value('end') || now.toISOString().slice(0, 10), currency: value('currency') };
}

export async function validateShopifyCountryProducts({ bigquery, project = 'gf-full-data', input }) {
  const result = await createShopifyCountryProductsService({ bigquery, project })(input);
  const rows = result.rows;
  const failures = [];
  if (rows.length > 1000) failures.push('result exceeds the bounded 1,000-row contract');
  if (rows.some(row => Number(row.country_rank) > 10)) failures.push('country rank exceeds 10');
  if (rows.some(row => Number(row.product_rank) > 10)) failures.push('product rank exceeds 10');
  if (rows.some(row => !row.country_code || row.country_code === 'unknown')) failures.push('unknown country leaked into named rankings');
  const report = {
    contract: { read_only: true, aggregate_only: true, pii_free: true, maximum_rows: 1000 },
    period: result.period, currency_filter: result.currency_filter, returned_rows: rows.length,
    currencies: [...new Set(rows.map(row => row.currency))].sort(),
    coverage: [...new Map(rows.map(row => [row.currency, {
      currency: row.currency, eligible_orders: Number(row.eligible_orders),
      unknown_country_orders: Number(row.unknown_country_orders), unknown_order_share: Number(row.unknown_order_share || 0),
      eligible_sales: row.eligible_sales, unknown_country_sales: row.unknown_country_sales
    }])).values()],
    maximum_country_rank: Math.max(0, ...rows.map(row => Number(row.country_rank))),
    maximum_product_rank: Math.max(0, ...rows.map(row => Number(row.product_rank || 0))),
    status: failures.length ? 'failed' : 'passed', failures
  };
  if (failures.length) throw new Error(`Shopify country/product production validation failed: ${failures.join('; ')}`);
  return report;
}

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || 'null');
  if (!credentials) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const project = process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  const bigquery = new BigQuery({ projectId: project, credentials });
  console.log(JSON.stringify(await validateShopifyCountryProducts({ bigquery, project, input: parseArguments(process.argv.slice(2)) }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
