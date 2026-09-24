#!/usr/bin/env node

/** Read-only, aggregate-only audit of persisted Square customer IDs and order money. */
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
  return `SELECT table_name, column_name, data_type, ordinal_position
FROM ${fq(project, dataset, 'INFORMATION_SCHEMA.COLUMNS')}
WHERE table_name NOT LIKE 'customer_attribution_%'
ORDER BY table_name, ordinal_position`;
}

const first = (table, names) => names.map(name => table?.columns.find(c => c.column_name.toLowerCase() === name)).find(Boolean);
const ref = (alias, column) => column ? `${alias}.${q(column.column_name)}` : null;
const string = (alias, column) => column ? `NULLIF(TRIM(CAST(${ref(alias, column)} AS STRING)), '')` : 'CAST(NULL AS STRING)';
const idString = (alias, column) => column ? `NULLIF(CAST(${ref(alias, column)} AS STRING), '')` : 'CAST(NULL AS STRING)';
const timestamp = (alias, column) => column ? `SAFE_CAST(${ref(alias, column)} AS TIMESTAMP)` : 'CAST(NULL AS TIMESTAMP)';

function tablesFrom(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.table_name)) map.set(row.table_name, { name: row.table_name, columns: [] });
    map.get(row.table_name).columns.push(row);
  }
  return map;
}

function moneyFields(table) {
  const object = first(table, ['total_money', 'total_money_json']);
  const amount = first(table, ['total_money_amount', 'transaction_order_total_amount', 'total_amount', 'total']);
  const currency = first(table, ['total_money_currency', 'currency_code', 'currency']);
  return { object, amount, currency };
}

function moneyExpressions(alias, money) {
  const parsed = money.object ? `SAFE.PARSE_JSON(CAST(${ref(alias, money.object)} AS STRING))` : null;
  const amount = parsed
    ? `SAFE_CAST(JSON_VALUE(${parsed}, '$.amount') AS NUMERIC)`
    : money.amount ? `SAFE_CAST(${ref(alias, money.amount)} AS NUMERIC)` : 'CAST(NULL AS NUMERIC)';
  const sources = [money.currency && string(alias, money.currency), parsed && `NULLIF(UPPER(JSON_VALUE(${parsed}, '$.currency')), '')`].filter(Boolean);
  return { amount, currency: sources.length > 1 ? `COALESCE(${sources.join(', ')})` : sources[0] || 'CAST(NULL AS STRING)' };
}

/** Only exact persisted fields are selected. Candidate names are reported, never inferred as rows. */
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
      customerId: first(orders, ['customer_id']), money: moneyFields(orders)
    },
    payments: payments && {
      id: first(payments, ['payment_id', 'id']), orderId: first(payments, ['order_id']),
      customerId: first(payments, ['customer_id'])
    },
    customers: customers && { id: first(customers, ['customer_id', 'id']) }
  };
  if (!fields.orders.id || !fields.orders.created) throw new Error('Orders require an ID and created/closed timestamp');
  return { tables, orders, payments, customers, fields };
}

function sources(project, dataset, s) {
  const o = s.fields.orders, p = s.fields.payments, c = s.fields.customers;
  const money = moneyExpressions('o', o.money);
  const completed = o.state ? `UPPER(CAST(${ref('o', o.state)} AS STRING)) IN ('COMPLETED','COMPLETE')` : 'TRUE';
  const payments = s.payments && p.id && p.orderId ? `SELECT ${idString('p', p.id)} payment_id, ${idString('p', p.orderId)} order_id,
      ${idString('p', p.customerId)} customer_id FROM ${fq(project, dataset, s.payments.name)} p`
    : 'SELECT CAST(NULL AS STRING) payment_id, CAST(NULL AS STRING) order_id, CAST(NULL AS STRING) customer_id WHERE FALSE';
  const customers = s.customers && c.id ? `SELECT ${idString('c', c.id)} customer_id FROM ${fq(project, dataset, s.customers.name)} c`
    : 'SELECT CAST(NULL AS STRING) customer_id WHERE FALSE';
  return `raw_orders AS (
    SELECT ${idString('o', o.id)} order_id, ${timestamp('o', o.created)} order_timestamp,
      ${timestamp('o', o.updated)} updated_at, ${idString('o', o.customerId)} order_customer_id,
      ${money.amount} sales, UPPER(${money.currency}) currency
    FROM ${fq(project, dataset, s.orders.name)} o WHERE ${completed}
  ), orders AS (
    SELECT * EXCEPT(updated_at) FROM raw_orders WHERE order_id IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY updated_at DESC, order_timestamp DESC) = 1
  ), payments AS (${payments}), customers AS (${customers}), payment_rollup AS (
    SELECT order_id, COUNT(DISTINCT payment_id) payment_count, COUNT(DISTINCT customer_id) payment_customer_ids,
      ANY_VALUE(customer_id HAVING MIN customer_id) payment_customer_id
    FROM payments WHERE order_id IS NOT NULL GROUP BY order_id
  ), joined AS (
    SELECT o.*, COALESCE(p.payment_count,0) payment_count, COALESCE(p.payment_customer_ids,0) payment_customer_ids,
      p.payment_customer_id, COALESCE(o.order_customer_id, IF(p.payment_customer_ids=1,p.payment_customer_id,NULL)) stable_customer_id,
      o.order_customer_id IS NOT NULL AND p.payment_customer_ids=1 AND o.order_customer_id=p.payment_customer_id id_agreement,
      o.order_customer_id IS NOT NULL AND p.payment_customer_ids>0 AND o.order_customer_id!=p.payment_customer_id id_conflict
    FROM orders o LEFT JOIN payment_rollup p USING(order_id)
  ), customer_ids AS (SELECT customer_id, COUNT(*) customer_rows FROM customers WHERE customer_id IS NOT NULL GROUP BY customer_id)`;
}

