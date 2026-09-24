import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertReadOnlyAggregate, buildAttributionQuery, metadataQuery, parseArgs, runDiagnostic
} from '../diagnostics/square-customer-attribution.js';

const metadata = (definitions = {
  orders: [['order_id','STRING'],['created_at','TIMESTAMP'],['updated_at','TIMESTAMP'],['state','STRING'],['total_money_amount','NUMERIC'],['currency','STRING'],['customer_id','STRING'],['email_address','STRING'],['phone_number','STRING'],['receipt_email','STRING']],
  payments: [['payment_id','STRING'],['order_id','STRING'],['customer_id','STRING'],['buyer_email_address','STRING'],['receipt_email_address','STRING'],['receipt_url','STRING']],
  customers: [['customer_id','STRING'],['email_address','STRING'],['phone_number','STRING']]
}) => Object.entries(definitions).flatMap(([table_name, fields]) => fields.map(([column_name,data_type], i) => ({ table_name, table_type:'BASE TABLE', column_name, data_type, ordinal_position:i+1 })));

test('arguments and metadata discovery reject injection and remain read-only', () => {
  assert.deepEqual(parseArgs(['--project','p','--dataset','square_data']), {project:'p',dataset:'square_data'});
  assert.throws(()=>parseArgs(['--dataset','x`; DROP TABLE people']),/Invalid dataset/);
  const sql=metadataQuery('p');
  assert.match(sql,/^SELECT/); assert.match(sql,/INFORMATION_SCHEMA\.COLUMNS/);
  assert.doesNotMatch(sql,/\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER)\b/i);
});

test('annual SQL applies governed completion, latest-row dedupe, currency and calendar-year boundaries', () => {
  const sql=buildAttributionQuery('p','square_data',metadata());
  assert.match(sql,/IN \('COMPLETED','COMPLETE'\)/);
  assert.match(sql,/ROW_NUMBER\(\) OVER \(PARTITION BY order_id ORDER BY updated_at DESC/);
  assert.match(sql,/EXTRACT\(YEAR FROM order_timestamp\) year, currency/);
  assert.match(sql,/GROUP BY year,currency/);
  assert.doesNotMatch(sql,/DATE_TRUNC\([^)]*,\s*YEAR\).*UTC/i);
});

test('coverage remains overlapping and receipt evidence is not attribution', () => {
  const sql=buildAttributionQuery('p','square_data',metadata());
  assert.match(sql,/transaction_and_receipt_email_overlap/);
  assert.match(sql,/order_payment_id_overlap/);
  assert.match(sql,/order_payment_id_agreement/);
  assert.match(sql,/conservatively_attributable_orders/);
  const conservative=sql.slice(sql.indexOf('COUNTIF(stable_customer_id IS NOT NULL AND NOT id_conflict'));
  assert.doesNotMatch(conservative.split('conservatively_attributable_orders')[0],/receipt_destination|transaction_email|transaction_phone/);
});

test('collision and joinability measures cover both cardinality directions without resolving them', () => {
  const sql=buildAttributionQuery('p','square_data',metadata());
  assert.match(sql,/COUNT\(DISTINCT customer_id\) payment_customer_ids/);
  assert.match(sql,/customer_to_many_contact_orders/);
  assert.match(sql,/shared_contact_across_customers_orders/);
  assert.match(sql,/orders_with_multiple_payments/);
  assert.match(sql,/customer_id_without_customer_record/);
  assert.match(sql,/conflicting_customer_ids/);
  assert.doesNotMatch(sql,/COALESCE\([^)]*(?:email|phone)[^)]*,[^)]*customer_id/i);
});

test('missing evidence becomes typed NULL and is not falsely reported as available', async () => {
  const sparse=metadata({orders:[['order_id','STRING'],['created_at','TIMESTAMP'],['state','STRING'],['total_amount','NUMERIC'],['currency','STRING']]});
  const calls=[];
  const bq={query:async request=>{calls.push(request);return calls.length===1?[sparse]:[[{year:2020,currency:'GBP',eligible_orders:1}]];}};
  const result=await runDiagnostic({bigquery:bq,project:'p'});
  assert.equal(result.persisted_evidence.order_customer_id,false);
  assert.equal(result.persisted_evidence.payments_table,false);
  assert.equal(result.persisted_evidence.customers_table,false);
  assert.equal(result.annual_evidence[0].eligible_orders,1);
  assert.match(calls[1].query,/payment_source/);
});

test('runner emits aggregate PII-free output and submits SELECT/WITH only', async () => {
  const calls=[];
  const bq={query:async request=>{calls.push(request);return calls.length===1?[metadata()]:[[{year:2025,currency:'GBP',eligible_orders:10,conservatively_attributable_orders:4}]];}};
  const result=await runDiagnostic({bigquery:bq,project:'p'});
  assert.deepEqual(result.safety,{read_only:true,aggregate_only:true,pii_free_output:true,production_writes:false});
  assert.ok(calls.every(({query})=>/^\s*(?:SELECT|WITH)\b/i.test(query)));
  assert.ok(calls.every(({query})=>! /\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|EXPORT|CALL)\b/i.test(query)));
  const output=JSON.stringify(result);
  assert.doesNotMatch(output,/person@example\.test|\+447700900000|sq-order-secret|sq-customer-secret/i);
  assert.doesNotMatch(Object.keys(result.annual_evidence[0]).join(' '),/email_address|phone_number|customer_id|order_id|hash/i);
  assertReadOnlyAggregate(calls[1].query);
});
