import { reportPeriod } from './report-period.js';

export const REPORT_SECTIONS = Object.freeze(['overview', 'sales', 'customers', 'products', 'geography', 'acquisition', 'organic', 'context']);
export const REPORT_DEFINITIONS = Object.freeze({
  net_gross: 'Canonical finance gross sales less accounting refunds, within one currency.',
  orders: 'Canonical finance sale transaction count; not a GA4 transaction count.',
  product_sales: 'Persisted source line-item sales; operational evidence, not canonical finance.',
  conversion: 'GA4 behavioural ecommerce conversion; not a finance metric.',
  first_observed: 'First purchase visible in governed evidence, not necessarily first-ever purchase.'
});

const DAY = 86400000;
const shift = (date, days) => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
const state = (rows, coverage = null) => ({ status: rows.length ? 'available' : 'unavailable', available: rows.length > 0, coverage });
export function periodAvailability(currentRows, comparisonRows, options = {}) {
  const current = state(currentRows, options.currentCoverage || null), comparison = state(comparisonRows, options.comparisonCoverage || null);
  const comparable = current.available && comparison.available && options.semanticMismatch !== true;
  return { current, comparison, comparability: comparable ? 'comparable' : current.available && comparison.available ? 'not_directly_comparable' : 'comparison_unavailable' };
}
const placeholder = (section, message) => ({ section, status: 'unavailable', rows: [], limitations: [message] });