export function buildAttributionQuery(project, dataset, metadata) {
  const s = inspectEvidenceSchema(metadata);
  return `WITH ${sources(project, dataset, s)}, enriched AS (
    SELECT j.*, c.customer_id IS NOT NULL customer_record_joinable, COALESCE(c.customer_rows,0)>1 duplicate_customer_records
    FROM joined j LEFT JOIN customer_ids c ON j.stable_customer_id=c.customer_id
  ) SELECT EXTRACT(YEAR FROM order_timestamp) year, currency,
    COUNT(*) eligible_orders, SUM(sales) eligible_sales,
    COUNTIF(order_customer_id IS NOT NULL) orders_with_explicit_order_customer_id,
    COUNTIF(payment_customer_ids=1) orders_with_one_payment_customer_id,
    COUNTIF(order_customer_id IS NOT NULL AND payment_customer_ids=1) order_payment_id_overlap,
    COUNTIF(id_agreement) order_payment_id_agreement,
    COUNTIF(id_conflict OR payment_customer_ids>1) conflicting_customer_ids,
    COUNTIF(stable_customer_id IS NULL) missing_stable_customer_id,
    COUNTIF(payment_count=0) orders_without_joinable_payment,
    COUNTIF(stable_customer_id IS NOT NULL AND NOT customer_record_joinable) customer_id_without_customer_record,
    COUNTIF(customer_record_joinable) orders_joinable_to_customer_record,
    COUNTIF(duplicate_customer_records) duplicate_customer_record_orders,
    COUNTIF(stable_customer_id IS NOT NULL AND NOT id_conflict AND payment_customer_ids<=1) conservatively_attributable_orders,
    SUM(IF(stable_customer_id IS NOT NULL AND NOT id_conflict AND payment_customer_ids<=1,sales,0)) conservatively_attributable_sales
  FROM enriched GROUP BY year,currency ORDER BY year,currency`;
}

export function buildCustomerProfileQuery(project, dataset, metadata) {
  const s = inspectEvidenceSchema(metadata), c = s.fields.customers;
  const idFields = s.customers ? s.customers.columns.filter(column => /(^id$|_id$|^id_)/i.test(column.column_name)) : [];
  if (!s.customers) return 'WITH absent AS (SELECT 1 WHERE FALSE) SELECT COUNT(*) customer_rows, 0 rows_with_stable_id, 0 distinct_stable_ids, 0 duplicate_stable_id_rows FROM absent';
  const stable = c.id ? idString('c', c.id) : 'CAST(NULL AS STRING)';
  return `WITH customer_profile AS (SELECT ${stable} stable_id FROM ${fq(project, dataset, s.customers.name)} c)
  SELECT COUNT(*) customer_rows, COUNTIF(stable_id IS NOT NULL) rows_with_stable_id,
    COUNT(DISTINCT stable_id) distinct_stable_ids,
    COUNTIF(stable_id IS NOT NULL)-COUNT(DISTINCT stable_id) duplicate_stable_id_rows,
    ${idFields.length} discovered_id_field_count
  FROM customer_profile`;
}

