#!/usr/bin/env node
/** Read-only, aggregate-only and PII-free production acceptance diagnostic. */
import { BigQuery } from '@google-cloud/bigquery';
import { MATRIXIFY_APP_ID, TABLE } from '../shopify/order-geography.js';

const NOT_MEASURABLE = 'not_yet_measurable';

export function diagnosticQueries(project) {
  const g = `\`${project}.shopify_data.${TABLE}\``;
  const o = `\`${project}.shopify_data.order_locations\``;
  const f = `\`${project}.shopify_data.order_financials\``;
  const eu = `EU AS (SELECT code,joined,left_on FROM UNNEST([STRUCT('AT' AS code,DATE '1995-01-01' AS joined,CAST(NULL AS DATE) AS left_on),('BE',DATE '1958-01-01',NULL),('BG',DATE '2007-01-01',NULL),('HR',DATE '2013-07-01',NULL),('CY',DATE '2004-05-01',NULL),('CZ',DATE '2004-05-01',NULL),('DK',DATE '1973-01-01',NULL),('EE',DATE '2004-05-01',NULL),('FI',DATE '1995-01-01',NULL),('FR',DATE '1958-01-01',NULL),('DE',DATE '1958-01-01',NULL),('GR',DATE '1981-01-01',NULL),('HU',DATE '2004-05-01',NULL),('IE',DATE '1973-01-01',NULL),('IT',DATE '1958-01-01',NULL),('LV',DATE '2004-05-01',NULL),('LT',DATE '2004-05-01',NULL),('LU',DATE '1958-01-01',NULL),('MT',DATE '2004-05-01',NULL),('NL',DATE '1958-01-01',NULL),('PL',DATE '2004-05-01',NULL),('PT',DATE '1986-01-01',NULL),('RO',DATE '2007-01-01',NULL),('SK',DATE '2004-05-01',NULL),('SI',DATE '2004-05-01',NULL),('ES',DATE '1986-01-01',NULL),('SE',DATE '1995-01-01',NULL),('GB',DATE '1973-01-01',DATE '2020-02-01')]))`;
  return {
    destination_metadata: `SELECT COUNTIF(table_name='${TABLE}') destination_table_count FROM \`${project}.shopify_data.INFORMATION_SCHEMA.TABLES\``,
    direct_field_evidence: `SELECT table_name,column_name,data_type FROM \`${project}.shopify_data.INFORMATION_SCHEMA.COLUMNS\` WHERE REGEXP_CONTAINS(LOWER(column_name),r'^(shipping|destination)_country(_code|_code_source|_name)?$') ORDER BY table_name,ordinal_position`,
    source_scope: `SELECT COUNT(*) source_shopify_orders,COUNTIF(source_app_id=@matrixify) matrixify_excluded_orders,COUNTIF(source_app_id IS NULL OR source_app_id!=@matrixify) expected_write_orders,COUNTIF((source_app_id IS NULL OR source_app_id!=@matrixify) AND retail_location_id IS NULL) expected_online_orders,COUNTIF((source_app_id IS NULL OR source_app_id!=@matrixify) AND retail_location_id IS NOT NULL) expected_pos_orders,MIN(IF(source_app_id IS NULL OR source_app_id!=@matrixify,created_at,NULL)) earliest_expected_order,MAX(IF(source_app_id IS NULL OR source_app_id!=@matrixify,created_at,NULL)) latest_expected_order FROM ${o}`,
    coverage: `WITH ${eu}, base AS (SELECT DATE_TRUNC(DATE(o.created_at),MONTH) month,IF(o.retail_location_id IS NULL,'Online','POS') channel,g.geography_status,g.shipping_country_code,DATE(o.created_at) order_date FROM ${o} o LEFT JOIN ${g} g USING(order_id) WHERE o.source_app_id IS NULL OR o.source_app_id!=@matrixify) SELECT month,channel,COUNT(*) orders,COUNTIF(geography_status='valid') valid_direct_country,COUNTIF(geography_status='missing_address') missing_address,COUNTIF(geography_status='missing_code') missing_code,COUNTIF(geography_status='invalid_code') invalid_code,COUNTIF(order_date>DATE '2025-09-20' AND geography_status='valid' AND EXISTS(SELECT 1 FROM EU WHERE code=shipping_country_code AND order_date>=joined AND (left_on IS NULL OR order_date<left_on))) eligible_eu_samples,COUNTIF(order_date>DATE '2025-09-20' AND geography_status='valid' AND NOT EXISTS(SELECT 1 FROM EU WHERE code=shipping_country_code AND order_date>=joined AND (left_on IS NULL OR order_date<left_on))) eligible_non_eu_samples FROM base GROUP BY month,channel ORDER BY month,channel`,
    integrity: `SELECT COUNT(*) geography_rows,COUNT(DISTINCT g.order_id) distinct_geography_orders,COUNTIF(o.order_id IS NULL) orphan_rows,COUNTIF(o.source_app_id=@matrixify) matrixify_rows,MAX(g.synced_at) latest_sync,MAX(g.order_updated_at) latest_order_update FROM ${g} g LEFT JOIN ${o} o USING(order_id)`,
    parent_sales: `SELECT COUNT(*) joined_rows,COUNT(DISTINCT o.order_id) distinct_orders,COUNT(DISTINCT f.order_id) financial_orders,SUM(f.original_total_presentment) joined_sales,(SELECT SUM(original_total_presentment) FROM ${f} f2 JOIN ${o} o2 USING(order_id) WHERE o2.source_app_id IS NULL OR o2.source_app_id!=@matrixify) expected_sales FROM ${o} o JOIN ${g} g USING(order_id) LEFT JOIN ${f} f USING(order_id) WHERE o.source_app_id IS NULL OR o.source_app_id!=@matrixify`
  };
}

