#!/usr/bin/env node

/**
 * Aggregate-only audit of persisted Square customer evidence.
 *
 * The audit deliberately discovers the schema before composing the evidence query. It never
 * selects an identifier or contact value: identifiers are used inside CTEs solely for joins and
 * cardinality tests, and only annual aggregate counts leave BigQuery.
 */
import { BigQuery } from '@google-cloud/bigquery';

const IDENTIFIER = /^[A-Za-z0-9_-]+$/;
const WRITE = /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|EXPORT|CALL)\b/i;
const q = value => `\`${String(value).replaceAll('`', '')}\``;
const fq = (project, dataset, table) => q(`${project}.${dataset}.${table}`);
const clean = (value, label) => {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
};

export function parseArgs(argv) {
  const result = { project: process.env.GOOGLE_PROJECT_ID || 'gf-full-data', dataset: 'square_data' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') result.project = argv[++i];
    else if (argv[i] === '--dataset') result.dataset = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  clean(result.project, 'project'); clean(result.dataset, 'dataset');
  return result;
}

export function metadataQuery(project, dataset = 'square_data') {
  return `SELECT table_name, table_type, column_name, data_type, ordinal_position
FROM ${fq(project, dataset, 'INFORMATION_SCHEMA.COLUMNS')}
WHERE table_name NOT LIKE 'customer_attribution_%'
ORDER BY table_name, ordinal_position`;
}

const first = (table, names) => names.map(name => table?.columns.find(c => c.column_name.toLowerCase() === name)).find(Boolean);
const ref = (alias, column) => column ? `${alias}.${q(column.column_name)}` : null;
const string = (alias, column) => column ? `NULLIF(TRIM(CAST(${ref(alias, column)} AS STRING)), '')` : 'CAST(NULL AS STRING)';
const number = (alias, column) => column ? `SAFE_CAST(${ref(alias, column)} AS NUMERIC)` : 'CAST(NULL AS NUMERIC)';
const timestamp = (alias, column) => column ? `SAFE_CAST(${ref(alias, column)} AS TIMESTAMP)` : 'CAST(NULL AS TIMESTAMP)';
const normEmail = expression => `NULLIF(LOWER(TRIM(${expression})), '')`;
const normPhone = expression => `NULLIF(REGEXP_REPLACE(${expression}, r'[^0-9+]', ''), '')`;

function tablesFrom(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.table_name)) map.set(row.table_name, { name: row.table_name, columns: [] });
    map.get(row.table_name).columns.push(row);
  }
  return map;
}

/** Exact persisted-column evidence only. No field is asserted merely because Square might expose it. */
export function inspectEvidenceSchema(metadata) {
  const tables = tablesFrom(metadata);
  const orders = tables.get('orders') || tables.get('retail_orders');
  if (!orders) throw new Error('Square orders or retail_orders table was not discovered');
  const payments = tables.get('payments') || tables.get('retail_payments');
  const customers = tables.get('customers');
  const fields = {
    orders: {
      id: first(orders, ['order_id', 'id']), created: first(orders, ['created_at', 'closed_at']),
      updated: first(orders, ['updated_at', 'closed_at', 'created_at']), state: first(orders, ['state', 'order_state', 'status']),
      amount: first(orders, ['total_money_amount', 'transaction_order_total_amount', 'total_amount', 'total']),
      currency: first(orders, ['currency']), customerId: first(orders, ['customer_id']),
      email: first(orders, ['email_address', 'customer_email', 'buyer_email_address']),
      phone: first(orders, ['phone_number', 'customer_phone', 'buyer_phone_number']),
      receiptEmail: first(orders, ['receipt_email', 'receipt_email_address'])
    },
    payments: payments && {
      id: first(payments, ['payment_id', 'id']), orderId: first(payments, ['order_id']),
      customerId: first(payments, ['customer_id']), email: first(payments, ['buyer_email_address', 'email_address']),
      phone: first(payments, ['buyer_phone_number', 'phone_number']),
      receiptEmail: first(payments, ['receipt_email', 'receipt_email_address']), receiptUrl: first(payments, ['receipt_url'])
    },
    customers: customers && {
      id: first(customers, ['customer_id', 'id']), email: first(customers, ['email_address', 'email']),
      phone: first(customers, ['phone_number', 'phone'])
    }
  };
  if (!fields.orders.id || !fields.orders.created) throw new Error('Orders require an ID and created/closed timestamp');
  return { tables, orders, payments, customers, fields };
}

