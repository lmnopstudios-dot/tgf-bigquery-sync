import { bigQueryDateParameters } from '../bigquery/date-parameters.js';

export const ANNUAL_LOCATION_OBSERVATION_END = '2026-09-30';
export const ANNUAL_LOCATION_MAX_BYTES = 5_000_000_000;

function assertDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error(`${name} must be YYYY-MM-DD`);
}

/**
 * Accountant-facing finance comes from the governed ledger rather than an
 * inventory or fulfilment selector. NULL source amounts remain NULL evidence;
 * the query never turns absent tax into zero.
 */
export function annualLocationFinanceQuery(project) {
  return `WITH bounded AS (
    SELECT date,LOWER(transaction_type) transaction_type,
      COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') sales_location,
      COALESCE(NULLIF(TRIM(channel),''),'Unknown / unallocated') sales_channel,
      COALESCE(NULLIF(TRIM(source),''),'Unknown / unallocated') source,
      UPPER(currency) currency,CAST(gross AS NUMERIC) gross,
      CAST(tax AS NUMERIC) recorded_tax,CAST(net_ex_tax AS NUMERIC) net_ex_tax
    FROM \`${project}.finance.accountant_transactions\`
    WHERE date BETWEEN @start_date AND @end_date
      AND (@currency IS NULL OR UPPER(currency)=UPPER(@currency))
      AND LOWER(transaction_type) IN ('sale','refund')
  ), grouped AS (
    SELECT EXTRACT(YEAR FROM date) year,
      IF(GROUPING(sales_location)=1,'__ALL_LOCATIONS__',sales_location) sales_location,
      currency,MIN(date) earliest_evidence,MAX(date) latest_evidence,
      COUNT(*) transaction_count,COUNTIF(transaction_type='sale') sale_transactions,
      COUNTIF(transaction_type='refund') refund_transactions,
      COUNTIF(recorded_tax IS NOT NULL) tax_evidence_records,
      COUNTIF(recorded_tax IS NULL) missing_tax_records,
      COUNTIF(net_ex_tax IS NULL) missing_ex_tax_records,
      SUM(IF(transaction_type='sale',net_ex_tax,NULL)) sales_excluding_recorded_tax,
      SUM(IF(transaction_type='refund',net_ex_tax,NULL)) refunds_excluding_recorded_tax,
      SUM(net_ex_tax) observed_net_sales_excluding_recorded_tax,
      SUM(IF(transaction_type='sale',recorded_tax,NULL)) recorded_tax_on_sales,
      SUM(IF(transaction_type='refund',recorded_tax,NULL)) recorded_tax_reversed_on_refunds,
      SUM(recorded_tax) observed_net_recorded_tax_after_refunds,
      SUM(gross) net_amount_including_recorded_tax
    FROM bounded
    GROUP BY GROUPING SETS ((EXTRACT(YEAR FROM date),sales_location,currency),(EXTRACT(YEAR FROM date),currency))
  ) SELECT *,
    IF(missing_ex_tax_records=0,observed_net_sales_excluding_recorded_tax,NULL) net_sales_excluding_recorded_tax,
    IF(missing_tax_records=0,observed_net_recorded_tax_after_refunds,NULL) net_recorded_tax_after_refunds,
    IF(missing_tax_records=0 AND missing_ex_tax_records=0,
      observed_net_sales_excluding_recorded_tax+observed_net_recorded_tax_after_refunds-net_amount_including_recorded_tax,NULL) stored_component_difference,
    IF(missing_tax_records=0,'complete_for_observed_ledger_rows',
      IF(tax_evidence_records=0,'recorded_tax_unavailable','partial_recorded_tax_evidence')) tax_coverage
  FROM grouped ORDER BY year,currency,sales_location`;
}

function amount(value) {
  return value === null || value === undefined ? null : Number(value);
}

