import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ReportV2ValidationError,
  VALIDATION_OPERATIONS,
  assertValidatorSqlShape,
  validate,
  validationQueries
} from '../diagnostics/report-v2-production-validation.js';

test('every production-validator statement passes local SQL-shape checks', () => {
  const queries = validationQueries('fixture-project');
  assert.deepEqual(Object.keys(queries), Object.keys(VALIDATION_OPERATIONS));
  for (const [name, query] of Object.entries(queries)) assert.equal(assertValidatorSqlShape(name, query), true);
});

test('SQL-shape checks reject common projection, grouping, and union defects', () => {
  const malformed = [
    'SELECT , thing FROM `p.d.t`',
    'SELECT thing,, other FROM `p.d.t`',
    'SELECT thing, FROM `p.d.t`',
    'SELECT thing FROM `p.d.t` GROUP BY ORDER BY thing',
    'SELECT thing FROM `p.d.t` GROUP BY thing, ORDER BY thing',
    'SELECT thing FROM `p.d.t` UNION SELECT thing FROM `p.d.u`',
    ''
  ];
  for (const query of malformed) assert.throws(() => assertValidatorSqlShape('fixture', query), /Malformed SQL|Empty SQL/);
  assert.throws(
    () => assertValidatorSqlShape('product_identity', 'WITH products AS (SELECT line_title AS base_title, NORMALIZE(base_title,NFKC) normalized_base_title) SELECT * FROM products'),
    /base_title must be materialized before normalization/
  );
});

test('validator SQL covers all required evidence and avoids the reserved window alias', () => {
  const queries = validationQueries('fixture-project');
  assert.match(queries.finance, /accountant_transactions/);
  assert.match(queries.finance, /full_period/);
  assert.match(queries.finance, /campaign_window/);
  assert.match(queries.finance, /outside_campaign_window/);
  assert.match(queries.finance, /resulting_canonical_online/);
  assert.match(queries.shopify_currency, /presentment_currency/);
  assert.doesNotMatch(queries.shopify_currency, /bf_window|,'november'/);
  assert.match(queries.search_console, /2024-11-01/);
  assert.match(queries.customers, /identified_customers/);
  assert.match(queries.products, /shopify_data\.order_line_items/);
  assert.match(queries.products, /retail_location_id/);
  assert.match(queries.products, /square_data\.retail_order_items/);
  assert.match(queries.products, /deterministic_sku_lines/);
  assert.match(queries.product_identity, /exact_unique_normalized_title/);
  assert.match(queries.product_identity, /resolved_line_item_percentage/);
  assert.match(queries.product_identity, /square_pos/);
  assert.match(queries.geography, /commerce\.order_geography/);
  assert.match(queries.geography, /unavailable_not_persisted/);
  assert.match(queries.shopify_geography_schema, /INFORMATION_SCHEMA\.COLUMNS/);
  assert.doesNotMatch(queries.geography, /billing|presentment_currency|shop_currency/i);
  for (const query of Object.values(queries)) {
    assert.doesNotMatch(query, /\)\s+window\b/i);
    assert.doesNotMatch(query, /\bGROUP BY window\b/i);
  }
});

test('validator reports stable progress and safe structured BigQuery failure context', async () => {
  const progress = [];
  const bigquery = { async query(options) {
    if (options.labels.check === 'search_console') {
      const error = new Error('Syntax error: Unexpected "," at [1:84] Bearer secret-token');
      error.name = 'BigQueryError';
      error.code = 400;
      error.errors = [{ reason: 'invalidQuery', message: 'unreported provider detail' }];
      throw error;
    }
    return [[]];
  } };
  await assert.rejects(validate({ bigquery, project: 'fixture-project', onProgress: item => progress.push(item) }), error => {
    assert.ok(error instanceof ReportV2ValidationError);
    assert.deepEqual(error.context, {
      validator: 'report-v2-production',
      check_name: 'search_console',
      operation: 'validate_search_console',
      error_class: 'BigQueryError',
      bigquery_reason: 'invalidQuery',
      bigquery_code: '400',
      message: 'Syntax error: Unexpected "," at [1:84] Bearer [REDACTED]'
    });
    assert.doesNotMatch(JSON.stringify(error.context), /secret-token|provider detail|SELECT/i);
    return true;
  });
  assert.deepEqual(progress.map(({ check_name, status }) => ({ check_name, status })), [
    { check_name: 'finance', status: 'PASS' },
    { check_name: 'shopify_currency', status: 'PASS' },
    { check_name: 'search_console', status: 'FAIL' }
  ]);
});