export function buildAttributionQuery(project, dataset, metadata) {
  const s = inspectEvidenceSchema(metadata);
  const o = s.fields.orders, p = s.fields.payments, c = s.fields.customers;
  const completed = o.state
    ? `UPPER(CAST(${ref('o', o.state)} AS STRING)) IN ('COMPLETED','COMPLETE')`
    : 'TRUE /* no persisted state field: eligibility is unresolved and all rows are profiled */';
  const paymentRows = s.payments && p.id && p.orderId ? `SELECT ${string('p', p.id)} payment_id, ${string('p', p.orderId)} order_id,
      ${string('p', p.customerId)} customer_id, ${normEmail(string('p', p.email))} email,
      ${normPhone(string('p', p.phone))} phone, ${normEmail(string('p', p.receiptEmail))} receipt_email
    FROM ${fq(project, dataset, s.payments.name)} p` : `SELECT CAST(NULL AS STRING) payment_id, CAST(NULL AS STRING) order_id,
      CAST(NULL AS STRING) customer_id, CAST(NULL AS STRING) email, CAST(NULL AS STRING) phone,
      CAST(NULL AS STRING) receipt_email WHERE FALSE`;
  const customerRows = s.customers && c.id ? `SELECT ${string('c', c.id)} customer_id, ${normEmail(string('c', c.email))} email,
      ${normPhone(string('c', c.phone))} phone FROM ${fq(project, dataset, s.customers.name)} c` : `SELECT CAST(NULL AS STRING) customer_id,
      CAST(NULL AS STRING) email, CAST(NULL AS STRING) phone WHERE FALSE`;
  return `WITH raw_orders AS (
    SELECT ${string('o', o.id)} order_id, ${timestamp('o', o.created)} order_timestamp,
      ${timestamp('o', o.updated)} updated_at, ${string('o', o.state)} order_state,
      UPPER(${string('o', o.currency)}) currency, ${number('o', o.amount)} sales,
      ${string('o', o.customerId)} order_customer_id, ${normEmail(string('o', o.email))} order_email,
      ${normPhone(string('o', o.phone))} order_phone, ${normEmail(string('o', o.receiptEmail))} order_receipt_email
    FROM ${fq(project, dataset, s.orders.name)} o WHERE ${completed}
  ), orders AS (
    SELECT * EXCEPT(updated_at) FROM raw_orders WHERE order_id IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY updated_at DESC, order_timestamp DESC) = 1
  ), payments AS (${paymentRows}), customers AS (${customerRows}),
  payment_rollup AS (
    SELECT order_id, COUNT(DISTINCT payment_id) payment_count, COUNT(DISTINCT customer_id) payment_customer_ids,
      ANY_VALUE(customer_id HAVING MIN customer_id) payment_customer_id,
      COUNTIF(email IS NOT NULL) payments_with_email, COUNTIF(phone IS NOT NULL) payments_with_phone,
      COUNTIF(receipt_email IS NOT NULL) payments_with_receipt_email
    FROM payments WHERE order_id IS NOT NULL GROUP BY order_id
  ), joined AS (
    SELECT o.*, COALESCE(p.payment_count,0) payment_count, COALESCE(p.payment_customer_ids,0) payment_customer_ids,
      p.payment_customer_id, COALESCE(p.payments_with_email,0)>0 payment_email,
      COALESCE(p.payments_with_phone,0)>0 payment_phone, COALESCE(p.payments_with_receipt_email,0)>0 payment_receipt_email,
      COALESCE(o.order_customer_id, IF(p.payment_customer_ids=1,p.payment_customer_id,NULL)) stable_customer_id,
      o.order_customer_id IS NOT NULL AND p.payment_customer_ids=1 AND o.order_customer_id=p.payment_customer_id id_agreement,
      o.order_customer_id IS NOT NULL AND p.payment_customer_ids>0 AND o.order_customer_id!=p.payment_customer_id id_conflict
    FROM orders o LEFT JOIN payment_rollup p USING(order_id)
  ), email_sharing AS (
    SELECT email, COUNT(DISTINCT customer_id) customer_ids FROM customers WHERE email IS NOT NULL GROUP BY email
  ), phone_sharing AS (
    SELECT phone, COUNT(DISTINCT customer_id) customer_ids FROM customers WHERE phone IS NOT NULL GROUP BY phone
  ), customer_joinability AS (
    SELECT c.customer_id, COUNT(*) customer_rows, COUNT(DISTINCT c.email) emails, COUNT(DISTINCT c.phone) phones,
      LOGICAL_OR(COALESCE(es.customer_ids,0)>1) shared_customer_email,
      LOGICAL_OR(COALESCE(ps.customer_ids,0)>1) shared_customer_phone
    FROM customers c LEFT JOIN email_sharing es USING(email) LEFT JOIN phone_sharing ps USING(phone)
    WHERE c.customer_id IS NOT NULL GROUP BY c.customer_id
  ), enriched AS (
    SELECT j.*, c.customer_id IS NOT NULL customer_record_joinable, c.customer_rows>1 duplicate_customer_records,
      c.emails>1 customer_has_multiple_emails, c.phones>1 customer_has_multiple_phones,
      COALESCE(c.shared_customer_email,FALSE) shared_customer_email,
      COALESCE(c.shared_customer_phone,FALSE) shared_customer_phone,
      (order_email IS NOT NULL OR payment_email) transaction_email,
      (order_phone IS NOT NULL OR payment_phone) transaction_phone,
      (order_receipt_email IS NOT NULL OR payment_receipt_email) receipt_destination
    FROM joined j LEFT JOIN customer_joinability c ON j.stable_customer_id=c.customer_id
  )
  SELECT EXTRACT(YEAR FROM order_timestamp) year, currency, '${s.orders.name}' order_source,
    '${s.payments?.name || 'not_ingested'}' payment_source, '${s.customers?.name || 'not_ingested'}' customer_source,
    COUNT(*) eligible_orders, SUM(sales) eligible_sales,
    COUNTIF(order_customer_id IS NOT NULL) orders_with_explicit_order_customer_id,
    COUNTIF(payment_customer_ids=1) orders_with_one_payment_customer_id,
    COUNTIF(order_customer_id IS NOT NULL AND payment_customer_ids=1) order_payment_id_overlap,
    COUNTIF(id_agreement) order_payment_id_agreement, COUNTIF(id_conflict OR payment_customer_ids>1) conflicting_customer_ids,
    COUNTIF(transaction_email) transaction_email_coverage, COUNTIF(transaction_phone) transaction_phone_coverage,
    COUNTIF(receipt_destination) receipt_destination_coverage,
    COUNTIF(transaction_email AND receipt_destination) transaction_and_receipt_email_overlap,
    COUNTIF(stable_customer_id IS NULL) missing_stable_customer_id,
    COUNTIF(payment_count=0) orders_without_joinable_payment, COUNTIF(payment_count>1) orders_with_multiple_payments,
    COUNTIF(stable_customer_id IS NOT NULL AND NOT customer_record_joinable) customer_id_without_customer_record,
    COUNTIF(customer_record_joinable) orders_joinable_to_customer_record,
    COUNTIF(duplicate_customer_records) duplicate_customer_record_orders,
    COUNTIF(customer_has_multiple_emails OR customer_has_multiple_phones) customer_to_many_contact_orders,
    COUNTIF(shared_customer_email OR shared_customer_phone) shared_contact_across_customers_orders,
    COUNTIF(stable_customer_id IS NOT NULL AND NOT id_conflict AND payment_customer_ids<=1) conservatively_attributable_orders,
    SUM(IF(stable_customer_id IS NOT NULL AND NOT id_conflict AND payment_customer_ids<=1,sales,0)) conservatively_attributable_sales
  FROM enriched GROUP BY year,currency ORDER BY year,currency`;
}

