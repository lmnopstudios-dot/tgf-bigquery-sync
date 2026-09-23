import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diagnoseProductMappingCandidate, parseCandidateDiagnosticSpec } from '../diagnostics/product-mapping-candidate.js';

test('candidate production diagnostic rejects an unbounded identifier before querying',async()=>{
  let queries=0;
  await assert.rejects(()=>diagnoseProductMappingCandidate({project:'demo',candidateId:'anything',bigquery:{query:async()=>{queries++;return [[]]}}}),/24-character candidate id/);
  assert.equal(queries,0);
});

test('choose-correct reproduction preserves a Shopify GID as the selected product id',()=>{
  assert.deepEqual(parseCandidateDiagnosticSpec('3f4ceb34b70f26d84ed4f605=gid://shopify/Product/10434349072711'),{candidateId:'3f4ceb34b70f26d84ed4f605',selectedRef:'gid://shopify/Product/10434349072711'});
});

test('candidate diagnostic entry point contains no DML',()=>{
  const source=fs.readFileSync(new URL('../diagnostics/product-mapping-candidate.js',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE)\b/i);
});