test('all validator jobs carry stable check and operation labels', async () => {
  const calls = [];
  await validate({ project: 'fixture-project', bigquery: { query: async options => { calls.push(options); return [[]]; } } });
  assert.deepEqual(calls.map(call => call.labels), Object.entries(VALIDATION_OPERATIONS).map(([check, operation]) => ({ component: 'report_v2_validator', check, operation })));
  assert.ok(calls.every(call => call.useLegacySql === false && call.maximumBytesBilled === '10000000000'));
});

test('product validator contrasts old/new models and emits pairwise, option, Square, and unresolved contracts', () => {
  const queries = validationQueries('fixture-project');
  assert.match(queries.product_identity_previous, /distinct_source_titles/);
  assert.match(queries.product_identity, /stable_source_products/);
  assert.match(queries.product_identity, /resolved_sales_percentage/);
  assert.match(queries.woo_product_audit, /persisted_option_keys/);
  assert.match(queries.woo_product_audit, /bounded_title_patterns/);
  assert.match(queries.square_product_audit, /explicit_item_ids/);
  assert.match(queries.pairwise_product_coverage, /woo:ww/);
  assert.match(queries.pairwise_product_coverage, /square:square/);
  assert.match(queries.pairwise_product_coverage, /sales_coverage/);
  assert.match(queries.unresolved_products, /mapping_reason/);
  assert.match(queries.unresolved_products, /LIMIT 100/);
  assert.match(queries.shopify_channel_deduplication, /duplicate_source_identities_after_consolidation/);
  assert.match(queries.shopify_channel_deduplication, /online_only/);
  assert.match(queries.mapping_improvement, /before_channel_deduplication/);
  assert.match(queries.mapping_improvement, /after_channel_deduplication/);
  assert.match(queries.candidate_layer, /product_mapping_decisions/);
  assert.match(queries.candidate_layer, /mapping_status/);
  assert.match(queries.candidate_layer, /row_kind/);
});

test('candidate validator invokes the shared generator and emits explainable diagnostics', async () => {
  const rows=[
    {row_kind:'product',source_product_ref:'woo:ww:1',source_platform:'woo',source_store:'ww',source_product_id:'1',title:'Love and Death Ring',line_items:332,sales:1000,mapping_status:'source_specific'},
    {row_kind:'product',source_product_ref:'square:square:2',source_platform:'square',source_store:'square',source_product_id:'2',title:'Love & Death Ring',line_items:440,sales:1200,mapping_status:'source_specific'}
  ];
  const output=await validate({project:'fixture-project',bigquery:{query:async options=>[options.labels.check==='candidate_layer'?rows:[]]}});
  const diagnostic=output.candidate_layer[0];
  assert.equal(diagnostic.candidate_count,1);
  assert.equal(diagnostic.high_review_priority,1);
  assert.equal(diagnostic.blocked_candidate_pairs_considered,1);
  assert.equal(diagnostic.unique_source_products_represented,2);
  assert.equal(diagnostic.top_candidates.length,1);
});

test('governed product SQL materializes base titles at source-product grain before mapping', () => {
  const queries = validationQueries('fixture-project');
  for (const name of ['product_identity', 'woo_product_audit', 'pairwise_product_coverage', 'unresolved_products']) {
    const query = queries[name];
    assert.match(query, /base AS \(\s*SELECT platform,store,product_id,[\s\S]*?FROM lines GROUP BY 1,2,3\s*\)/);
    assert.match(query, /product_base_titles AS \(\s*SELECT b\.\*,t\.line_title AS base_title FROM base b LEFT JOIN chosen_title t USING\(platform,store,product_id\)\s*\)/);
    assert.match(query, /products AS \(\s*SELECT pbt\.\*,LOWER\(TRIM\([\s\S]*?NORMALIZE\(base_title,NFKC\)/);
    assert.ok(query.indexOf('AS base_title') < query.indexOf('NORMALIZE(base_title,NFKC)'));
    assert.doesNotMatch(query, /SELECT b\.\*,t\.line_title AS base_title,[^)]*NORMALIZE\(base_title,NFKC\)/);
  }

  const productIdentity = queries.product_identity;
  assert.match(productIdentity, /'woo' platform,'ww' store[\s\S]*CAST\(li\.product_id AS STRING\)/);
  assert.match(productIdentity, /'woo_usd','woo','usd'[\s\S]*CAST\(li\.product_id AS STRING\)/);
  assert.match(productIdentity, /'shopify','shopify'[\s\S]*li\.product_id,li\.variant_id,COALESCE\(li\.title,li\.name\)/);
  assert.match(productIdentity, /'square','square'[\s\S]*COALESCE\(JSON_VALUE\([\s\S]*?'\$\.item_id'\),catalog_object_id\)/);
  assert.doesNotMatch(productIdentity, /transaction_variation_name|variant_title/);
});
