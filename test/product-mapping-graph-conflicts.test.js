import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnoseProductMappingGraphConflicts } from '../diagnostics/product-mapping-graph-conflicts.js';

test('existing graph diagnostic validates bounded product ids before querying',async()=>{
  let queries=0;
  await assert.rejects(()=>diagnoseProductMappingGraphConflicts({project:'demo',productIds:[],bigquery:{query:async()=>{queries++;return [[]]}}}),/one to four/);
  assert.equal(queries,0);
});

test('existing graph diagnostic entry point contains no DML',()=>{
  const source=fs.readFileSync(new URL('../diagnostics/product-mapping-graph-conflicts.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
});
