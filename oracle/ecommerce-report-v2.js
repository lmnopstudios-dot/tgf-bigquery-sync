import { reportPeriod } from './report-period.js';

export const REPORT_SECTIONS = Object.freeze(['overview', 'sales', 'customers', 'products', 'geography', 'acquisition', 'organic', 'context']);
export const REPORT_DEFINITIONS = Object.freeze({
  net_gross: 'Canonical finance gross sales less accounting refunds, within one currency.',
  orders: 'Canonical finance sale transaction count; not a GA4 transaction count.',
  product_sales: 'Persisted source line-item sales; operational evidence, not canonical finance.',
  conversion: 'GA4 behavioural ecommerce conversion; not a finance metric.',
  first_observed: 'First purchase visible in governed evidence, not necessarily first-ever purchase.'
});

const placeholder = (section, message) => ({ section, status: 'unavailable', rows: [], limitations: [message] });

export function createEcommerceReportV2({ bigquery, project, knowledgeService }) {
  const query = async (sql, params) => (await bigquery.query({ query: sql, params, maximumBytesBilled: '5000000000', useLegacySql: false }))[0];
  async function finance(period) {
    return query(`SELECT FORMAT_DATE('%Y-%m-%d', date) date, currency,
      SUM(IF(transaction_type='sale', gross, 0)) gross_sales,
      SUM(IF(transaction_type='refund', gross, 0)) refunds,
      SUM(gross) net_gross,
      COUNTIF(transaction_type='sale') orders,
      COALESCE(channel, 'Unclassified') channel
      FROM \`${project}.finance.accountant_transactions\`
      WHERE date BETWEEN @start_date AND @end_date
      GROUP BY date, currency, channel ORDER BY date, currency, channel`, period);
  }
  const aggregate = rows => [...rows.reduce((map, row) => {
    const key = row.currency; const item = map.get(key) || { currency: key, net_gross: 0, gross_sales: 0, refunds: 0, orders: 0 };
    for (const metric of ['net_gross','gross_sales','refunds','orders']) item[metric] += Number(row[metric] || 0); map.set(key, item); return map;
  }, new Map()).values()];
  return async function load(section, raw = {}) {
    if (!REPORT_SECTIONS.includes(section)) throw new Error('Unknown report section');
    const periods = reportPeriod(raw); const generated_at = new Date().toISOString();
    if (section === 'overview' || section === 'sales') {
      const [current, comparison] = await Promise.all([finance(periods.current), finance(periods.comparison)]);
      const totals = aggregate(current), prior = new Map(aggregate(comparison).map(x => [x.currency, x]));
      const kpis = totals.flatMap(row => ['net_gross','orders','refunds'].map(metric => ({ metric, label: ({net_gross:'Net sales',orders:'Transactions',refunds:'Refunds'})[metric], currency: metric === 'orders' ? null : row.currency, value: row[metric], comparison_value: prior.get(row.currency)?.[metric] ?? null })));
      return { section, status: current.length ? 'available' : 'unavailable', generated_at, period: periods.current, comparison: periods.comparison, definitions: REPORT_DEFINITIONS, currencies: totals.map(x=>x.currency), kpis, trend: current, rows: current, limitations: ['Canonical finance is authoritative for business sales.', 'Currencies are reported separately and never converted.', 'Data is persisted BigQuery evidence and is not labelled live.'] };
    }
    if (section === 'context') {
      const result = await knowledgeService.searchKnowledge({ text: null, knowledge_type: null, start_date: periods.current.start_date, end_date: periods.current.end_date, status: 'confirmed', tags: [], limit: 50 });
      const rows = (result.items || []).filter(x => !['rejected','superseded'].includes(x.status));
      return { section, status: rows.length ? 'available' : 'unavailable', generated_at, period: periods.current, comparison: periods.comparison, rows, context: rows, kpis: [], trend: [], limitations: rows.length ? [] : ['No confirmed Knowledge overlaps the selected period.'] };
    }
    const messages = {
      customers: 'Customer report evidence is not exposed by the persisted Report v2 adapter yet; missing values are not zero.',
      products: 'Persisted Woo, Shopify and Square line-item evidence exists, but a governed cross-source product identity bridge is incomplete; no combined ranking is fabricated.',
      geography: 'Direct shipping-country evidence is not available through this bounded report adapter for the selected period.',
      acquisition: 'Persisted GA4 acquisition evidence is distinct from canonical finance and is not available through this adapter.',
      organic: 'Canonical Search Console property selection is not available through this adapter; overlapping Domain and www properties will never be summed.'
    };
    return { ...placeholder(section, messages[section]), generated_at, period: periods.current, comparison: periods.comparison, kpis: [], trend: [], currencies: [] };
  };
}
