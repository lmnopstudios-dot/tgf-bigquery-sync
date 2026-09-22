#!/usr/bin/env node

import { BigQuery } from '@google-cloud/bigquery';

const SEMANTIC_VIEWS = ['retail_locations', 'retail_orders', 'retail_order_items', 'retail_returns', 'retail_payments'];
const q = value => `\`${String(value).replaceAll('`', '')}\``;
const fq = (project, dataset, table) => q(`${project}.${dataset}.${table}`);
const id = (value, label) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
};
const col = (table, names) => names.map(name => table.columns.find(c => c.column_name.toLowerCase() === name)).find(Boolean);
const ref = (alias, column) => column ? `${alias}.${q(column.column_name)}` : null;
const str = (alias, column) => column ? `CAST(${ref(alias, column)} AS STRING)` : 'CAST(NULL AS STRING)';
const ts = (alias, column) => column ? `SAFE_CAST(${ref(alias, column)} AS TIMESTAMP)` : 'CAST(NULL AS TIMESTAMP)';
const num = (alias, column) => column ? `SAFE_CAST(${ref(alias, column)} AS NUMERIC)` : 'CAST(NULL AS NUMERIC)';
const jsonArray = (alias, column) => column
  ? `IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(CAST(${ref(alias, column)} AS STRING)), '$'), [])`
  : 'ARRAY<JSON>[]';
const jstr = (alias, paths) => `COALESCE(${paths.map(path => `JSON_VALUE(${alias}, '${path}')`).join(', ')})`;
const jnum = (alias, paths) => `SAFE_CAST(${jstr(alias, paths)} AS NUMERIC)`;

export function parseArgs(argv) {
  const out = { project: process.env.GOOGLE_PROJECT_ID || 'gf-full-data', dataset: 'square_data' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') out.project = argv[++i];
    else if (argv[i] === '--dataset') out.dataset = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  id(out.project, 'project'); id(out.dataset, 'dataset');
  return out;
}

export function metadataQuery(project, dataset) {
  return `SELECT t.table_name, t.table_type, c.column_name, c.data_type, c.ordinal_position
FROM ${fq(project, dataset, 'INFORMATION_SCHEMA.TABLES')} t
JOIN ${fq(project, dataset, 'INFORMATION_SCHEMA.COLUMNS')} c USING (table_name)
WHERE t.table_name NOT IN (${SEMANTIC_VIEWS.map(name => `'${name}'`).join(', ')})
ORDER BY t.table_name, c.ordinal_position`;
}

function tablesFrom(rows) {
  const tables = new Map();
  for (const row of rows) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, { name: row.table_name, type: row.table_type, columns: [] });
    tables.get(row.table_name).columns.push(row);
  }
  return tables;
}
function required(tables, name, columns) {
  const table = tables.get(name);
  if (!table) throw new Error(`Required source table ${name} was not found`);
  for (const names of columns) if (!col(table, names)) throw new Error(`${name} requires one of: ${names.join(', ')}`);
  return table;
}
function create(project, dataset, name, select) {
  return `CREATE OR REPLACE VIEW ${fq(project, dataset, name)}\nOPTIONS(description="Oracle operational Square retail semantics; not finance.sales_master")\nAS\n${select}`;
}