export function buildIdentityIntegrityQuery(project, dataset, metadata) {
  const s = inspectEvidenceSchema(metadata);
  return `WITH ${sources(project, dataset, s)}, customer_trimmed AS (
    SELECT TRIM(customer_id) customer_id FROM customers WHERE customer_id IS NOT NULL GROUP BY 1
  ), customer_casefold AS (
    SELECT LOWER(TRIM(customer_id)) customer_id FROM customers WHERE customer_id IS NOT NULL GROUP BY 1
  ), repeated AS (
    SELECT stable_customer_id, COUNT(*) orders FROM joined WHERE stable_customer_id IS NOT NULL GROUP BY stable_customer_id
  ), order_history AS (
    SELECT order_id, COUNT(DISTINCT order_customer_id) ids FROM raw_orders WHERE order_id IS NOT NULL GROUP BY order_id
  ), payment_history AS (
    SELECT payment_id, COUNT(DISTINCT customer_id) ids FROM payments WHERE payment_id IS NOT NULL GROUP BY payment_id
  ) SELECT
    (SELECT COUNT(DISTINCT stable_customer_id) FROM joined) distinct_transaction_customer_ids,
    (SELECT COUNTIF(orders>=2) FROM repeated) customer_ids_with_2plus_eligible_orders,
    (SELECT COUNT(DISTINCT order_customer_id) FROM orders) distinct_order_customer_ids,
    (SELECT COUNT(DISTINCT customer_id) FROM payments) distinct_payment_customer_ids,
    (SELECT COUNT(DISTINCT customer_id) FROM customers) distinct_customer_record_ids,
    (SELECT MIN(LENGTH(order_customer_id)) FROM orders) order_id_min_length,
    (SELECT MAX(LENGTH(order_customer_id)) FROM orders) order_id_max_length,
    (SELECT COUNTIF(NOT REGEXP_CONTAINS(order_customer_id, r'^[A-Za-z0-9_-]+$')) FROM orders WHERE order_customer_id IS NOT NULL) order_ids_outside_common_shape,
    (SELECT MIN(LENGTH(customer_id)) FROM payments) payment_id_min_length,
    (SELECT MAX(LENGTH(customer_id)) FROM payments) payment_id_max_length,
    (SELECT COUNTIF(NOT REGEXP_CONTAINS(customer_id, r'^[A-Za-z0-9_-]+$')) FROM payments WHERE customer_id IS NOT NULL) payment_ids_outside_common_shape,
    (SELECT MIN(LENGTH(customer_id)) FROM customers) customer_record_id_min_length,
    (SELECT MAX(LENGTH(customer_id)) FROM customers) customer_record_id_max_length,
    (SELECT COUNTIF(NOT REGEXP_CONTAINS(customer_id, r'^[A-Za-z0-9_-]+$')) FROM customers WHERE customer_id IS NOT NULL) customer_record_ids_outside_common_shape,
    COUNTIF(order_customer_id IS NOT NULL AND payment_customer_ids=1) order_payment_comparable_orders,
    COUNTIF(id_agreement) exact_order_payment_id_matches,
    COUNTIF(order_customer_id IS NOT NULL AND payment_customer_ids=1 AND TRIM(order_customer_id)=TRIM(payment_customer_id) AND order_customer_id!=payment_customer_id) trimmed_order_payment_matches_only,
    COUNTIF(order_customer_id IS NOT NULL AND payment_customer_ids=1 AND LOWER(TRIM(order_customer_id))=LOWER(TRIM(payment_customer_id)) AND TRIM(order_customer_id)!=TRIM(payment_customer_id)) casefold_order_payment_matches_only,
    COUNTIF(order_customer_id IS NOT NULL AND payment_customer_ids=1 AND order_customer_id!=payment_customer_id) order_payment_id_disagreements,
    COUNTIF(payment_customer_ids>1) orders_with_multiple_payment_customer_ids,
    COUNTIF(stable_customer_id IS NOT NULL AND c.customer_id IS NOT NULL) exact_customer_record_matches,
    COUNTIF(stable_customer_id IS NOT NULL AND c.customer_id IS NULL AND ct.customer_id IS NOT NULL) trimmed_customer_record_matches_only,
    COUNTIF(stable_customer_id IS NOT NULL AND ct.customer_id IS NULL AND cc.customer_id IS NOT NULL) casefold_customer_record_matches_only,
    COUNTIF(stable_customer_id IS NOT NULL AND cc.customer_id IS NULL) no_customer_record_in_any_format,
    (SELECT COUNTIF(ids>1) FROM order_history) order_ids_with_customer_change_over_time,
    (SELECT COUNTIF(ids>1) FROM payment_history) payment_ids_with_customer_change_over_time,
    (SELECT COUNTIF(customer_rows>1) FROM customer_ids) duplicated_customer_ids
  FROM joined j
  LEFT JOIN customer_ids c ON j.stable_customer_id=c.customer_id
  LEFT JOIN customer_trimmed ct ON TRIM(j.stable_customer_id)=ct.customer_id
  LEFT JOIN customer_casefold cc ON LOWER(TRIM(j.stable_customer_id))=cc.customer_id`;
}

export function assertReadOnlyAggregate(query) {
  if (!/^WITH\b/i.test(query.trim()) || WRITE.test(query)) throw new Error('Diagnostic refused non-read-only SQL');
  if (/SELECT\s+(?:\w+\.)?\*\s+FROM\s+(?:orders|payments|customers|joined|enriched)/i.test(query)) throw new Error('Diagnostic refused row-level output');
}