export function createEcommerceReportV2({ bigquery, project, knowledgeService }) {
  const query = async (sql, params) => (await bigquery.query({ query: sql, params, maximumBytesBilled: '5000000000', useLegacySql: false }))[0];
  async function finance(period) {
    return query(`SELECT FORMAT_DATE('%Y-%m-%d', date) date, currency,
      SUM(IF(transaction_type='sale', gross, 0)) gross_sales, SUM(IF(transaction_type='refund', gross, 0)) refunds,
      SUM(gross) net_gross, COUNTIF(transaction_type='sale') orders, COALESCE(channel, 'Unclassified') channel
      FROM \`${project}.finance.accountant_transactions\` WHERE date BETWEEN @start_date AND @end_date
      GROUP BY date, currency, channel ORDER BY date, currency, channel`, period);
  }
  async function ga4(period) {
    return query(`SELECT FORMAT_DATE('%Y-%m-%d', date) date, SUM(sessions) sessions, SUM(total_users) total_users,
      SUM(new_users) new_users, SUM(engaged_sessions) engaged_sessions, SAFE_DIVIDE(SUM(engaged_sessions),SUM(sessions)) engagement_rate
      FROM \`${project}.ga4.daily\` WHERE date BETWEEN @start_date AND @end_date GROUP BY date ORDER BY date`, period);
  }
  async function searchConsole(period) {
    return query(`WITH selected AS (
      SELECT * EXCEPT(choice) FROM (SELECT date, clicks, impressions, position, source_property, property_scope,
        ROW_NUMBER() OVER(PARTITION BY date ORDER BY IF(property_scope='domain',0,1), source_property) choice
        FROM \`${project}.search_console.daily\` WHERE date BETWEEN @start_date AND @end_date AND coverage_status='available') WHERE choice=1)
      SELECT FORMAT_DATE('%Y-%m-%d', date) date, clicks, impressions, SAFE_DIVIDE(clicks,impressions) ctr, position,
        source_property selected_source_property, property_scope selected_property_scope FROM selected ORDER BY date`, period);
  }
  const aggregate = rows => [...rows.reduce((map, row) => { const key=row.currency,item=map.get(key)||{currency:key,net_gross:0,gross_sales:0,refunds:0,orders:0}; for(const metric of ['net_gross','gross_sales','refunds','orders'])item[metric]+=Number(row[metric]||0);map.set(key,item);return map;},new Map()).values()];
  async function contextFor(period) {
    // A small look-behind captures deadlines immediately affecting the period. Each
    // side is queried separately so ranking/limits on one period cannot crowd out the other.
    const requested = { start_date: shift(period.start_date, -14), end_date: period.end_date, topics: [] };
    const result = knowledgeService.getBusinessContext ? await knowledgeService.getBusinessContext(requested) : await knowledgeService.searchKnowledge({ text:null,knowledge_type:null,start_date:requested.start_date,end_date:requested.end_date,status:'confirmed',tags:[],limit:20 });
    return (result.items||[]).filter(x=>!['rejected','superseded'].includes(x.status)).map(item=>({ ...item, temporal_relation: item.effective_to && item.effective_to < period.start_date ? 'nearby_before_period' : 'overlaps_period' }));
  }
  return async function load(section, raw = {}) {
    if (!REPORT_SECTIONS.includes(section)) throw new Error('Unknown report section');
    const periods=reportPeriod(raw),generated_at=new Date().toISOString();
    const base={section,generated_at,period:periods.current,comparison:periods.comparison,comparison_type:periods.comparison.mode};
    if(section==='overview'||section==='sales'){
      const [current,comparison]=await Promise.all([finance(periods.current),finance(periods.comparison)]),totals=aggregate(current),prior=new Map(aggregate(comparison).map(x=>[x.currency,x]));
      const kpis=totals.flatMap(row=>['net_gross','orders','refunds'].map(metric=>({metric,label:({net_gross:'Net sales',orders:'Transactions',refunds:'Refunds'})[metric],currency:metric==='orders'?null:row.currency,value:row[metric],comparison_value:prior.get(row.currency)?.[metric]??null})));
      return {...base,status:current.length?'available':'unavailable',definitions:REPORT_DEFINITIONS,currencies:totals.map(x=>x.currency),kpis,trend:current,rows:current,evidence_availability:{finance:periodAvailability(current,comparison)},limitations:['Canonical finance is authoritative for business sales.','Currencies are reported separately and never converted.','Data is persisted BigQuery evidence and is not labelled live.']};
    }
    if(section==='context'){
      const [current,comparison]=await Promise.all([contextFor(periods.current),contextFor(periods.comparison)]),availability=periodAvailability(current,comparison);
      return {...base,status:current.length||comparison.length?'available':'unavailable',rows:current,context:{current,comparison},kpis:[],trend:[],evidence_availability:{knowledge:availability},limitations:current.length||comparison.length?['Nearby context is limited to the 14 days before each period and must be materially relevant.']:['No confirmed Knowledge overlaps or is materially near either selected period.']};
    }
    if(section==='organic'||section==='acquisition'){
      const loader=section==='organic'?searchConsole:ga4,[current,comparison]=await Promise.all([loader(periods.current),loader(periods.comparison)]),availability=periodAvailability(current,comparison);
      const source=section==='organic'?'Persisted governed Search Console; Domain property is preferred daily, with www fallback, and overlapping properties are never summed.':'Persisted governed GA4; platform-native sessions are not substituted.';
      return {...base,status:current.length||comparison.length?'available':'unavailable',rows:current,comparison_rows:comparison,kpis:[],trend:current,currencies:[],evidence_availability:{[section==='organic'?'search_console':'ga4']:availability},limitations:[source,availability.comparability==='comparison_unavailable'?'Evidence is available for only one period; no direct period comparison is made.':'Availability was assessed independently for both periods.']};
    }
    const messages={customers:'Customer evidence must be assessed by source period; different platform identity/guest semantics are available but not directly comparable, not absent.',products:'Woo and Shopify product evidence may be ranked within each source, but there is no governed cross-source product identity bridge.',geography:'Direct observed geography must be assessed independently for each period.'};
    return {...base,...placeholder(section,messages[section]),kpis:[],trend:[],currencies:[],evidence_availability:{[section]:{current:{status:'not_assessed'},comparison:{status:'not_assessed'},comparability:'not_assessed'}}};
  };
}
