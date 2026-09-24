import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_FAMILY_SCHEMA, PRODUCT_MAPPING_SCHEMA } from '../oracle/product-mapping.js';
import { assertReadOnly, productMappingValidationQueries, validateProductMapping } from '../diagnostics/product-mapping-production-validation.js';

test('product mapping production validator is read-only, aggregate-only and covers workflow contracts',async()=>{
  const queries=productMappingValidationQueries('demo');assertReadOnly(queries);
  assert.deepEqual(Object.keys(queries),['schema','family_schema','resolver','history','graph_integrity','family_history','family_resolver','suppression','search','parameter_binding']);
  const submitted=[];const result=await validateProductMapping({project:'demo',bigquery:{query:async options=>{submitted.push(options);if(options.query.includes('INFORMATION_SCHEMA')){const schema=options.query.includes("product_family_decisions")?PRODUCT_FAMILY_SCHEMA:PRODUCT_MAPPING_SCHEMA;return [schema.map(spec=>{const [column_name,data_type]=spec.split(':');return {column_name,data_type,is_nullable:'YES'}})]}if(options.query.includes('ORDER BY reviewed_at')||options.query.includes('WITH lines AS'))return [[]];return [[{count:1}]]}}});
  assert.equal(result.contract.read_only,true);assert.equal(result.contract.no_test_writes,true);assert.equal(result.contract.write_time_graph_parity,true);assert.equal(result.contract.family_relationships_are_not_identity_edges,true);assert.equal(submitted.length,11);assert.equal(submitted[9].types.payload,'STRING');
});
