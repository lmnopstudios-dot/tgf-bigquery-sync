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

function tableForRole(tables, wantedRole, preferredName = wantedRole) {
  return tables.find(table => table.name.toLowerCase() === preferredName) || tables.find(table => table.role === wantedRole);
}
function column(table, names) { return table ? first(table.columns, names) : null; }
function numeric(column) { return column && ['INT64', 'FLOAT64', 'NUMERIC', 'BIGNUMERIC'].includes(column.data_type); }
function dateExpression(column) {
  if (!column) return null;
  if (column.data_type === 'DATE') return quote(column.column_name);
  if (['TIMESTAMP', 'DATETIME'].includes(column.data_type)) return `DATE(${quote(column.column_name)})`;
  return `SAFE_CAST(${quote(column.column_name)} AS DATE)`;
}
function castNumber(column) { return column ? `SAFE_CAST(${quote(column.column_name)} AS NUMERIC)` : 'NULL'; }
function moneyAmount(column) {
  if (!column) return 'NULL';
  if (numeric(column)) return castNumber(column);
  return `SAFE_CAST(JSON_VALUE(SAFE.PARSE_JSON(CAST(${quote(column.column_name)} AS STRING)), '$.amount') AS NUMERIC)`;
}
function countState(stateColumn, state) {
  return stateColumn ? `COUNTIF(UPPER(CAST(${quote(stateColumn.column_name)} AS STRING)) = '${state}')` : 'NULL';
}

function orderCoverageQuery(project, dataset, table) {
  const location = column(table, ['location_id']);
  const created = column(table, ['created_at', 'created_date']);
  const closed = column(table, ['closed_at', 'completed_at']);
  const state = column(table, ['state', 'status']);
  if (!location || (!created && !closed)) return null;
  const event = created && closed
    ? `COALESCE(${quote(closed.column_name)}, ${quote(created.column_name)})`
    : quote((closed || created).column_name);
  const gross = column(table, ['gross_sales', 'gross_sales_money', 'gross_sales_amount', 'total_money_amount', 'total_amount', 'total_money', 'total']);
  const net = column(table, ['net_total', 'net_sales', 'net_amount', 'total_money_amount', 'total_amount', 'total_money', 'total']);
  return `SELECT DATE_TRUNC(DATE(${event}), MONTH) month,
    CAST(${quote(location.column_name)} AS STRING) location_id, COUNT(*) total_orders,
    ${countState(state, 'COMPLETED')} completed, ${countState(state, 'CANCELED')} canceled,
    ${countState(state, 'OPEN')} open, ${countState(state, 'DRAFT')} draft,
    ${state && gross ? `SUM(IF(UPPER(CAST(${quote(state.column_name)} AS STRING)) = 'COMPLETED', ${moneyAmount(gross)}, 0))` : 'NULL'} completed_gross_candidate,
    ${state && net ? `SUM(IF(UPPER(CAST(${quote(state.column_name)} AS STRING)) = 'COMPLETED', ${moneyAmount(net)}, 0))` : 'NULL'} completed_net_candidate
    FROM ${fq(project, dataset, table.name)} GROUP BY month, location_id ORDER BY month, location_id`;
}