export function buildSemanticViews({ project, dataset = 'square_data', metadata }) {
  id(project, 'project'); id(dataset, 'dataset');
  const tables = tablesFrom(metadata);
  const orders = required(tables, 'orders', [['order_id', 'id'], ['location_id'], ['line_items']]);
  const locations = tables.get('locations');
  const payments = tables.get('payments');
  const oid = col(orders, ['order_id', 'id']);
  const oloc = col(orders, ['location_id']);
  const lines = col(orders, ['line_items']);
  const returns = col(orders, ['returns', 'return_line_items']);
  const created = col(orders, ['created_at']);
  const updated = col(orders, ['updated_at']);
  const closed = col(orders, ['closed_at', 'completed_at']);
  const state = col(orders, ['state', 'status']);
  const source = col(orders, ['source_name', 'source', 'source_type']);
  const currency = col(orders, ['currency']);
  const total = col(orders, ['total_money_amount', 'total_amount', 'total']);
  const discount = col(orders, ['total_discount_money_amount', 'discount_amount', 'discounts']);
  const tax = col(orders, ['total_tax_money_amount', 'tax_amount', 'taxes']);

  const locationId = locations && col(locations, ['location_id', 'id']);
  const locationName = locations && col(locations, ['name', 'location_name']);
  const observedLocations = `SELECT DISTINCT ${str('o', oloc)} location_id FROM ${fq(project, dataset, orders.name)} o WHERE ${ref('o', oloc)} IS NOT NULL`;
  const locationSelect = locations && locationId ? `WITH observed AS (${observedLocations}), metadata AS (
    SELECT * FROM ${fq(project, dataset, locations.name)} l
    QUALIFY ROW_NUMBER() OVER (PARTITION BY ${str('l', locationId)} ORDER BY TO_JSON_STRING(l) DESC) = 1
  ) SELECT observed.location_id,
    COALESCE(${str('m', locationName)}, observed.location_id) location_name,
    ${str('m', col(locations, ['status', 'state']))} location_status,
    ${str('m', col(locations, ['timezone', 'time_zone']))} timezone,
    ${str('m', col(locations, ['currency']))} currency,
    ${ts('m', col(locations, ['created_at']))} created_at,
    ${locationName ? `${ref('m', locationName)} IS NOT NULL` : 'FALSE'} has_persisted_location_metadata
  FROM observed LEFT JOIN metadata m ON observed.location_id = ${str('m', locationId)}` : `SELECT location_id, location_id location_name,
    CAST(NULL AS STRING) location_status, CAST(NULL AS STRING) timezone, CAST(NULL AS STRING) currency,
    CAST(NULL AS TIMESTAMP) created_at, FALSE has_persisted_location_metadata FROM (${observedLocations})`;

  const lineArray = jsonArray('o', lines);
  const orderSelect = `WITH base AS (
    SELECT o.*, ARRAY_LENGTH(${lineArray}) semantic_line_item_count,
      (SELECT SUM(SAFE_CAST(JSON_VALUE(line, '$.quantity') AS NUMERIC)) FROM UNNEST(${lineArray}) line) semantic_unit_quantity
    FROM ${fq(project, dataset, orders.name)} o
  ) SELECT ${str('o', oid)} order_id, ${str('o', oloc)} location_id, l.location_name,
    ${ts('o', created)} created_at, ${ts('o', updated)} updated_at, ${ts('o', closed)} closed_at,
    ${str('o', state)} order_state, COALESCE(${str('o', currency)}, ${total ? `JSON_VALUE(SAFE.PARSE_JSON(CAST(${ref('o', total)} AS STRING)), '$.currency')` : 'NULL'}) currency,
    ${num('o', total)} transaction_order_total_amount, ${num('o', discount)} transaction_discount_amount,
    ${num('o', tax)} transaction_tax_amount, o.semantic_line_item_count line_item_count,
    o.semantic_unit_quantity unit_quantity, ${str('o', source)} source_name,
    ${returns ? `ARRAY_LENGTH(${jsonArray('o', returns)}) > 0` : 'FALSE'} has_return_evidence,
    'OPERATIONAL_SQUARE_ORDER_NOT_FINANCE_LEDGER' monetary_metric_scope
  FROM base o LEFT JOIN ${fq(project, dataset, 'retail_locations')} l ON ${str('o', oloc)} = l.location_id`;

  const itemSelect = `SELECT ${str('o', oid)} order_id, ${jstr('line', ['$.uid', '$.id'])} line_item_uid,
    ${str('o', oloc)} location_id, l.location_name, ${ts('o', created)} order_timestamp,
    DATE(${ts('o', created)}) order_date, ${jstr('line', ['$.name', '$.item_name'])} transaction_item_name,
    ${jstr('line', ['$.variation_name'])} transaction_variation_name,
    ${jstr('line', ['$.catalog_object_id'])} catalog_object_id,
    ${jstr('line', ['$.item_id'])} catalog_item_id,
    ${jstr('line', ['$.catalog_variation_id', '$.variation_id'])} catalog_variation_id,
    ${jstr('line', ['$.sku'])} transaction_sku, ${jnum('line', ['$.quantity'])} quantity,
    ${jnum('line', ['$.base_price_money.amount', '$.base_price.amount'])} base_price_amount,
    ${jnum('line', ['$.gross_sales_money.amount', '$.gross_sales.amount'])} gross_line_amount,
    ${jnum('line', ['$.total_discount_money.amount', '$.discount_money.amount'])} discount_amount,
    ${jnum('line', ['$.total_tax_money.amount', '$.tax_money.amount'])} tax_amount,
    ${jnum('line', ['$.total_money.amount', '$.total_price_money.amount'])} total_amount,
    COALESCE(${jstr('line', ['$.total_money.currency', '$.base_price_money.currency'])}, ${str('o', currency)}) currency,
    ${jstr('line', ['$.item_type'])} item_type,
    line_offset source_line_offset, TO_JSON_STRING(line) transaction_line_item_json
  FROM ${fq(project, dataset, orders.name)} o, UNNEST(${lineArray}) line WITH OFFSET line_offset
  LEFT JOIN ${fq(project, dataset, 'retail_locations')} l ON ${str('o', oloc)} = l.location_id`;

  let returnSelect;
  if (returns?.column_name.toLowerCase() === 'returns') {
    const returnArray = jsonArray('o', returns);
    returnSelect = `SELECT ${str('o', oid)} containing_order_id,
      COALESCE(${jstr('ret', ['$.source_order_id'])}, ${str('o', oid)}) source_order_id,
      ${jstr('ret', ['$.uid', '$.id'])} return_uid, ${jstr('rline', ['$.uid', '$.id'])} return_line_uid,
      ${jstr('rline', ['$.source_line_item_uid', '$.source_line_item_id'])} source_line_item_uid,
      ${str('o', oloc)} location_id, l.location_name,
      COALESCE(SAFE_CAST(${jstr('ret', ['$.created_at', '$.updated_at'])} AS TIMESTAMP), ${ts('o', updated)}, ${ts('o', created)}) return_timestamp,
      DATE(COALESCE(SAFE_CAST(${jstr('ret', ['$.created_at', '$.updated_at'])} AS TIMESTAMP), ${ts('o', updated)}, ${ts('o', created)})) return_date,
      ${jstr('rline', ['$.name', '$.item_name'])} transaction_item_name, ${jstr('rline', ['$.variation_name'])} transaction_variation_name,
      ${jstr('rline', ['$.catalog_object_id', '$.item_id'])} catalog_object_id, ${jnum('rline', ['$.quantity'])} quantity,
      ${jnum('rline', ['$.base_price_money.amount', '$.base_price.amount'])} base_price_amount,
      ${jnum('rline', ['$.gross_return_money.amount', '$.gross_sales_money.amount'])} gross_return_amount,
      ${jnum('rline', ['$.total_discount_money.amount'])} discount_amount, ${jnum('rline', ['$.total_tax_money.amount'])} tax_amount,
      ${jnum('rline', ['$.total_money.amount'])} total_return_amount,
      COALESCE(${jstr('rline', ['$.total_money.currency', '$.base_price_money.currency'])}, ${str('o', currency)}) currency,
      ${jstr('rline', ['$.item_type'])} item_type, return_offset source_return_offset, line_offset source_return_line_offset
    FROM ${fq(project, dataset, orders.name)} o, UNNEST(${returnArray}) ret WITH OFFSET return_offset,
      UNNEST(IFNULL(JSON_QUERY_ARRAY(ret, '$.return_line_items'), [])) rline WITH OFFSET line_offset
    LEFT JOIN ${fq(project, dataset, 'retail_locations')} l ON ${str('o', oloc)} = l.location_id`;
  } else if (returns) {
    returnSelect = `SELECT ${str('o', oid)} containing_order_id, ${str('o', oid)} source_order_id,
      CAST(NULL AS STRING) return_uid, ${jstr('rline', ['$.uid', '$.id'])} return_line_uid,
      ${jstr('rline', ['$.source_line_item_uid', '$.source_line_item_id'])} source_line_item_uid,
      ${str('o', oloc)} location_id, l.location_name, COALESCE(${ts('o', updated)}, ${ts('o', created)}) return_timestamp,
      DATE(COALESCE(${ts('o', updated)}, ${ts('o', created)})) return_date,
      ${jstr('rline', ['$.name', '$.item_name'])} transaction_item_name, ${jstr('rline', ['$.variation_name'])} transaction_variation_name,
      ${jstr('rline', ['$.catalog_object_id', '$.item_id'])} catalog_object_id, ${jnum('rline', ['$.quantity'])} quantity,
      ${jnum('rline', ['$.base_price_money.amount'])} base_price_amount, ${jnum('rline', ['$.gross_return_money.amount', '$.gross_sales_money.amount'])} gross_return_amount,
      ${jnum('rline', ['$.total_discount_money.amount'])} discount_amount, ${jnum('rline', ['$.total_tax_money.amount'])} tax_amount,
      ${jnum('rline', ['$.total_money.amount'])} total_return_amount, ${jstr('rline', ['$.total_money.currency', '$.base_price_money.currency'])} currency,
      ${jstr('rline', ['$.item_type'])} item_type, 0 source_return_offset, line_offset source_return_line_offset
    FROM ${fq(project, dataset, orders.name)} o, UNNEST(${jsonArray('o', returns)}) rline WITH OFFSET line_offset
    LEFT JOIN ${fq(project, dataset, 'retail_locations')} l ON ${str('o', oloc)} = l.location_id`;
  } else {
    returnSelect = `SELECT CAST(NULL AS STRING) containing_order_id, CAST(NULL AS STRING) source_order_id,
      CAST(NULL AS STRING) return_uid, CAST(NULL AS STRING) return_line_uid, CAST(NULL AS STRING) source_line_item_uid,
      CAST(NULL AS STRING) location_id, CAST(NULL AS STRING) location_name, CAST(NULL AS TIMESTAMP) return_timestamp,
      CAST(NULL AS DATE) return_date, CAST(NULL AS STRING) transaction_item_name, CAST(NULL AS STRING) transaction_variation_name,
      CAST(NULL AS STRING) catalog_object_id, CAST(NULL AS NUMERIC) quantity, CAST(NULL AS NUMERIC) base_price_amount,
      CAST(NULL AS NUMERIC) gross_return_amount, CAST(NULL AS NUMERIC) discount_amount, CAST(NULL AS NUMERIC) tax_amount,
      CAST(NULL AS NUMERIC) total_return_amount, CAST(NULL AS STRING) currency, CAST(NULL AS STRING) item_type,
      CAST(NULL AS INT64) source_return_offset, CAST(NULL AS INT64) source_return_line_offset WHERE FALSE`;
  }

  const views = [
    { name: 'retail_locations', sql: create(project, dataset, 'retail_locations', locationSelect) },
    { name: 'retail_orders', sql: create(project, dataset, 'retail_orders', orderSelect) },
    { name: 'retail_order_items', sql: create(project, dataset, 'retail_order_items', itemSelect) },
    { name: 'retail_returns', sql: create(project, dataset, 'retail_returns', returnSelect) }
  ];
  if (payments) {
    const pid = col(payments, ['payment_id', 'id']);
    if (pid) views.push({ name: 'retail_payments', sql: create(project, dataset, 'retail_payments', `SELECT ${str('p', pid)} payment_id,
      ${str('p', col(payments, ['order_id']))} order_id, ${str('p', col(payments, ['location_id']))} location_id,
      l.location_name, ${ts('p', col(payments, ['created_at', 'processed_at']))} payment_timestamp,
      ${num('p', col(payments, ['amount', 'amount_money_amount', 'total_money_amount']))} amount,
      ${str('p', col(payments, ['currency']))} currency, ${str('p', col(payments, ['status', 'state']))} payment_status,
      ${str('p', col(payments, ['tender_type', 'source_type', 'payment_type']))} tender_type
    FROM ${fq(project, dataset, payments.name)} p
    LEFT JOIN ${fq(project, dataset, 'retail_locations')} l ON ${str('p', col(payments, ['location_id']))} = l.location_id`) });
  }
  return views;
}

export async function deploy({ bigquery, project, dataset = 'square_data' }) {
  const [metadata] = await bigquery.query({ query: metadataQuery(project, dataset), useLegacySql: false });
  const views = buildSemanticViews({ project, dataset, metadata });
  for (const view of views) await bigquery.query({ query: view.sql, useLegacySql: false });
  return views.map(view => view.name);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const created = await deploy({ ...options, bigquery: new BigQuery({ projectId: options.project, credentials }) });
  process.stdout.write(`Created ${created.map(name => `${options.dataset}.${name}`).join(', ')}\n`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(error => { console.error(error); process.exitCode = 1; });
