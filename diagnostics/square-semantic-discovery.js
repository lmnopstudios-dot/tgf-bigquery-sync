#!/usr/bin/env node

/**
 * Read-only discovery of persisted Square data and its finance integration.
 *
 * This intentionally discovers the schema before constructing profile queries: Square table
 * names and columns are not encoded in this repository. Every submitted statement is SELECT or
 * WITH, and the diagnostic never calls a Square API or creates/mutates a BigQuery object.
 */
import { BigQuery } from '@google-cloud/bigquery';

const SCALAR_TYPES = new Set([
  'STRING', 'BYTES', 'INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC', 'BOOL',
  'TIMESTAMP', 'DATE', 'DATETIME', 'TIME', 'GEOGRAPHY'
]);
const ID_PATTERN = /(^id$|_id$|^id_|uuid|token$)/i;
const TIME_PATTERN = /(^|_)(created|updated|closed|opened|completed|processed|refunded|occurred|transaction|business|synced)?_?(at|date|time|timestamp)$/i;
const MONEY_PATTERN = /(amount|money|gross|net|total|tax|tip|discount|service_charge|refund)/i;
const STATE_PATTERN = /(state|status|currency|tender|card_brand|payment_method)/i;

function quote(value) { return `\`${String(value).replaceAll('`', '')}\``; }
function fq(project, dataset, table) { return quote(`${project}.${dataset}.${table}`); }
function assertIdentifier(value, label) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}
function isScalar(column) { return SCALAR_TYPES.has(column.data_type); }
function first(columns, names) {
  return names.map(name => columns.find(column => column.column_name.toLowerCase() === name)).find(Boolean);
}
function role(name) {
  const n = name.toLowerCase();
  if (/line.*item|order.*item/.test(n)) return 'line_items';
  if (/refund/.test(n)) return 'refunds';
  if (/payment|tender|transaction/.test(n)) return 'payments';
  if (/inventor/.test(n)) return 'inventory';
  if (/location/.test(n)) return 'locations';
  if (/variation/.test(n)) return 'variations';
  if (/categor/.test(n)) return 'categories';
  if (/catalog.*item|^items?$/.test(n)) return 'catalog_items';
  if (/customer/.test(n)) return 'customers';
  if (/team|staff|employee/.test(n)) return 'team_members';
  if (/order/.test(n)) return 'orders';
  return 'other';
}
function primaryColumn(table, columns) {
  const singular = table.replace(/ies$/i, 'y').replace(/s$/i, '');
  return first(columns, [`${singular}_id`, 'line_item_id', 'id']) || null;
}
function jsonValue(value) {
  return value && typeof value === 'object' && 'value' in value ? value.value : value;
}