function orderLocationCoverageQuery(project, dataset, table) {
  const location = column(table, ['location_id']);
  const created = column(table, ['created_at', 'created_date']);
  const closed = column(table, ['closed_at', 'completed_at']);
  const state = column(table, ['state', 'status']);
  if (!location || (!created && !closed)) return null;
  const earliest = created && closed ? `LEAST(COALESCE(${quote(created.column_name)}, ${quote(closed.column_name)}), COALESCE(${quote(closed.column_name)}, ${quote(created.column_name)}))` : quote((created || closed).column_name);
  const latest = created && closed ? `GREATEST(COALESCE(${quote(created.column_name)}, ${quote(closed.column_name)}), COALESCE(${quote(closed.column_name)}, ${quote(created.column_name)}))` : quote((created || closed).column_name);
  const gross = column(table, ['gross_sales', 'gross_sales_money', 'gross_sales_amount', 'total_money_amount', 'total_amount', 'total_money', 'total']);
  const net = column(table, ['net_total', 'net_sales', 'net_amount', 'total_money_amount', 'total_amount', 'total_money', 'total']);
  return `SELECT CAST(${quote(location.column_name)} AS STRING) location_id,
    ${created ? `MIN(${quote(created.column_name)})` : 'NULL'} earliest_order_created_at,
    ${created ? `MAX(${quote(created.column_name)})` : 'NULL'} latest_order_created_at,
    ${closed ? `MIN(${quote(closed.column_name)})` : 'NULL'} earliest_order_closed_at,
    ${closed ? `MAX(${quote(closed.column_name)})` : 'NULL'} latest_order_closed_at,
    MIN(${earliest}) earliest_order_created_or_closed_at, MAX(${latest}) latest_order_created_or_closed_at,
    COUNT(*) total_orders, ${countState(state, 'COMPLETED')} completed_orders,
    ${countState(state, 'CANCELED')} canceled_orders, ${countState(state, 'OPEN')} open_orders,
    ${countState(state, 'DRAFT')} draft_orders,
    ${state && gross ? `SUM(IF(UPPER(CAST(${quote(state.column_name)} AS STRING)) = 'COMPLETED', ${moneyAmount(gross)}, 0))` : 'NULL'} completed_gross_candidate,
    ${state && net ? `SUM(IF(UPPER(CAST(${quote(state.column_name)} AS STRING)) = 'COMPLETED', ${moneyAmount(net)}, 0))` : 'NULL'} completed_net_candidate
    FROM ${fq(project, dataset, table.name)} GROUP BY location_id ORDER BY location_id`;
}

function salesCoverageQuery(project, dataset, table, groupedByMonth) {
  if (!table) return null;
  const location = column(table, ['location_id', 'location']);
  const date = column(table, ['date', 'sale_date', 'created_date', 'created_at', 'transaction_date']);
  if (!location || !date) return null;
  const measures = {
    gross_sales: column(table, ['gross_sales', 'gross_sales_amount', 'gross']),
    discounts: column(table, ['discounts', 'discount_amount', 'discount']),
    returns: column(table, ['returns', 'return_amount', 'refunds', 'refund_amount']),
    net_total: column(table, ['net_total', 'net_sales', 'net_amount', 'total'])
  };
  const sums = Object.entries(measures).map(([alias, c]) => `${c ? `SUM(${castNumber(c)})` : 'NULL'} ${alias}`).join(',\n    ');
  if (groupedByMonth) return `SELECT DATE_TRUNC(${dateExpression(date)}, MONTH) month,
    CAST(${quote(location.column_name)} AS STRING) location_id, COUNT(*) sale_rows, ${sums}
    FROM ${fq(project, dataset, table.name)} GROUP BY month, location_id ORDER BY month, location_id`;
  return `SELECT CAST(${quote(location.column_name)} AS STRING) location_id,
    MIN(${dateExpression(date)}) earliest_square_sales_date, MAX(${dateExpression(date)}) latest_square_sales_date,
    COUNT(*) square_sales_rows, ${sums}
    FROM ${fq(project, dataset, table.name)} GROUP BY location_id ORDER BY location_id`;
}

function locationIdentityQuery(project, dataset, table) {
  if (!table) return null;
  const id = column(table, ['location_id', 'id']);
  if (!id) return null;
  const value = names => { const c = column(table, names); return c ? `CAST(${quote(c.column_name)} AS STRING)` : 'NULL'; };
  return `SELECT CAST(${quote(id.column_name)} AS STRING) location_id,
    ${value(['name'])} name, ${value(['status', 'state'])} status,
    ${value(['created_at'])} created_at, ${value(['currency'])} currency,
    ${value(['timezone', 'time_zone'])} timezone
    FROM ${fq(project, dataset, table.name)} ORDER BY location_id`;
}

