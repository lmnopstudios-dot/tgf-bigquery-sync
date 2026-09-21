import { createReadStream } from 'node:fs';
import { BigQuery } from '@google-cloud/bigquery';

export const GEOGRAPHY_DATASET = 'commerce';
export const GEOGRAPHY_TABLE = 'order_geography';
export const GOVERNED_STORES = Object.freeze({
  ww: Object.freeze({ canonicalDataset: 'metorik_uk' }),
  usd: Object.freeze({ canonicalDataset: 'metorik_us' })
});
export const GEOGRAPHY_SCHEMA = Object.freeze([
  { name: 'source_platform', type: 'STRING', mode: 'REQUIRED' },
  { name: 'source_store', type: 'STRING', mode: 'REQUIRED' },
  { name: 'source_order_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'source_order_number', type: 'STRING' },
  { name: 'order_date', type: 'DATE' },
  { name: 'shipping_country_source_value', type: 'STRING' },
  { name: 'shipping_country_iso2', type: 'STRING' },
  { name: 'geography_status', type: 'STRING', mode: 'REQUIRED' },
  { name: 'geography_provenance', type: 'STRING', mode: 'REQUIRED' },
  { name: 'evidence_tier', type: 'STRING', mode: 'REQUIRED' },
  { name: 'source_export_type', type: 'STRING', mode: 'REQUIRED' },
  { name: 'imported_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
]);

const FIELD_ALIASES = Object.freeze({
  source_order_id: ['order id', 'order_id', 'id'],
  source_order_number: ['order number', 'order_number', 'number'],
  order_date: ['order date', 'order_date', 'date', 'created at', 'created_at'],
  shipping_country: ['shipping country', 'shipping_country', 'shipping country code', 'shipping_country_code']
});
export const ISO2_CODES = Object.freeze(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));
const ISO2 = new Set(ISO2_CODES);
const COUNTRY_NAMES = new Map([
  ['united kingdom', 'GB'], ['great britain', 'GB'], ['uk', 'GB'],
  ['united states', 'US'], ['united states of america', 'US'], ['usa', 'US'],
  ['germany', 'DE'], ['australia', 'AU'], ['france', 'FR'], ['canada', 'CA'],
  ['ireland', 'IE'], ['switzerland', 'CH'], ['italy', 'IT'], ['netherlands', 'NL'],
  ['japan', 'JP']
]);

function normalizedHeader(value) {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s-]+/g, ' ');
}

export function recognizeMetorikHeaders(headers) {
  const normalized = headers.map(normalizedHeader);
  const columns = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    const index = normalized.findIndex(value => aliases.includes(value));
    if (index >= 0) columns[field] = index;
  }
  const missing = Object.keys(FIELD_ALIASES).filter(field => columns[field] === undefined);
  if (missing.length) {
    const expected = missing.map(field => `${field}: ${FIELD_ALIASES[field].join(' | ')}`);
    throw new Error(`Metorik CSV is missing required columns: ${missing.join(', ')}. Accepted headings: ${expected.join('; ')}`);
  }
  return columns;
}

export function normalizeCountry(value) {
  const source = value?.trim() || null;
  if (source === null) return { source: null, iso2: null };
  const upper = source.toUpperCase();
  const iso2 = ISO2.has(upper) ? upper : COUNTRY_NAMES.get(source.toLowerCase());
  if (!iso2) throw new Error('unrecognised shipping-country value');
  return { source, iso2 };
}

function normalizeDate(value) {
  const source = value?.trim();
  if (!source) return null;
  const match = source.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (!match) throw new Error('invalid order date');
  const result = `${match[1]}-${match[2]}-${match[3]}`;
  if (new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result) throw new Error('invalid order date');
  return result;
}

// Streaming RFC 4180 parser. It supports quoted commas/newlines without ever
// retaining the source file or PII-bearing columns in memory.
export async function* csvRecords(readable) {
  readable.setEncoding?.('utf8');
  let row = [], field = '', quoted = false, pendingQuote = false;
  for await (const chunk of readable) {
    for (const character of chunk.toString('utf8')) {
      if (quoted) {
        if (pendingQuote) {
          if (character === '"') { field += '"'; pendingQuote = false; continue; }
          quoted = false; pendingQuote = false;
        } else if (character === '"') { pendingQuote = true; continue; }
        else { field += character; continue; }
      }
      if (character === '"' && field === '') quoted = true;
      else if (character === ',') { row.push(field); field = ''; }
      else if (character === '\n') { row.push(field.replace(/\r$/, '')); yield row; row = []; field = ''; }
      else field += character;
    }
  }
  if (quoted && !pendingQuote) throw new Error('Metorik CSV contains an unterminated quoted field');
  if (field.length || row.length) { row.push(field.replace(/\r$/, '')); yield row; }
}

export function geographyRow(record, columns, store, importedAt) {
  const source_order_id = record[columns.source_order_id]?.trim();
  if (!source_order_id) throw new Error('blank Order ID');
  const { source, iso2 } = normalizeCountry(record[columns.shipping_country]);
  return {
    source_platform: 'woo', source_store: store, source_order_id,
    source_order_number: record[columns.source_order_number]?.trim() || null,
    order_date: normalizeDate(record[columns.order_date]),
    shipping_country_source_value: source, shipping_country_iso2: iso2,
    geography_status: iso2 ? 'observed' : 'unresolved',
    geography_provenance: iso2 ? 'direct_metorik_export_shipping_country' : 'unresolved',
    evidence_tier: iso2 ? 'direct' : 'none', source_export_type: 'metorik_orders_csv',
    imported_at: importedAt
  };
}

