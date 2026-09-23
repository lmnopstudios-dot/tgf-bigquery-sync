import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_MAPPING_SCHEMA } from '../oracle/product-mapping.js';
import { assertReadOnly, productMappingValidationQueries, validateProductMapping } from '../diagnostics/product-mapping-production-validation.js';

test('product mapping production validator is read-only, aggregate-only and covers workflow contracts',async()=>{
  const queries=productMappingValidationQueries('demo');assertReadOnly(queries);
  assert.deepEqual(Object.keys(queries),['schema','resolver','history','graph_integrity','suppression','search','parameter_binding']);
  const submitted=[];const result=await validateProductMapping({project:'demo',bigquery:{query:async options=>{submitted.push(options);if(options.query.includes('INFORMATION_SCHEMA'))return [PRODUCT_MAPPING_SCHEMA.map(spec=>{const [column_name,data_type]=spec.split(':');return {column_name,data_type,is_nullable:'YES'}})];if(options.query.includes('ORDER BY reviewed_at'))return [[]];return [[{count:1}]]}}});
  assert.equal(result.contract.read_only,true);assert.equal(result.contract.no_test_writes,true);assert.equal(submitted.length,7);assert.equal(submitted.at(-1).types.payload,'STRING');
});
