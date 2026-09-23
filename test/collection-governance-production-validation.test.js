import test from 'node:test';
import assert from 'node:assert/strict';
import { BigQuery } from '@google-cloud/bigquery';
import { COLLECTION_GOVERNANCE_SCHEMA, collectionDecisionPayload, createCollectionClassificationService } from '../oracle/collection-classification.js';
import { assertCollectionSchema, assertReadOnly, buildCollectionContractRows, collectionGovernanceValidationQueries, validateCollectionGovernance } from '../diagnostics/collection-governance-production-validation.js';
import { GovernanceWriteError, governanceDiagnostic, governancePublicError } from '../oracle/governance-diagnostics.js';

test('Sammi collaboration and Other contracts serialize nullable values at the actual client boundary',()=>{
  const rows=buildCollectionContractRows();assert.equal(rows.length,3);assert.equal(rows[1].classification_value,'sammi');assert.equal(rows[2].classification_value,'other');assert.equal(rows[2].note,null);
  const parameter=BigQuery.valueToQueryParameter_(collectionDecisionPayload(rows),'STRING');assert.equal(parameter.parameterType.type,'STRING');assert.match(parameter.parameterValue.value,/657944510791/);
  assert.throws(()=>BigQuery.valueToQueryParameter_(rows),/types must be provided for null values/);
});

test('collection validator is SELECT-only, checks exact schema and submits typed payload',async()=>{
  const rows=buildCollectionContractRows(),queries=collectionGovernanceValidationQueries('demo',collectionDecisionPayload(rows));assertReadOnly(queries);
  const schema=COLLECTION_GOVERNANCE_SCHEMA.map(([column_name,data_type,is_nullable])=>({column_name,data_type,is_nullable}));assertCollectionSchema(schema);assert.throws(()=>assertCollectionSchema(schema.slice(1)),/classification_id: missing/);
  const calls=[];const result=await validateCollectionGovernance({project:'demo',bigquery:{query:async options=>{calls.push(options);return [options.query.includes('INFORMATION_SCHEMA')?schema:[]]}}});
  assert.equal(result.contract.read_only,true);assert.equal(calls.length,5);assert.equal(calls.at(-1).types.payload,'STRING');
});

test('classification uses one append-only JSON insert for group and name',async()=>{
  const calls=[],bigquery={query:async options=>{calls.push(options);if(options.query.startsWith('SELECT * EXCEPT'))return [[]];return [[]]}};
  const service=createCollectionClassificationService({bigquery,project:'demo'});const result=await service.classify({collection_id:'657944510791',collection_title:'Sammi',collection_group:'collaboration',collaboration_name:'Sammi',note:null},'Stuart');
  assert.equal(result.name.classification_value,'sammi');const insert=calls.find(x=>x.query.startsWith('INSERT INTO'));assert.ok(insert);assert.equal(insert.types.payload,'STRING');assert.equal(JSON.parse(insert.params.payload).length,2);assert.doesNotMatch(insert.query,/UPDATE|DELETE/);
});

test('diagnostics retain internal stage while public unexpected errors stay sanitized',()=>{
  const error=new GovernanceWriteError('insert_decision','collection_governance_append',Object.assign(new Error('Parameter binding failed private_key=secret'),{code:400,errors:[{reason:'invalidQuery'}]}));const diagnostic=governanceDiagnostic(error,{operation:'classify',collection_id:'657944510791'});
  assert.equal(diagnostic.stage,'insert_decision');assert.equal(diagnostic.bigquery_reason,'invalidQuery');assert.doesNotMatch(diagnostic.internal_message,/secret/);assert.equal(governancePublicError(error),'The request could not be completed');
});