export function assertReadOnlyAggregate(query) {
  if (!/^WITH\b/i.test(query.trim()) || WRITE.test(query)) throw new Error('Diagnostic refused non-read-only SQL');
  if (/SELECT\s+\*\s+FROM\s+enriched/i.test(query)) throw new Error('Diagnostic refused row-level output');
}

export async function runDiagnostic({ bigquery, project, dataset = 'square_data' }) {
  const [metadata] = await bigquery.query({ query: metadataQuery(project, dataset), useLegacySql: false });
  const schema = inspectEvidenceSchema(metadata);
  const query = buildAttributionQuery(project, dataset, metadata);
  assertReadOnlyAggregate(query);
  const [annualEvidence] = await bigquery.query({ query, useLegacySql: false,
    labels: { component: 'square_customer_attribution', operation: 'annual_aggregate_audit' },
    maximumBytesBilled: '20000000000' });
  return {
    safety: { read_only: true, aggregate_only: true, pii_free_output: true, production_writes: false },
    semantics: {
      eligible_order: schema.fields.orders.state ? 'Latest persisted row per order ID in COMPLETE/COMPLETED state.' : 'All latest persisted order rows; no state field exists, so eligibility is unresolved.',
      sales: 'Persisted operational Square order amount, grouped by its original currency; not finance.sales_master.',
      conservative_attribution: 'Exactly one nonblank customer ID from the order and/or linked payments, with no disagreement or multi-customer payment set.',
      receipt_warning: 'Receipt destination is reported separately and is never treated as purchaser identity.',
      overlaps: 'Coverage columns overlap; do not sum them. Explicit overlap and agreement columns are supplied.'
    },
    persisted_evidence: {
      order_customer_id: Boolean(schema.fields.orders.customerId), order_email: Boolean(schema.fields.orders.email),
      order_phone: Boolean(schema.fields.orders.phone), order_receipt_email: Boolean(schema.fields.orders.receiptEmail),
      payments_table: Boolean(schema.payments), payment_customer_id: Boolean(schema.fields.payments?.customerId),
      payment_email: Boolean(schema.fields.payments?.email), payment_phone: Boolean(schema.fields.payments?.phone),
      payment_receipt_email: Boolean(schema.fields.payments?.receiptEmail), payment_receipt_url: Boolean(schema.fields.payments?.receiptUrl),
      customers_table: Boolean(schema.customers), customer_email: Boolean(schema.fields.customers?.email),
      customer_phone: Boolean(schema.fields.customers?.phone)
    },
    annual_evidence: annualEvidence,
    cross_platform_link_assessment: 'Not calculated unless governed Woo/Shopify contact evidence is separately demonstrated. No links or person-trackable hashes are emitted.'
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const result = await runDiagnostic({ ...options, bigquery: new BigQuery({ projectId: options.project, credentials }) });
  process.stdout.write(`${JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(error => { console.error(error); process.exitCode = 1; });