export function parseArgs(argv) {
  const options = { project: process.env.GOOGLE_PROJECT_ID || 'gf-full-data', dataset: 'square_data', financeDataset: 'finance' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') options.project = argv[++i];
    else if (argv[i] === '--dataset') options.dataset = argv[++i];
    else if (argv[i] === '--finance-dataset') options.financeDataset = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  assertIdentifier(options.project, 'project');
  assertIdentifier(options.dataset, 'dataset');
  assertIdentifier(options.financeDataset, 'finance dataset');
  return options;
}

export function buildMetadataQuery(project, dataset) {
  return `SELECT t.table_name, t.table_type, c.column_name, c.ordinal_position,
    c.is_nullable, c.data_type
  FROM ${fq(project, dataset, 'INFORMATION_SCHEMA.TABLES')} t
  LEFT JOIN ${fq(project, dataset, 'INFORMATION_SCHEMA.COLUMNS')} c USING (table_name)
  ORDER BY t.table_name, c.ordinal_position`;
}

function profileQuery(project, dataset, table, columns) {
  const scalarIds = columns.filter(c => isScalar(c) && ID_PATTERN.test(c.column_name));
  const times = columns.filter(c => isScalar(c) && ['TIMESTAMP', 'DATE', 'DATETIME'].includes(c.data_type) &&
    (TIME_PATTERN.test(c.column_name) || /(created|updated|date|time|synced)/i.test(c.column_name)));
  const important = columns.filter(c => isScalar(c) && (ID_PATTERN.test(c.column_name) || /currency|location|state|status|sku|name/i.test(c.column_name)));
  const primary = primaryColumn(table, columns);
  const select = ['COUNT(*) AS row_count'];
  if (primary) {
    select.push(`COUNT(DISTINCT ${quote(primary.column_name)}) AS distinct_primary_ids`);
    select.push(`COUNT(*) - COUNT(DISTINCT ${quote(primary.column_name)}) AS duplicate_primary_id_rows`);
  }
  for (const c of times) {
    select.push(`MIN(${quote(c.column_name)}) AS ${quote(`min__${c.column_name}`)}`);
    select.push(`MAX(${quote(c.column_name)}) AS ${quote(`max__${c.column_name}`)}`);
  }
  for (const c of important) {
    select.push(`COUNTIF(${quote(c.column_name)} IS NULL) AS ${quote(`nulls__${c.column_name}`)}`);
  }
  return { primary: primary?.column_name || null, sql: `SELECT\n  ${select.join(',\n  ')}\nFROM ${fq(project, dataset, table)}` };
}

function distributionQueries(project, dataset, table, columns) {
  return columns.filter(c => isScalar(c) && (STATE_PATTERN.test(c.column_name) || /^location_id$/i.test(c.column_name)))
    .map(c => ({ column: c.column_name, sql: `SELECT CAST(${quote(c.column_name)} AS STRING) AS value, COUNT(*) AS row_count
      FROM ${fq(project, dataset, table)} GROUP BY value ORDER BY row_count DESC LIMIT 100` }));
}

const RELATIONS = [
  ['orders', 'line_items', ['order_id'], ['order_id']],
  ['locations', 'orders', ['location_id', 'id'], ['location_id']],
  ['orders', 'payments', ['order_id', 'id'], ['order_id']],
  ['orders', 'refunds', ['order_id', 'id'], ['order_id']],
  ['payments', 'refunds', ['payment_id', 'id'], ['payment_id']],
  ['catalog_items', 'line_items', ['catalog_object_id', 'item_id', 'id'], ['catalog_object_id', 'item_id', 'catalog_item_id']],
  ['variations', 'line_items', ['variation_id', 'catalog_object_id', 'id'], ['variation_id', 'catalog_object_id', 'catalog_variation_id']],
  ['customers', 'orders', ['customer_id', 'id'], ['customer_id']],
  ['customers', 'payments', ['customer_id', 'id'], ['customer_id']],
  ['team_members', 'orders', ['team_member_id', 'employee_id', 'id'], ['team_member_id', 'employee_id']],
  ['team_members', 'payments', ['team_member_id', 'employee_id', 'id'], ['team_member_id', 'employee_id']],
  ['locations', 'inventory', ['location_id', 'id'], ['location_id']],
  ['variations', 'inventory', ['variation_id', 'catalog_object_id', 'id'], ['variation_id', 'catalog_object_id', 'catalog_variation_id']]
];

function relationshipQueries(project, dataset, tables) {
  const output = [];
  for (const [parentRole, childRole, parentNames, childNames] of RELATIONS) {
    for (const parent of tables.filter(t => t.role === parentRole)) {
      for (const child of tables.filter(t => t.role === childRole)) {
        const pk = first(parent.columns, parentNames);
        const fk = first(child.columns, childNames);
        if (!pk || !fk || !isScalar(pk) || !isScalar(fk)) continue;
        output.push({ relation: `${parent.name}.${pk.column_name} -> ${child.name}.${fk.column_name}`, sql: `WITH p AS (
            SELECT CAST(${quote(pk.column_name)} AS STRING) k, COUNT(*) n FROM ${fq(project, dataset, parent.name)}
            WHERE ${quote(pk.column_name)} IS NOT NULL GROUP BY k
          ), c AS (
            SELECT CAST(${quote(fk.column_name)} AS STRING) k, COUNT(*) n FROM ${fq(project, dataset, child.name)}
            WHERE ${quote(fk.column_name)} IS NOT NULL GROUP BY k
          )
          SELECT (SELECT SUM(n) FROM c) child_rows_with_key,
            (SELECT COUNT(*) FROM c) distinct_child_keys,
            (SELECT COUNT(*) FROM p) distinct_parent_keys,
            (SELECT COUNTIF(n > 1) FROM p) duplicate_parent_keys,
            (SELECT COALESCE(SUM(c.n), 0) FROM c LEFT JOIN p USING(k) WHERE p.k IS NULL) orphan_child_rows,
            (SELECT COUNT(*) FROM c LEFT JOIN p USING(k) WHERE p.k IS NULL) orphan_distinct_keys,
            (SELECT COUNT(*) FROM c JOIN p USING(k)) matched_distinct_keys` });
      }
    }
  }
  return output;
}

function monthlyQuery(project, dataset, table) {
  const time = first(table.columns, ['created_at', 'created_date', 'closed_at', 'updated_at', 'timestamp']);
  const location = first(table.columns, ['location_id']);
  if (!time || !location || !['TIMESTAMP', 'DATE', 'DATETIME'].includes(time.data_type)) return null;
  return `SELECT DATE_TRUNC(DATE(${quote(time.column_name)}), MONTH) month,
    CAST(${quote(location.column_name)} AS STRING) location_id, COUNT(*) row_count
    FROM ${fq(project, dataset, table.name)} GROUP BY month, location_id ORDER BY month, location_id`;
}

function monetaryQuery(project, dataset, table) {
  const fields = table.columns.filter(c => isScalar(c) && ['INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'].includes(c.data_type) && MONEY_PATTERN.test(c.column_name));
  if (!fields.length) return null;
  return `SELECT ${fields.flatMap(c => [`COUNT(${quote(c.column_name)}) AS ${quote(`count__${c.column_name}`)}`, `SUM(${quote(c.column_name)}) AS ${quote(`sum__${c.column_name}`)}`]).join(', ')} FROM ${fq(project, dataset, table.name)}`;
}

function locationCoverageQuery(project, dataset, table) {
  const location = first(table.columns, ['location_id']);
  const time = first(table.columns, ['created_at', 'created_date', 'closed_at', 'processed_at', 'timestamp']);
  if (!location || !time || !isScalar(location) || !['TIMESTAMP', 'DATE', 'DATETIME'].includes(time.data_type)) return null;
  const amounts = table.columns.filter(c => isScalar(c) && ['INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'].includes(c.data_type) && MONEY_PATTERN.test(c.column_name));
  return `SELECT CAST(${quote(location.column_name)} AS STRING) location_id, COUNT(*) row_count,
    MIN(${quote(time.column_name)}) earliest_at, MAX(${quote(time.column_name)}) latest_at${amounts.length ? `, ${amounts.map(c => `SUM(${quote(c.column_name)}) AS ${quote(`sum__${c.column_name}`)}`).join(', ')}` : ''}
    FROM ${fq(project, dataset, table.name)} GROUP BY location_id ORDER BY location_id`;
}

async function query(bigquery, sql) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Diagnostic refused a non-read-only statement');
  const [rows] = await bigquery.query({ query: sql, useLegacySql: false });
  return rows;
}

