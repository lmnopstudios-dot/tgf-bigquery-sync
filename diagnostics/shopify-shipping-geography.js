#!/usr/bin/env node
/** Read-only and PII-free production acceptance diagnostic. */
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
    source_scope: `SELECT COUNT(*) source_shopify_orders,COUNTIF(source_app_id=@matrixify) matrixify_excluded_orders,COUNTIF(source_app_id IS NULL OR source_app_id!=@matrixify) expected_write_orders,COUNTIF((source_app_id IS NULL OR source_app_id!=@matrixify) AND retail_location_id IS NULL) expected_online_orders,COUNTIF((source_app_id IS NULL OR source_app_id!=@matrixify) AND retail_location_id IS NOT NULL) expected_pos_orders,MIN(IF(source_app_id IS NULL OR source_app_id!=@matrixify,created_at,NULL)) earliest_expected_order,MAX(IF(source_app_id IS NULL OR source_app_id!=@matrixify,created_at,NULL)) latest_expected_order,MAX(IF(source_app_id IS NULL OR source_app_id!=@matrixify,updated_at,NULL)) latest_expected_order_update FROM ${o}`,
    orphan_analysis: `WITH parent_bounds AS (
      SELECT MAX(created_at) latest_parent_created_at,MAX(updated_at) latest_parent_updated_at FROM ${o}
    ), customer_state AS (
      SELECT order_id,ANY_VALUE(display_financial_status HAVING MAX synced_at) display_financial_status
      FROM \`${project}.shopify_data.order_customers\` GROUP BY order_id
    ), parent_suffix AS (
      SELECT REGEXP_EXTRACT(order_id,r'([0-9]+)$') numeric_suffix,COUNT(DISTINCT order_id) parent_ids
      FROM ${o} GROUP BY numeric_suffix
    ), orphans AS (
      SELECT DATE(g.order_created_at) order_date,DATE(g.order_updated_at) update_date,
        COALESCE(c.display_financial_status,'not_in_parent_snapshot') financial_state,
        g.order_created_at>b.latest_parent_created_at OR g.order_updated_at>b.latest_parent_updated_at missing_recent_parent_evidence,
        COALESCE(c.display_financial_status IN ('PENDING','AUTHORIZED','VOIDED','EXPIRED'),FALSE) non_financial_state_evidence,
        COALESCE(s.parent_ids>0,FALSE) alternate_id_suffix_match
      FROM ${g} g CROSS JOIN parent_bounds b
      LEFT JOIN ${o} o USING(order_id)
      LEFT JOIN customer_state c USING(order_id)
      LEFT JOIN parent_suffix s ON s.numeric_suffix=REGEXP_EXTRACT(g.order_id,r'([0-9]+)$')
      WHERE o.order_id IS NULL
    )
    SELECT order_date,update_date,financial_state,COUNT(*) orphan_rows,
      COUNTIF(missing_recent_parent_evidence) missing_recent_parent_rows,
      COUNTIF(non_financial_state_evidence) non_financial_state_rows,
      COUNTIF(alternate_id_suffix_match) possible_id_join_defect_rows
    FROM orphans GROUP BY order_date,update_date,financial_state ORDER BY order_date,update_date,financial_state`,
    coverage: `WITH ${eu}, base AS (SELECT DATE_TRUNC(DATE(o.created_at),MONTH) month,IF(o.retail_location_id IS NULL,'Online','POS') channel,g.geography_status,g.shipping_country_code,DATE(o.created_at) order_date FROM ${o} o LEFT JOIN ${g} g USING(order_id) WHERE o.source_app_id IS NULL OR o.source_app_id!=@matrixify) SELECT month,channel,COUNT(*) orders,COUNTIF(geography_status='valid') valid_direct_country,COUNTIF(geography_status='missing_address') missing_address,COUNTIF(geography_status='missing_code') missing_code,COUNTIF(geography_status='invalid_code') invalid_code,COUNTIF(order_date>DATE '2025-09-20' AND geography_status='valid' AND EXISTS(SELECT 1 FROM EU WHERE code=shipping_country_code AND order_date>=joined AND (left_on IS NULL OR order_date<left_on))) eligible_eu_samples,COUNTIF(order_date>DATE '2025-09-20' AND geography_status='valid' AND NOT EXISTS(SELECT 1 FROM EU WHERE code=shipping_country_code AND order_date>=joined AND (left_on IS NULL OR order_date<left_on))) eligible_non_eu_samples FROM base GROUP BY month,channel ORDER BY month,channel`,
    integrity: `SELECT COUNT(*) geography_rows,COUNT(DISTINCT g.order_id) distinct_geography_orders,COUNTIF(o.order_id IS NULL) orphan_rows,COUNTIF(o.source_app_id=@matrixify) matrixify_rows,MAX(g.synced_at) latest_sync,MAX(g.order_updated_at) latest_order_update FROM ${g} g LEFT JOIN ${o} o USING(order_id)`,
    parent_sales: `SELECT COUNT(*) joined_rows,COUNT(DISTINCT o.order_id) distinct_orders,COUNT(DISTINCT f.order_id) financial_orders,SUM(f.original_total_presentment) joined_sales,(SELECT SUM(original_total_presentment) FROM ${f} f2 JOIN ${o} o2 USING(order_id) WHERE o2.source_app_id IS NULL OR o2.source_app_id!=@matrixify) expected_sales FROM ${o} o JOIN ${g} g USING(order_id) LEFT JOIN ${f} f USING(order_id) WHERE o.source_app_id IS NULL OR o.source_app_id!=@matrixify`
    ,example_query: `WITH ${eu}, candidates AS (
      SELECT o.order_id,o.order_name,DATE(o.created_at) order_date,
        IF(o.retail_location_id IS NULL,'online','pos') channel,
        g.shipping_country_name,g.shipping_country_code,
        IF(EXISTS(SELECT 1 FROM EU WHERE code=g.shipping_country_code AND DATE(o.created_at)>=joined AND (left_on IS NULL OR DATE(o.created_at)<left_on)),'eu','non_eu') eu_status,
        f.shop_currency currency,f.original_total_shop source_order_total,
        f.original_discounts_shop source_discount_total,COALESCE(f.total_refunded_shop,0) source_refund_total
      FROM ${o} o JOIN ${g} g USING(order_id) LEFT JOIN ${f} f USING(order_id)
      WHERE DATE(o.created_at)>DATE '2025-09-20' AND g.geography_status='valid'
        AND g.shipping_country_code IS NOT NULL
        AND (o.source_app_id IS NULL OR o.source_app_id!=@matrixify)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY IF(EXISTS(SELECT 1 FROM EU WHERE code=g.shipping_country_code AND DATE(o.created_at)>=joined AND (left_on IS NULL OR DATE(o.created_at)<left_on)),'eu','non_eu') ORDER BY o.created_at DESC,o.order_id)=1
    ) SELECT * FROM candidates ORDER BY eu_status`
  };
}

