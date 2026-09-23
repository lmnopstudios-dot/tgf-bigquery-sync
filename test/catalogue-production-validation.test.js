import test from 'node:test';
import assert from 'node:assert/strict';
import {assertCatalogueValidatorSqlShape,catalogueValidationQueries,validateCatalogueProduction} from '../diagnostics/catalogue-production-validation.js';

test('catalogue validator avoids DISTINCT aggregates with ORDER BY',()=>{
  const queries=catalogueValidationQueries('fixture-project');
  for(const [name,query] of Object.entries(queries))assert.doesNotThrow(()=>assertCatalogueValidatorSqlShape(name,query));
  assert.throws(()=>assertCatalogueValidatorSqlShape('broken',`SELECT ARRAY_AGG(DISTINCT IF(active,value,NULL) IGNORE NULLS ORDER BY value) FROM fixture`),/Invalid DISTINCT aggregate ORDER BY/);
  assert.throws(()=>assertCatalogueValidatorSqlShape('broken',`SELECT STRING_AGG(DISTINCT value ORDER BY rank) FROM fixture`),/Invalid DISTINCT aggregate ORDER BY/);
});

test('product type governance deduplicates before building its ordered evidence array',()=>{
  const sql=catalogueValidationQueries('fixture-project').product_type_governance;
  assert.match(sql,/unmapped_product_types AS \(SELECT DISTINCT normalized_product_type product_type/);
  assert.match(sql,/ARRAY\(SELECT product_type FROM unmapped_product_types ORDER BY product_type\) unmapped_product_type_values/);
  assert.doesNotMatch(sql,/(?:ARRAY_AGG|STRING_AGG)\s*\(\s*DISTINCT[\s\S]*?ORDER BY/i);
  for(const field of ['total_products','mapped_product_type_products','unmapped_nonblank_product_type_products','blank_product_type_products','mapping_coverage_percentage','unmapped_product_type_values'])assert.match(sql,new RegExp(`\\b${field}\\b`));
});

test('readiness is derived from catalogue product types, independently of materialized category and collaboration readiness',()=>{
  const sql=catalogueValidationQueries('fixture-project').readiness;
  for(const field of ['total_shopify_products','products_with_specific_product_type_evidence','category_ready_products','blank_product_type_products','unmapped_nonblank_product_type_products','category_mapping_coverage_percentage','unmapped_product_type_values','unknown_products','collaboration_ready_products','collaboration_name_ready_products'])assert.match(sql,new RegExp(`\\b${field}\\b`));
  assert.match(sql,/m\.source_value IS NOT NULL category_ready/);
  assert.doesNotMatch(sql,/classification_type='product_category'/);
  assert.match(sql,/classification_type='product_group'/);
});

test('catalogue production validation retains every evidence query and contract flag',async()=>{
  const submitted=[];
  const bigquery={query:async options=>{submitted.push(options);return [[]]}};
  const result=await validateCatalogueProduction({bigquery,project:'fixture-project'});
  assert.deepEqual(Object.keys(result.evidence),Object.keys(catalogueValidationQueries('fixture-project')));
  assert.equal(submitted.length,5);
  assert.equal(result.read_only,true);
  assert.equal(result.aggregate_only,true);
  assert.equal(result.pii_free,true);
});