const descriptor = column => column ? { column: column.column_name, data_type: column.data_type } : null;

export async function runDiagnostic({ bigquery, project, dataset = 'square_data' }) {
  const metadata = await atStage('schema discovery', async () => (await bigquery.query({ query: metadataQuery(project, dataset), useLegacySql: false }))[0]);
  const schema = await atStage('schema validation', async () => inspectEvidenceSchema(metadata));
  const queries = [buildCustomerProfileQuery(project, dataset, metadata), buildIdentityIntegrityQuery(project, dataset, metadata), buildAttributionQuery(project, dataset, metadata)];
  queries.forEach(assertReadOnlyAggregate);
  const results = [];
  for (const [index, query] of queries.entries()) results.push(await atStage(['customer table profile','ID integrity query','annual attribution query'][index], async () =>
    (await bigquery.query({ query, useLegacySql: false, labels: { component: 'square_customer_attribution', operation: 'aggregate_audit' }, maximumBytesBilled: '20000000000' }))[0]));
  const customerIdFields = schema.customers?.columns.filter(column => /(^id$|_id$|^id_)/i.test(column.column_name)).map(descriptor) || [];
  const m = schema.fields.orders.money;
  const amountSource = m.object || m.amount;
  const squareMoneyPath = Boolean(m.object || m.amount?.column_name.toLowerCase().includes('money'));
  return {
    safety: { read_only: true, aggregate_only: true, pii_free_output: true, production_writes: false },
    persisted_schema: {
      customers_table_present: Boolean(schema.customers), customer_id_fields: customerIdFields,
      order_customer_id_field: descriptor(schema.fields.orders.customerId), payment_customer_id_field: descriptor(schema.fields.payments?.customerId),
      order_amount_field: descriptor(amountSource), order_currency_field: descriptor(m.currency || m.object)
    },
    customer_table: results[0][0] || {}, id_integrity: results[1][0] || {}, annual_evidence: results[2],
    money_contract: {
      extraction: m.object ? 'total_money.amount and total_money.currency from persisted Square Money JSON' : 'persisted flattened order money columns',
      amount_unit: squareMoneyPath ? 'smallest denomination of the currency (Square Money.amount contract; usually minor units)' : 'unknown: owning ingestion contract must identify this field before values are interpreted',
      currency_policy: 'Extract currency from the same order Money object or its persisted flattened currency field; keep each original currency separate.',
      source_contract: 'https://developer.squareup.com/reference/square/objects/Money'
    },
    ownership_assessment: 'This repository contains no Square extractor or raw-table DDL. Missing customer rows/fields or money components are an owning-ingestion-service issue; nonzero format-only matches indicate a query normalization issue. Do not backfill or add Square to journeys from this audit.',
    smallest_supported_next_task: 'Run this diagnostic in production; if exact matches remain zero and format-only matches are zero, locate the owning Square ingestion service and add an aggregate customers endpoint/table completeness check plus total_money field mapping before any journey work.'
  };
}

class DiagnosticStageError extends Error {
  constructor(stage, cause) { super(`Square customer-attribution diagnostic failed during ${stage}`); this.name = 'DiagnosticStageError'; this.stage = stage; this.cause = cause; }
}
async function atStage(stage, operation) { try { return await operation(); } catch (error) { throw new DiagnosticStageError(stage, error); } }
const safeToken = value => /^[A-Za-z0-9_.-]{1,64}$/.test(String(value ?? '')) ? String(value) : null;
export function formatDiagnosticFailure(error, fallbackStage = 'startup') {
  const stage = error instanceof DiagnosticStageError ? error.stage : fallbackStage;
  const cause = error instanceof DiagnosticStageError ? error.cause : error;
  const apiError = Array.isArray(cause?.errors) ? cause.errors[0] : undefined;
  const details = [safeToken(apiError?.reason ?? cause?.reason) && `reason: ${safeToken(apiError?.reason ?? cause?.reason)}`, safeToken(cause?.code) && `code: ${safeToken(cause?.code)}`].filter(Boolean);
  return `Square customer-attribution diagnostic failed during ${stage}${details.length ? ` (${details.join(', ')})` : ''}.`;
}

async function main() {
  let stage = 'argument parsing';
  try {
    const options = parseArgs(process.argv.slice(2)); stage = 'credential configuration';
    const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
    stage = 'diagnostic execution';
    const result = await runDiagnostic({ ...options, bigquery: new BigQuery({ projectId: options.project, credentials }) });
    process.stdout.write(`${JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`);
  } catch (error) { process.stderr.write(`${formatDiagnosticFailure(error, stage)}\n`); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