export function parseImportArguments(argv) {
  const value = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1] || null; };
  const store = value('--store');
  const file = value('--file');
  if (!store) throw new Error('Required argument missing: --store (ww or usd)');
  if (!GOVERNED_STORES[store]) throw new Error(`Invalid --store ${store}; governed values are ww and usd`);
  if (!file) throw new Error('Required argument missing: --file');
  return { store, file };
}

async function ensureDestination(bigquery) {
  const dataset = bigquery.dataset(GEOGRAPHY_DATASET);
  const [datasetExists] = await dataset.exists();
  if (!datasetExists) await bigquery.createDataset(GEOGRAPHY_DATASET);
  const table = dataset.table(GEOGRAPHY_TABLE);
  const [tableExists] = await table.exists();
  if (!tableExists) await dataset.createTable(GEOGRAPHY_TABLE, { schema: GEOGRAPHY_SCHEMA });
  return dataset;
}

export async function importMetorikGeography({ bigquery, project, store, file, readable, now = () => new Date() }) {
  if (!GOVERNED_STORES[store]) throw new Error('store must be one of: ww, usd');
  if (!file && !readable) throw new Error('file is required');
  const dataset = await ensureDestination(bigquery);
  const stageName = `_order_geography_${store}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [stage] = await dataset.createTable(stageName, { schema: GEOGRAPHY_SCHEMA, expirationTime: Date.now() + 86400000 });
  const importedAt = now().toISOString();
  let headers, columns, count = 0, observed = 0;
  let batch = [];
  try {
    for await (const record of csvRecords(readable || createReadStream(file))) {
      if (!headers) { headers = record; columns = recognizeMetorikHeaders(headers); continue; }
      if (record.length === 1 && record[0] === '') continue;
      let row;
      try { row = geographyRow(record, columns, store, importedAt); }
      catch (error) { throw new Error(`Metorik CSV validation failed at data row ${count + 1}: ${error.message}`); }
      count += 1; observed += row.geography_status === 'observed' ? 1 : 0;
      batch.push(row);
      if (batch.length === 500) { await stage.insert(batch); batch = []; }
    }
    if (!headers) throw new Error('Metorik CSV is empty');
    if (!count) throw new Error('Metorik CSV contains no order rows');
    if (batch.length) await stage.insert(batch);
    const canonical = GOVERNED_STORES[store].canonicalDataset;
    const [checks] = await bigquery.query({ query: `
      SELECT COUNT(*) stage_count, COUNT(DISTINCT source_order_id) unique_ids,
        COUNTIF(c.order_id IS NOT NULL) canonical_matches,
        COUNTIF(c.order_id IS NULL) extra_export_ids,
        COUNTIF(c.order_id IS NOT NULL AND COALESCE(g.source_order_number, '') != COALESCE(c.order_number, '')) order_number_disagreements,
        COUNTIF(c.order_id IS NOT NULL AND g.order_date IS NOT NULL AND DATE(c.order_created_at) != g.order_date) date_disagreements,
        (SELECT COUNT(*) FROM \`${project}.${canonical}.orders\` c2 LEFT JOIN \`${project}.${GEOGRAPHY_DATASET}.${stageName}\` g2
          ON CAST(c2.order_id AS STRING)=g2.source_order_id WHERE g2.source_order_id IS NULL) missing_canonical_ids
      FROM \`${project}.${GEOGRAPHY_DATASET}.${stageName}\` g
      LEFT JOIN \`${project}.${canonical}.orders\` c ON CAST(c.order_id AS STRING) = g.source_order_id`, params: {} });
    const check = checks[0] || {};
    if (Number(check.stage_count) !== count) throw new Error('Staging validation row-count mismatch');
    if (Number(check.unique_ids) !== count) throw new Error('Metorik CSV has duplicate Order ID values');
    const reconciliationFailures = ['extra_export_ids', 'missing_canonical_ids',
      'order_number_disagreements', 'date_disagreements']
      .filter(field => Number(check[field] || 0) > 0)
      .map(field => `${field}=${Number(check[field])}`);
    if (reconciliationFailures.length) {
      throw new Error(`Canonical ${canonical}.orders reconciliation failed: ${reconciliationFailures.join(', ')}`);
    }
    await bigquery.query({ query: `BEGIN TRANSACTION;
      DELETE FROM \`${project}.${GEOGRAPHY_DATASET}.${GEOGRAPHY_TABLE}\` WHERE source_store = @store;
      INSERT INTO \`${project}.${GEOGRAPHY_DATASET}.${GEOGRAPHY_TABLE}\` SELECT * FROM \`${project}.${GEOGRAPHY_DATASET}.${stageName}\`;
      COMMIT TRANSACTION;`, params: { store } });
    return { store, imported_rows: count, observed_rows: observed, unresolved_rows: count - observed,
      coverage_percentage: Number((observed * 100 / count).toFixed(2)), canonical_dataset: canonical,
      canonical_reconciliation: { matched_ids: Number(check.canonical_matches || 0), extra_export_ids: Number(check.extra_export_ids || 0),
        missing_canonical_ids: Number(check.missing_canonical_ids || 0), order_number_disagreements: Number(check.order_number_disagreements || 0), date_disagreements: Number(check.date_disagreements || 0) } };
  } finally { await stage.delete({ ignoreNotFound: true }); }
}

async function main() {
  const { store, file } = parseImportArguments(process.argv.slice(2));
  const project = process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const bigquery = new BigQuery({ projectId: project, credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) });
  console.log(JSON.stringify(await importMetorikGeography({ bigquery, project, store, file }), null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(`Metorik geography import failed: ${error.message}`); process.exitCode = 1; });
}