function jsonArrayExpression(c) {
  const raw = `CAST(${quote(c.column_name)} AS STRING)`;
  return `IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(${raw}), '$'), [])`;
}

const LINE_PATHS = {
  line_item_uid: ['uid', 'id'], catalog_object_id: ['catalog_object_id', 'item_id'],
  catalog_variation_id: ['catalog_variation_id', 'variation_id'], item_name: ['name', 'item_name'],
  variation_name: ['variation_name'], sku: ['sku'], quantity: ['quantity'], item_type: ['item_type'],
  base_price: ['base_price_money.amount', 'base_price.amount'], gross_sales: ['gross_sales_money.amount', 'gross_sales.amount'],
  discounts: ['total_discount_money.amount', 'discounts'], tax: ['total_tax_money.amount', 'taxes'],
  total: ['total_money.amount', 'total_price_money.amount'], modifiers: ['modifiers'],
  return_or_refund: ['returned_quantities', 'return_amounts', 'refunds', 'returned_money.amount']
};
function jsonPath(keys, candidates) {
  const lowered = new Map(keys.map(key => [String(key).toLowerCase(), key]));
  const found = candidates.map(candidate => lowered.get(candidate.toLowerCase())).find(Boolean);
  return found ? `$.${found}` : null;
}

async function lineItemDiscovery(bigquery, project, dataset, orders) {
  const lineItems = column(orders, ['line_items']);
  if (!orders || !lineItems) return { available: false, reason: 'No orders.line_items column was discovered.' };
  const array = jsonArrayExpression(lineItems);
  const keyRows = await query(bigquery, `WITH lines AS (
      SELECT line FROM ${fq(project, dataset, orders.name)}, UNNEST(${array}) line
    ) SELECT key, COUNT(*) line_items_with_key FROM lines,
      UNNEST(IFNULL(JSON_KEYS(line, 10, mode => 'lax recursive'), [])) key
    GROUP BY key ORDER BY line_items_with_key DESC, key`);
  const keys = keyRows.map(row => String(row.key));
  const expressions = Object.fromEntries(Object.entries(LINE_PATHS).map(([name, candidates]) => {
    const path = jsonPath(keys, candidates);
    return [name, path ? `${['modifiers', 'return_or_refund'].includes(name) ? 'JSON_QUERY' : 'JSON_VALUE'}(line, '${path}')` : null];
  }));
  const orderId = column(orders, ['order_id', 'id']);
  const selected = Object.entries(expressions).map(([name, expr]) => `${expr || 'NULL'} AS ${quote(name)}`).join(',\n        ');
  const stats = await query(bigquery, `WITH exploded AS (
      SELECT CAST(${quote(orderId?.column_name || orders.columns[0].column_name)} AS STRING) order_id, offset line_offset, line,
        ${selected}
      FROM ${fq(project, dataset, orders.name)}, UNNEST(${array}) line WITH OFFSET offset
    ) SELECT COUNT(DISTINCT order_id) orders_with_line_items, COUNT(*) total_exploded_line_items,
      COUNTIF(catalog_object_id IS NULL) null_catalog_object_ids,
      COUNTIF(item_name IS NULL) null_transaction_time_item_names,
      COUNTIF(line_item_uid IS NULL) null_line_item_uids,
      COUNTIF(line_item_uid IS NOT NULL) - COUNT(DISTINCT IF(line_item_uid IS NULL, NULL, CONCAT(order_id, '\\x1f', line_item_uid))) duplicate_line_item_uids_within_order,
      COUNTIF(item_name IS NOT NULL) lines_preserving_item_name,
      COUNTIF(base_price IS NOT NULL) lines_preserving_base_price,
      COUNTIF(modifiers IS NOT NULL) lines_with_modifiers,
      COUNTIF(return_or_refund IS NOT NULL) lines_with_return_or_refund_fields
    FROM exploded`);
  return { available: true, persisted_column_type: lineItems.data_type, discovered_json_keys: keyRows,
    resolved_fields: Object.fromEntries(Object.entries(expressions).map(([name, expr]) => [name, expr ? expr.match(/'([^']+)'/)?.[1] : null])),
    summary: stats[0] || {}, examples: [], examples_note: 'Raw examples are deliberately omitted to avoid emitting PII; discovered keys and aggregate presence rates describe structure safely.' };
}

async function orderReturnDiscovery(bigquery, project, dataset, orders) {
  if (!orders) return [];
  const candidates = orders.columns.filter(c => /(return|refund)/i.test(c.column_name));
  const output = [];
  for (const c of candidates) {
    if (!['STRING', 'JSON'].includes(c.data_type)) {
      output.push({ column: c.column_name, data_type: c.data_type, note: 'Persisted non-JSON order-level return/refund field.' });
      continue;
    }
    const parsed = `SAFE.PARSE_JSON(CAST(${quote(c.column_name)} AS STRING))`;
    const keys = await query(bigquery, `WITH values AS (
      SELECT ${parsed} value FROM ${fq(project, dataset, orders.name)} WHERE ${quote(c.column_name)} IS NOT NULL
    ) SELECT key, COUNT(*) rows_with_key FROM values,
      UNNEST(IFNULL(JSON_KEYS(value, 10, mode => 'lax recursive'), [])) key
      GROUP BY key ORDER BY rows_with_key DESC, key`);
    output.push({ column: c.column_name, data_type: c.data_type, discovered_json_keys: keys });
  }
  return output;
}

async function catalogueDiscovery(bigquery, project, dataset, tables) {
  const relevant = tables.filter(table => ['catalog_items', 'variations', 'categories'].includes(table.role) ||
    /(tax|discount|modifier|catalog)/i.test(table.name));
  const output = [];
  for (const table of relevant) {
    const id = primaryColumn(table.name, table.columns) || column(table, ['object_id', 'catalog_object_id']);
    if (!id) continue;
    const version = column(table, ['version']);
    const updated = column(table, ['updated_at']);
    const deleted = column(table, ['is_deleted', 'deleted']);
    const [summary] = await query(bigquery, `SELECT COUNT(*) rows, COUNT(DISTINCT CAST(${quote(id.column_name)} AS STRING)) distinct_ids,
      COUNT(*) - COUNT(DISTINCT CAST(${quote(id.column_name)} AS STRING)) repeated_id_rows,
      ${version ? `MIN(SAFE_CAST(${quote(version.column_name)} AS INT64))` : 'NULL'} min_version,
      ${version ? `MAX(SAFE_CAST(${quote(version.column_name)} AS INT64))` : 'NULL'} max_version,
      ${updated ? `MIN(${quote(updated.column_name)})` : 'NULL'} earliest_updated_at,
      ${updated ? `MAX(${quote(updated.column_name)})` : 'NULL'} latest_updated_at,
      ${deleted ? `COUNTIF(SAFE_CAST(${quote(deleted.column_name)} AS BOOL))` : 'NULL'} deleted_rows
      FROM ${fq(project, dataset, table.name)}`);
    const ordering = [version && `SAFE_CAST(${quote(version.column_name)} AS INT64) DESC`, updated && `${quote(updated.column_name)} DESC`]
      .filter(Boolean).join(', ');
    output.push({ table: table.name, id_column: id.column_name, version_column: version?.column_name || null,
      updated_at_column: updated?.column_name || null, is_deleted_column: deleted?.column_name || null,
      summary, repeated_ids_are_version_like: Boolean(version || updated),
      proposed_current_row_rule: ordering
        ? `Alias the source row as src, then QUALIFY ROW_NUMBER() OVER (PARTITION BY ${quote(id.column_name)} ORDER BY ${ordering}, FARM_FINGERPRINT(TO_JSON_STRING(src)) DESC) = 1; retain is_deleted as state (or filter only under an explicit current-active contract). The row fingerprint is only a deterministic tie-breaker.`
        : 'Unresolved: no version or updated_at column was discovered; do not deduplicate by arbitrary row order.' });
  }
  return output;
}

async function orphanDiscovery(bigquery, project, dataset, parent, child, parentKeyNames, childKeyNames, label, tables = []) {
  const parentKey = column(parent, parentKeyNames);
  const childKey = column(child, childKeyNames);
  if (!parent || !child || !parentKey || !childKey) return { available: false, reason: `Required ${label} key columns were not discovered.` };
  const time = column(child, ['created_at', 'processed_at', 'updated_at', 'completed_at', 'refunded_at', 'timestamp']);
  const location = column(child, ['location_id']);
  const status = column(child, ['status', 'state']);
  const source = column(child, ['source_type', 'source', 'type', 'tender_type', 'payment_method']);
  const timeExpr = time ? quote(time.column_name) : 'NULL';
  const base = `SELECT c.* FROM ${fq(project, dataset, child.name)} c LEFT JOIN ${fq(project, dataset, parent.name)} p
    ON CAST(p.${quote(parentKey.column_name)} AS STRING) = CAST(c.${quote(childKey.column_name)} AS STRING)
    WHERE c.${quote(childKey.column_name)} IS NOT NULL AND p.${quote(parentKey.column_name)} IS NULL`;
  const [summary] = await query(bigquery, `WITH orphan AS (${base}) SELECT COUNT(*) orphan_rows,
    COUNT(DISTINCT CAST(${quote(childKey.column_name)} AS STRING)) orphan_distinct_ids,
    ${time ? `MIN(${timeExpr})` : 'NULL'} earliest_at, ${time ? `MAX(${timeExpr})` : 'NULL'} latest_at
    FROM orphan`);
  const grouped = async (name, expression) => expression ? await query(bigquery, `WITH orphan AS (${base})
    SELECT ${expression} value, COUNT(*) orphan_rows, COUNT(DISTINCT CAST(${quote(childKey.column_name)} AS STRING)) orphan_distinct_ids
    FROM orphan GROUP BY value ORDER BY value`) : [];
  const otherIdentifierMatches = [];
  for (const candidateTable of tables.filter(table => table.name !== parent.name && table.name !== child.name)) {
    for (const candidate of candidateTable.columns.filter(c => isScalar(c) && /^(id|transaction_id|order_id|payment_id|tender_id|receipt_number)$/i.test(c.column_name))) {
      const [match] = await query(bigquery, `WITH orphan AS (${base}), keys AS (
        SELECT DISTINCT CAST(${quote(candidate.column_name)} AS STRING) key FROM ${fq(project, dataset, candidateTable.name)}
        WHERE ${quote(candidate.column_name)} IS NOT NULL
      ) SELECT COUNT(DISTINCT CAST(orphan.${quote(childKey.column_name)} AS STRING)) matched_orphan_ids
        FROM orphan JOIN keys ON CAST(orphan.${quote(childKey.column_name)} AS STRING) = keys.key`);
      if (Number(match?.matched_orphan_ids || 0) > 0) otherIdentifierMatches.push({
        table: candidateTable.name, column: candidate.column_name, matched_orphan_ids: match.matched_orphan_ids
      });
    }
  }
  return { available: true, parent_table: parent.name, child_table: child.name,
    parent_key: parentKey.column_name, child_key: childKey.column_name, summary,
    by_month: await grouped('month', time ? `CAST(DATE_TRUNC(DATE(${timeExpr}), MONTH) AS STRING)` : null),
    by_location: await grouped('location', location ? `CAST(${quote(location.column_name)} AS STRING)` : null),
    by_status: await grouped('status', status ? `CAST(${quote(status.column_name)} AS STRING)` : null),
    by_source_or_tender: await grouped('source', source ? `CAST(${quote(source.column_name)} AS STRING)` : null),
    matches_to_other_persisted_identifiers: otherIdentifierMatches };
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
  const orders = tableForRole(tables, 'orders', 'orders');
  const payments = tableForRole(tables, 'payments', 'payments');
  const refunds = tableForRole(tables, 'refunds', 'refunds');
  const locations = tableForRole(tables, 'locations', 'locations');
  const squareSales = tables.find(table => table.name.toLowerCase() === 'square_sales');
  const targetedMonthly = {};
  const orderMonthlySql = orders && orderCoverageQuery(project, dataset, orders);
  if (orderMonthlySql) targetedMonthly.orders = await query(bigquery, orderMonthlySql);
  const salesMonthlySql = salesCoverageQuery(project, dataset, squareSales, true);
  if (salesMonthlySql) targetedMonthly.square_sales = await query(bigquery, salesMonthlySql);
  const targetedLocations = {
    persisted_locations: locationIdentityQuery(project, dataset, locations)
      ? await query(bigquery, locationIdentityQuery(project, dataset, locations)) : [],
    order_coverage: orders && orderLocationCoverageQuery(project, dataset, orders)
      ? await query(bigquery, orderLocationCoverageQuery(project, dataset, orders)) : [],
    square_sales_coverage: salesCoverageQuery(project, dataset, squareSales, false)
      ? await query(bigquery, salesCoverageQuery(project, dataset, squareSales, false)) : []
  };
  const lineItems = await lineItemDiscovery(bigquery, project, dataset, orders);
  const orderReturnStructures = await orderReturnDiscovery(bigquery, project, dataset, orders);
  const catalogue = await catalogueDiscovery(bigquery, project, dataset, tables);
  const paymentOrphans = await orphanDiscovery(bigquery, project, dataset, orders, payments,
    ['order_id', 'id'], ['order_id'], 'payment-to-order', tables);
  const refundOrphans = await orphanDiscovery(bigquery, project, dataset, payments, refunds,
    ['payment_id', 'id'], ['payment_id'], 'refund-to-payment', tables);
  const financeViews = await query(bigquery, `SELECT table_name, view_definition
    FROM ${fq(project, financeDataset, 'INFORMATION_SCHEMA.VIEWS')}
    WHERE table_name IN ('sales_master', 'accountant_transactions') ORDER BY table_name`);
  const financeColumns = await query(bigquery, `SELECT table_name, column_name, ordinal_position, data_type
    FROM ${fq(project, financeDataset, 'INFORMATION_SCHEMA.COLUMNS')}
    WHERE table_name IN ('sales_master', 'accountant_transactions') ORDER BY table_name, ordinal_position`);
  return { diagnostic: 'square_semantic_discovery', generated_at: new Date().toISOString(),
    safety: { read_only: true, square_api_calls: false, ingestion_run: false, bigquery_writes: false },
    scope: { project, dataset, finance_dataset: financeDataset }, tables: profiles, relationships,
    monthly_coverage: { ...monthly_coverage, ...targetedMonthly },
    location_coverage: { ...location_coverage, ...targetedLocations },
    line_item_discovery: { ...lineItems, order_return_structures: orderReturnStructures }, catalogue_version_semantics: catalogue,
    orphan_investigation: { payment_to_order: paymentOrphans, refund_to_payment: refundOrphans,
      interpretation: 'Compare orphan timing/location/status clusters with the independently reported order/payment coverage. The diagnostic does not label unmatched identifiers corrupt or repair them.' },
    semantic_findings: {
      transaction_time_product_truth: 'Historical names, prices, quantities, and monetary components should come from persisted order line items when the presence evidence supports them.',
      current_catalogue_enrichment: 'Any later latest-version catalogue join is current enrichment only and must not rewrite transaction-time product truth.',
      customer_limitation: 'The current 59-row customers table is not suitable as a historical customer dimension: the first production diagnostic found no matches to customer IDs referenced by historical orders or payments. Fuzzy name/email/phone matching is prohibited; customer modeling is deferred.',
      finance_contract: 'finance.sales_master remains business-wide money truth. square_data.finance_clean and square_data.square_sales are reconciliation evidence only; Square orders are operational truth for future product/location analytics.'
    },
    finance: { views: financeViews, columns: financeColumns },
    caveat: 'Candidates and roles are name-based discovery aids. Review schemas and relationship evidence before adopting semantics. No semantic views or tables are created.' };
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
