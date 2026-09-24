import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  assertReadOnlyAggregate, buildAttributionQuery, buildCustomerProfileQuery, buildIdentityIntegrityQuery,
  formatDiagnosticFailure, metadataQuery, parseArgs, runDiagnostic
} from '../diagnostics/square-customer-attribution.js';

const metadata = (definitions = {
  orders: [['order_id','STRING'],['created_at','TIMESTAMP'],['updated_at','TIMESTAMP'],['state','STRING'],['total_money','STRING'],['customer_id','STRING']],
  payments: [['payment_id','STRING'],['order_id','STRING'],['customer_id','STRING']],
  customers: [['customer_id','STRING'],['reference_id','STRING'],['email_address','STRING']]
}) => Object.entries(definitions).flatMap(([table_name, fields]) => fields.map(([column_name,data_type], i) => ({ table_name, column_name, data_type, ordinal_position:i+1 })));

test('arguments and metadata discovery reject injection and remain read-only', () => {
  assert.deepEqual(parseArgs(['--project','p','--dataset','square_data']), {project:'p',dataset:'square_data'});
  assert.throws(()=>parseArgs(['--dataset','x`; DROP TABLE people']),/Invalid dataset/);
  const sql=metadataQuery('p');
  assert.match(sql,/^SELECT table_name, column_name, data_type, ordinal_position/);
  assert.match(sql,/`p\.square_data\.INFORMATION_SCHEMA\.COLUMNS`/);
  assert.doesNotMatch(sql,/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER)\b/i);
});

test('customer table profile reports rows, stable ID fields and duplicates without selecting IDs', () => {
  const sql=buildCustomerProfileQuery('p','square_data',metadata());
  assert.match(sql,/COUNT\(\*\) customer_rows/);
  assert.match(sql,/COUNT\(DISTINCT stable_id\) distinct_stable_ids/);
  assert.match(sql,/duplicate_stable_id_rows/);
  assert.doesNotMatch(sql,/SELECT\s+stable_id\s+FROM/i);
  assertReadOnlyAggregate(sql);
});

test('empty or absent customer tables remain valid aggregate-only queries', () => {
  const sparse=metadata({orders:[['order_id','STRING'],['created_at','TIMESTAMP'],['state','STRING']]});
  const sql=buildCustomerProfileQuery('p','square_data',sparse);
  assert.match(sql,/WHERE FALSE/);
  assert.match(sql,/0 rows_with_stable_id/);
  assertReadOnlyAggregate(sql);
});

test('ID integrity covers format stages, repeats, disagreement, collisions and changes over time', () => {
  const sql=buildIdentityIntegrityQuery('p','square_data',metadata());
  for (const field of ['distinct_transaction_customer_ids','customer_ids_with_2plus_eligible_orders','exact_order_payment_id_matches',
    'order_payment_id_disagreements','exact_customer_record_matches','trimmed_customer_record_matches_only',
    'casefold_customer_record_matches_only','no_customer_record_in_any_format','order_ids_with_customer_change_over_time',
    'payment_ids_with_customer_change_over_time','duplicated_customer_ids','order_ids_outside_common_shape']) assert.match(sql,new RegExp(field));
  assert.match(sql,/COUNT\(DISTINCT stable_customer_id\)/);
  assert.doesNotMatch(sql,/\bSHA\d*\s*\(|FARM_FINGERPRINT|\bMD5\s*\(/i);
  assertReadOnlyAggregate(sql);
});

test('annual query extracts amount and currency from the same Square Money object and separates currencies', () => {
  const sql=buildAttributionQuery('p','square_data',metadata());
  assert.match(sql,/JSON_VALUE\([^\n]+, '\$\.amount'\)/);
  assert.match(sql,/JSON_VALUE\([^\n]+, '\$\.currency'\)/);
  assert.match(sql,/EXTRACT\(YEAR FROM order_timestamp\) year, currency/);
  assert.match(sql,/GROUP BY year,currency/);
  assert.match(sql,/order_payment_id_agreement/);
});

test('flattened Money contract uses paired amount and currency columns', () => {
  const rows=metadata({orders:[['order_id','STRING'],['created_at','TIMESTAMP'],['total_money_amount','INT64'],['total_money_currency','STRING']]});
  const sql=buildAttributionQuery('p','square_data',rows);
  assert.match(sql,/SAFE_CAST\(o\.`total_money_amount` AS NUMERIC\) sales/);
  assert.match(sql,/o\.`total_money_currency`/);
});

test('runner emits four read-only calls and a PII-free contract result', async () => {
  const rows=metadata(), calls=[];
  const responses=[[rows],[[{customer_rows:59,distinct_stable_ids:59}]],[[{distinct_transaction_customer_ids:100,customer_ids_with_2plus_eligible_orders:20}]],[[{year:2025,currency:'GBP',eligible_orders:10}]]];
  const result=await runDiagnostic({bigquery:{query:async request=>{calls.push(request);return responses.shift();}},project:'p'});
  assert.equal(calls.length,4);
  assert.ok(calls.every(({query})=>/^\s*(?:SELECT|WITH)\b/i.test(query)));
  assert.equal(result.persisted_schema.customers_table_present,true);
  assert.deepEqual(result.persisted_schema.customer_id_fields.map(x=>x.column),['customer_id','reference_id']);
  assert.match(result.money_contract.amount_unit,/smallest denomination/);
  assert.equal(result.annual_evidence[0].currency,'GBP');
  const output=JSON.stringify(result);
  assert.doesNotMatch(output,/person@example\.test|sq-customer-secret|receipt_destination|person-trackable hash/i);
});

test('no-row fixtures do not leak row-level identifiers through output fields', async () => {
  const rows=metadata(), responses=[[rows],[[]],[[]],[[]]];
  const result=await runDiagnostic({bigquery:{query:async()=>responses.shift()},project:'p'});
  assert.deepEqual(result.customer_table,{});
  assert.deepEqual(result.id_integrity,{});
  assert.deepEqual(result.annual_evidence,[]);
  assert.doesNotMatch(Object.keys(result).join(' '),/(^|_)order_id$|(^|_)customer_id$|email|phone|hash/i);
});

test('failures are stage-aware, bounded, and omit unsafe API details', async () => {
  const unsafe='SELECT secret FROM data -- credential=private '.repeat(1000);
  const apiError=Object.assign(new Error(unsafe),{code:400,errors:[{reason:'invalidQuery',message:unsafe}],response:{body:unsafe}});
  await assert.rejects(runDiagnostic({bigquery:{query:async()=>{throw apiError;}},project:'p'}),error=>{
    assert.equal(formatDiagnosticFailure(error),'Square customer-attribution diagnostic failed during schema discovery (reason: invalidQuery, code: 400).');
    return true;
  });
});

test('CLI failure exits nonzero without raw error output', () => {
  const run=spawnSync(process.execPath,['diagnostics/square-customer-attribution.js','--unknown'],{encoding:'utf8'});
  assert.notEqual(run.status,0); assert.equal(run.stdout,'');
  assert.equal(run.stderr,'Square customer-attribution diagnostic failed during argument parsing.\n');
});