function normalize(row, observationEnd) {
  const year=Number(row.year);
  const numeric=['transaction_count','sale_transactions','refund_transactions','tax_evidence_records','missing_tax_records','missing_ex_tax_records','sales_excluding_recorded_tax','refunds_excluding_recorded_tax','observed_net_sales_excluding_recorded_tax','recorded_tax_on_sales','recorded_tax_reversed_on_refunds','observed_net_recorded_tax_after_refunds','net_amount_including_recorded_tax','net_sales_excluding_recorded_tax','net_recorded_tax_after_refunds','stored_component_difference'];
  const result={...row,year};
  for(const key of numeric) result[key]=amount(row[key]);
  result.period_label=year===Number(observationEnd.slice(0,4))?`${year} YTD through ${observationEnd}`:`${year} observed calendar-year evidence`;
  result.coverage={status:row.tax_coverage,earliest_evidence:String(row.earliest_evidence?.value||row.earliest_evidence),latest_evidence:String(row.latest_evidence?.value||row.latest_evidence),not_a_completeness_claim:true};
  return result;
}

export function createAnnualLocationFinanceService({bigquery,project,observationEnd=ANNUAL_LOCATION_OBSERVATION_END}) {
  return async function getAnnualLocationFinance({start_year=2022,end_year=2026,currency=null}={}) {
    const startYear=Number(start_year),endYear=Number(end_year);
    if(!Number.isInteger(startYear)||!Number.isInteger(endYear)||startYear<2022||endYear<startYear) throw new Error('year range must start in 2022 or later and be ordered');
    assertDate(observationEnd,'observation end');
    const observationYear=Number(observationEnd.slice(0,4));
    if(endYear>observationYear) throw new Error(`end_year cannot exceed observation year ${observationYear}`);
    const start_date=`${startYear}-01-01`;
    const requestedEnd=`${endYear}-12-31`;
    const end_date=requestedEnd<observationEnd?requestedEnd:observationEnd;
    const options={query:annualLocationFinanceQuery(project),params:{...bigQueryDateParameters({start_date,end_date}),currency},types:{start_date:'DATE',end_date:'DATE',currency:'STRING'},useLegacySql:false,maximumBytesBilled:ANNUAL_LOCATION_MAX_BYTES,labels:{component:'oracle_annual_location_finance'}};
    const [rows]=await bigquery.query(options);
    const normalized=rows.map(row=>normalize(row,observationEnd));
    const totals=normalized.filter(row=>row.sales_location==='__ALL_LOCATIONS__');
    const locations=normalized.filter(row=>row.sales_location!=='__ALL_LOCATIONS__');
    const reconciliation=totals.map(total=>{
      const peers=locations.filter(row=>row.year===total.year&&row.currency===total.currency);
      const sum=key=>peers.reduce((n,row)=>n+(row[key]??0),0);
      const diff=key=>total[key]===null||peers.some(row=>row[key]===null)?null:Number((sum(key)-total[key]).toFixed(6));
      return {year:total.year,currency:total.currency,location_rows:peers.length,net_sales_excluding_recorded_tax_difference:diff('net_sales_excluding_recorded_tax'),net_recorded_tax_difference:diff('net_recorded_tax_after_refunds'),net_amount_including_recorded_tax_difference:diff('net_amount_including_recorded_tax'),status:['net_sales_excluding_recorded_tax','net_recorded_tax_after_refunds','net_amount_including_recorded_tax'].every(key=>diff(key)===0)?'reconciled':'unreconciled_or_incomplete'};
    });
    return {contract:{measure_label:'recorded tax',tax_is_vat_liability:false,discounts:'stored gross and net_ex_tax are after the discounts applied by the governed upstream ledger; discounts are not recomputed',location_dimension:'source-recorded sales/POS location; never fulfilment or inventory location',shipping:'not separately exposed by finance.accountant_transactions; ledger gross/net_ex_tax definitions may include shipping according to source construction',refund_date_policy:'ledger transaction date; refunds remain in the recorded refund period',currency:'source-native; no FX conversion',identity:'finance.accountant_transactions inherits governed migration/Matrixify deduplication; this report does not join overlapping native representations',null_policy:'missing tax evidence is null/unknown, never inferred zero',rounding:'stored net_ex_tax is preserved; stored_component_difference exposes disagreement with gross minus recorded tax'},period:{start_date,end_date,observation_end:observationEnd,reporting_timezone:'ledger DATE (upstream reporting timezone must be verified in production metadata)'},locations,yearly_totals:totals,reconciliation};
  };
}
