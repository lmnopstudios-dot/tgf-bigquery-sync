import { BigQuery } from '@google-cloud/bigquery';
import { GEOGRAPHY_DATASET, GEOGRAPHY_TABLE, ISO2_CODES } from '../metorik/geography.js';

export function geographyValidationQueries(project) {
  const table = `\`${project}.${GEOGRAPHY_DATASET}.${GEOGRAPHY_TABLE}\``;
  return {
    global: `SELECT COUNT(*) row_count, COUNT(DISTINCT CONCAT(source_store, ':', source_order_id)) identity_count,
      COUNTIF(source_store NOT IN ('ww','usd')) invalid_store,
      COUNTIF(geography_status NOT IN ('observed','unresolved')) invalid_status,
      COUNTIF((geography_status='observed' AND (shipping_country_iso2 IS NULL OR shipping_country_iso2 NOT IN (${ISO2_CODES.map(code => `'${code}'`).join(',')}) OR geography_provenance!='direct_metorik_export_shipping_country' OR evidence_tier!='direct')) OR
        (geography_status='unresolved' AND (shipping_country_iso2 IS NOT NULL OR geography_provenance!='unresolved'))) invalid_semantics,
      COUNTIF(REGEXP_CONTAINS(geography_provenance, r'(?i)(postcode|billing|currency|infer)')) forbidden_inference,
      (SELECT COUNT(*) FROM \`${project}.${GEOGRAPHY_DATASET}.INFORMATION_SCHEMA.COLUMNS\`
        WHERE table_name='${GEOGRAPHY_TABLE}' AND REGEXP_CONTAINS(column_name, r'(?i)(name|email|phone|street|address|postcode|postal|city|note|credential|raw)')) pii_columns
      FROM ${table}`,
    stores: `SELECT source_store, COUNT(*) row_count, COUNTIF(geography_status='observed') observed_rows,
      COUNTIF(geography_status='unresolved') unresolved_rows,
      ROUND(100*SAFE_DIVIDE(COUNTIF(geography_status='observed'),COUNT(*)),2) coverage_percentage
      FROM ${table} GROUP BY source_store ORDER BY source_store`,
    ww_reconciliation: `SELECT COUNTIF(o.order_id IS NOT NULL) matched_ids, COUNTIF(o.order_id IS NULL) extra_export_ids,
      COUNTIF(o.order_id IS NOT NULL AND COALESCE(g.source_order_number,'') != COALESCE(o.order_number,'')) order_number_disagreements,
      COUNTIF(o.order_id IS NOT NULL AND g.order_date IS NOT NULL AND g.order_date != DATE(o.order_created_at)) date_disagreements,
      (SELECT COUNT(*) FROM \`${project}.metorik_uk.orders\` o2 LEFT JOIN ${table} g2 ON g2.source_store='ww' AND g2.source_order_id=CAST(o2.order_id AS STRING) WHERE g2.source_order_id IS NULL) missing_canonical_ids
      FROM ${table} g LEFT JOIN \`${project}.metorik_uk.orders\` o ON CAST(o.order_id AS STRING)=g.source_order_id WHERE g.source_store='ww'`,
    usd_reconciliation: `SELECT COUNTIF(o.order_id IS NOT NULL) matched_ids, COUNTIF(o.order_id IS NULL) extra_export_ids,
      (SELECT COUNT(*) FROM \`${project}.metorik_us.orders\` o2 LEFT JOIN ${table} g2 ON g2.source_store='usd' AND g2.source_order_id=CAST(o2.order_id AS STRING) WHERE g2.source_order_id IS NULL) missing_canonical_ids
      FROM ${table} g LEFT JOIN \`${project}.metorik_us.orders\` o ON CAST(o.order_id AS STRING)=g.source_order_id WHERE g.source_store='usd'`,
    collisions: `SELECT COUNT(*) cross_store_numeric_id_collisions,
      COUNTIF(ww.source_store=usd.source_store) incorrectly_merged
      FROM ${table} ww JOIN ${table} usd USING(source_order_id) WHERE ww.source_store='ww' AND usd.source_store='usd'`
  };
}

export async function validateMetorikGeography({ bigquery, project }) {
  const evidence = {};
  for (const [name, query] of Object.entries(geographyValidationQueries(project))) {
    const [rows] = await bigquery.query({ query }); evidence[name] = name === 'stores' ? rows : rows[0];
  }
  const failures = [];
  const global = evidence.global || {};
  if (Number(global.row_count) !== Number(global.identity_count)) failures.push('duplicate store-qualified identities');
  for (const field of ['invalid_store', 'invalid_status', 'invalid_semantics', 'forbidden_inference', 'pii_columns']) {
    if (Number(global[field])) failures.push(`${field}: ${global[field]}`);
  }
  for (const [store, result] of [['ww', evidence.ww_reconciliation], ['usd', evidence.usd_reconciliation]]) {
    for (const field of ['extra_export_ids', 'missing_canonical_ids']) if (Number(result?.[field])) failures.push(`${store} ${field}: ${result[field]}`);
  }
  if (Number(evidence.ww_reconciliation?.order_number_disagreements)) failures.push(`ww order_number_disagreements: ${evidence.ww_reconciliation.order_number_disagreements}`);
  if (Number(evidence.ww_reconciliation?.date_disagreements)) failures.push(`ww date_disagreements: ${evidence.ww_reconciliation.date_disagreements}`);
  if (Number(evidence.collisions?.incorrectly_merged)) failures.push('cross-store identities were merged');
  return { valid: failures.length === 0, failures, evidence,
    usd_canonical_relationship: `${project}.metorik_us.orders joined by source_store=usd + source_order_id` };
}

async function main() {
  const project = process.env.GOOGLE_PROJECT_ID || 'gf-full-data';
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');
  const bigquery = new BigQuery({ projectId: project, credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) });
  const result = await validateMetorikGeography({ bigquery, project });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(error => { console.error(`Metorik geography validation failed: ${error.message}`); process.exitCode = 1; });
}