export function assessOrphans(rows) {
  const totals = rows.reduce((out, row) => {
    out.orphan_rows += Number(row.orphan_rows || 0);
    out.missing_recent_parent_rows += Number(row.missing_recent_parent_rows || 0);
    out.non_financial_state_rows += Number(row.non_financial_state_rows || 0);
    out.possible_id_join_defect_rows += Number(row.possible_id_join_defect_rows || 0);
    return out;
  }, { orphan_rows:0, missing_recent_parent_rows:0, non_financial_state_rows:0, possible_id_join_defect_rows:0 });
  const unexplained = totals.orphan_rows - totals.missing_recent_parent_rows;
  const conclusion = totals.orphan_rows === 0 ? 'no_orphans'
    : totals.possible_id_join_defect_rows > 0 ? 'possible_id_or_join_defect'
      : unexplained > 0 ? 'parent_gap_requires_investigation'
        : 'source_staleness';
  return {
    ...totals,
    rows_not_explained_by_parent_freshness: unexplained,
    conclusion,
    explanation: 'Financial state is aggregate supporting evidence only: /sync-shopify ingests orders without a financial-status filter, so a non-financial state does not justify a missing parent row.'
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
      contract: { read_only:true, pii_free:true, example_query:'not yet measurable', eu_membership:'date-aware diagnostic rule; not persisted on orders' },
      evidence
    };
  }

  for (const name of ['orphan_analysis', 'coverage', 'integrity', 'parent_sales', 'example_query']) {
    evidence[name] = await runStage(bigquery, name, queries[name]);
  }
  evidence.orphan_assessment = assessOrphans(evidence.orphan_analysis);
  const integrity = evidence.integrity[0] || {}, sales = evidence.parent_sales[0] || {};
  const exampleStatuses = new Set(evidence.example_query.map(row => row.eu_status));
  const valid = Number(integrity.geography_rows) === Number(integrity.distinct_geography_orders) && Number(integrity.orphan_rows) === 0 &&
    Number(integrity.matrixify_rows) === 0 && Number(sales.joined_rows) === Number(sales.distinct_orders) && Number(sales.joined_sales) === Number(sales.expected_sales);
  return { valid: valid && exampleStatuses.has('eu') && exampleStatuses.has('non_eu'), phase: 'post_backfill', destination_present: true, contract: { read_only:true, pii_free:true, example_query:'one bounded order per EU status; authorized order reference and source-native finance fields only', eu_membership:'date-aware diagnostic rule; not persisted on orders' }, evidence };
}

async function main() { const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data'; const credentials=JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'null'); if(!credentials) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON'); const result=await diagnose({bigquery:new BigQuery({projectId:project,credentials}),project}); console.log(JSON.stringify(result,null,2)); if(!result.valid) process.exitCode=1; }
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