export async function runDiagnostic({ bigquery, project, dataset = 'square_data', financeDataset = 'finance' }) {
  const metadata = await query(bigquery, buildMetadataQuery(project, dataset));
  const byTable = new Map();
  for (const row of metadata) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, { name: row.table_name, type: row.table_type, columns: [] });
    if (row.column_name) byTable.get(row.table_name).columns.push(row);
  }
  const tables = [...byTable.values()].map(table => ({ ...table, role: role(table.name) }));
  const profiles = [];
  for (const table of tables) {
    const built = profileQuery(project, dataset, table.name, table.columns);
    const [summary] = await query(bigquery, built.sql);
    const distributions = {};
    for (const item of distributionQueries(project, dataset, table.name, table.columns)) distributions[item.column] = await query(bigquery, item.sql);
    const monetary = monetaryQuery(project, dataset, table);
    profiles.push({ table: table.name, table_type: table.type, inferred_role: table.role, primary_id_candidate: built.primary,
      schema: table.columns.map(({ column_name, ordinal_position, is_nullable, data_type }) => ({ column_name, ordinal_position, is_nullable, data_type })),
      summary, distributions, monetary_summary: monetary ? (await query(bigquery, monetary))[0] : null });
  }
  const relationships = [];
  for (const item of relationshipQueries(project, dataset, tables)) relationships.push({ relation: item.relation, ...(await query(bigquery, item.sql))[0] });
  const monthly_coverage = {};
  const location_coverage = {};
  for (const table of tables.filter(t => t.role === 'orders' || t.role === 'payments')) {
    const sql = monthlyQuery(project, dataset, table);
    if (sql) monthly_coverage[table.name] = await query(bigquery, sql);
    const locationSql = locationCoverageQuery(project, dataset, table);
    if (locationSql) location_coverage[table.name] = await query(bigquery, locationSql);
  }
  const financeViews = await query(bigquery, `SELECT table_name, view_definition
    FROM ${fq(project, financeDataset, 'INFORMATION_SCHEMA.VIEWS')}
    WHERE table_name IN ('sales_master', 'accountant_transactions') ORDER BY table_name`);
  const financeColumns = await query(bigquery, `SELECT table_name, column_name, ordinal_position, data_type
    FROM ${fq(project, financeDataset, 'INFORMATION_SCHEMA.COLUMNS')}
    WHERE table_name IN ('sales_master', 'accountant_transactions') ORDER BY table_name, ordinal_position`);
  return { diagnostic: 'square_semantic_discovery', generated_at: new Date().toISOString(),
    safety: { read_only: true, square_api_calls: false, ingestion_run: false, bigquery_writes: false },
    scope: { project, dataset, finance_dataset: financeDataset }, tables: profiles, relationships,
    monthly_coverage, location_coverage, finance: { views: financeViews, columns: financeColumns },
    caveat: 'Candidates and roles are name-based discovery aids. Review schemas and relationship evidence before adopting semantics.' };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) : undefined;
  const result = await runDiagnostic({ ...options, bigquery: new BigQuery({ projectId: options.project, credentials }) });
  process.stdout.write(`${JSON.stringify(result, (_key, value) => jsonValue(value), 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