function safeDetail(error) {
  return String(error?.message || error).split('\n', 1)[0].slice(0, 260);
}

async function runStage(bigquery, name, query) {
  try {
    const [rows] = await bigquery.query({ query, params: { matrixify: MATRIXIFY_APP_ID } });
    return rows;
  } catch (error) {
    throw new Error(`Shopify shipping geography diagnostic failed during ${name}: ${safeDetail(error)}`, { cause: error });
  }
}

export async function diagnose({ bigquery, project }) {
  const queries = diagnosticQueries(project);
  const evidence = {};
  for (const name of ['destination_metadata', 'direct_field_evidence', 'source_scope']) {
    evidence[name] = await runStage(bigquery, name, queries[name]);
  }

  const destinationPresent = Number(evidence.destination_metadata[0]?.destination_table_count || 0) > 0;
  if (!destinationPresent) {
    evidence.coverage = { status: NOT_MEASURABLE, reason: 'destination_table_absent' };
    evidence.integrity = { status: NOT_MEASURABLE, reason: 'destination_table_absent' };
    evidence.parent_sales = { status: NOT_MEASURABLE, reason: 'destination_table_absent' };
    return {
      valid: true,
      phase: 'pre_backfill',
      destination_present: false,
      contract: { read_only:true, aggregate_only:true, pii_free:true, eu_membership:'date-aware diagnostic rule; not persisted on orders' },
      evidence
    };
  }

  for (const name of ['coverage', 'integrity', 'parent_sales']) {
    evidence[name] = await runStage(bigquery, name, queries[name]);
  }
  const integrity = evidence.integrity[0] || {}, sales = evidence.parent_sales[0] || {};
  const valid = Number(integrity.geography_rows) === Number(integrity.distinct_geography_orders) && Number(integrity.orphan_rows) === 0 &&
    Number(integrity.matrixify_rows) === 0 && Number(sales.joined_rows) === Number(sales.distinct_orders) && Number(sales.joined_sales) === Number(sales.expected_sales);
  return { valid, phase: 'post_backfill', destination_present: true, contract: { read_only:true, aggregate_only:true, pii_free:true, eu_membership:'date-aware diagnostic rule; not persisted on orders' }, evidence };
}

async function main() { const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data'; const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'null'); if(!credentials) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON'); const result=await diagnose({bigquery:new BigQuery({projectId:project,credentials}),project}); console.log(JSON.stringify(result,null,2)); if(!result.valid) process.exitCode=1; }
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
