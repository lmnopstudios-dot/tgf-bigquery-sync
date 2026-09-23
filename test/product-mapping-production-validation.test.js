import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReadOnly, productMappingValidationQueries, validateProductMapping } from '../diagnostics/product-mapping-production-validation.js';

test('product mapping production validator is read-only, aggregate-only and covers workflow contracts',async()=>{
  const queries=productMappingValidationQueries('demo');assertReadOnly(queries);
  assert.deepEqual(Object.keys(queries),['schema','resolver','history','graph_integrity','suppression','search']);
  assert.ok(Object.values(queries).every(sql=>!/(INSERT|UPDATE|DELETE|MERGE|CREATE)\s/i.test(sql)));
  const submitted=[];const result=await validateProductMapping({project:'demo',bigquery:{query:async options=>{submitted.push(options);return [[{count:1}]]}}});
  assert.equal(result.contract.read_only,true);assert.equal(result.contract.no_test_writes,true);assert.equal(submitted.length,6);
});
