import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SHOPIFY_COUNTRY_PRODUCTS_TOOL_DEFINITION, createShopifyCountryProductsService, shopifyCountryProductsSql } from '../oracle/shopify-country-products.js';
import { parseArguments, validateShopifyCountryProducts } from '../diagnostics/shopify-country-products-production.js';

test('query ranks ten direct countries and ten country-specific products without multiplying order sales', () => {
  const sql = shopifyCountryProductsSql('p');
  assert.match(sql, /ROW_NUMBER\(\) OVER\(PARTITION BY currency ORDER BY operational_net_sales DESC,country_code\) country_rank/);
  assert.match(sql, /country_rank<=10/);
  assert.match(sql, /ROW_NUMBER\(\) OVER\(PARTITION BY currency,country_code ORDER BY product_sales DESC,source_product_id\) product_rank/);
  assert.match(sql, /rp\.product_rank<=10/);
  assert.match(sql, /country_totals[\s\S]*FROM eligible_orders WHERE country_code IS NOT NULL/);
  assert.match(sql, /product_lines[\s\S]*JOIN top_countries tc USING\(currency,country_code\)/);
  const countrySection=sql.slice(sql.indexOf('country_totals AS'),sql.indexOf('ranked_countries AS'));
  assert.doesNotMatch(countrySection,/order_line_items/);
  assert.match(countrySection,/SUM\(operational_net_sales\)/);
});

test('query preserves governed Online, currency, refund, Matrixify, unknown, and product-grain semantics', () => {
  const sql = shopifyCountryProductsSql('p');
  assert.match(sql, /retail_location_id IS NULL/);
  assert.match(sql, /source_app_id IS NULL OR l\.source_app_id!=@matrixify_app_id/);
  assert.match(sql, /original_total_presentment-COALESCE\(f\.total_refunded_presentment,0\)/);
  assert.match(sql, /discounted_total_presentment/);
  assert.match(sql, /PARTITION BY currency/);
  assert.match(sql, /unknown_country_orders/);
  assert.match(sql, /COALESCE\(NULLIF\(li\.product_id,''\),'unknown'\)/);
  assert.match(sql, /COUNT\(DISTINCT order_id\) product_orders/);
  assert.match(sql, /SUM\(units\) units/);
});

test('service returns explicit semantics and uses bounded, typed BigQuery execution', async () => {
  let job;
  const row = { currency:'GBP',country_rank:1,country_code:'GB',product_rank:1,product_grain_status:'stable_shopify_parent_product' };
  const service = createShopifyCountryProductsService({ bigquery:{ async query(input){ job=input; return [[row]]; } }, project:'p' });
  const result = await service({ start_date:'2026-01-01',end_date:'2026-09-24',currency:null });
  assert.deepEqual(result.rows,[row]);
  assert.equal(job.params.matrixify_app_id,'gid://shopify/App/1758145');
  assert.equal(job.maximumBytesBilled,'10000000000');
  assert.match(result.semantics.unknown,/excluded/);
  assert.match(result.semantics.refunds,/not governed at product allocation grain/);
  assert.match(result.semantics.unresolved_products,/explicit/);
});

test('exact user question is routed to aggregate tool while order-example path remains', () => {
  const prompt = fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
  const question = 'Can you give me the top ten locations for online sales this year along with the top 10 products sold to each one?';
  assert.match(question,/top ten locations[\s\S]*top 10 products/);
  assert.match(prompt,/top locations\/countries for online sales plus top products sold to each/);
  assert.match(prompt,/call get_shopify_online_country_products/);
  assert.match(prompt,/Use search_orders only for bounded order examples/);
  assert.match(SHOPIFY_COUNTRY_PRODUCTS_TOOL_DEFINITION.description,/aggregate path/);
});

test('production validator is bounded, aggregate-only and reports unknown coverage', async () => {
  const row={currency:'GBP',country_rank:1,country_code:'GB',product_rank:1,eligible_orders:100,unknown_country_orders:4,unknown_order_share:.04,eligible_sales:900,unknown_country_sales:20};
  const report=await validateShopifyCountryProducts({bigquery:{async query(){return [[row]];}},project:'p',input:{start_date:'2026-01-01',end_date:'2026-09-24',currency:null}});
  assert.deepEqual(report.contract,{read_only:true,aggregate_only:true,pii_free:true,maximum_rows:1000});
  assert.equal(report.coverage[0].unknown_country_orders,4);
  assert.deepEqual(parseArguments([],new Date('2026-09-24T12:00:00Z')),{start_date:'2026-01-01',end_date:'2026-09-24',currency:null});
});
