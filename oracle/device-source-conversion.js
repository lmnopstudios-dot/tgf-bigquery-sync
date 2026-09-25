import { assertDate } from '../ga4/semantic.js';

export const DEVICE_SOURCE_CONVERSION_TOOL_DEFINITION = {
  type: 'function', name: 'compare_device_source_conversion_around_launch', strict: true,
  description: 'Compare GA4 desktop/mobile conversion before and after a verified Shopify launch boundary at the native device × session traffic-source grain. Requires explicit periods: this tool never guesses the launch date and never divides Shopify orders by GA4 sessions.',
  parameters: { type: 'object', additionalProperties: false, properties: {
    before_start: { type: 'string' }, before_end: { type: 'string' }, after_start: { type: 'string' }, after_end: { type: 'string' },
    launch_date: { type: 'string', description: 'The separately governed, verified Shopify launch date.' },
    launch_evidence: { type: 'string', description: 'Human-readable governed record or evidence reference supporting launch_date.' }
  }, required: ['before_start','before_end','after_start','after_end','launch_date','launch_evidence'] }
};

const safeId = value => { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid BigQuery identifier'); return value; };
export function comparisonQuery(project, dataset = 'ga4') {
  safeId(project); safeId(dataset);
  return `WITH periods AS (SELECT 'before' period,@before_start start_date,@before_end end_date UNION ALL SELECT 'after',@after_start,@after_end),
cells AS (SELECT p.period,c.device_category,c.session_default_channel_group,c.session_source,c.session_medium,SUM(c.sessions) sessions,SUM(c.ecommerce_purchases) ecommerce_purchases,COUNT(DISTINCT c.date) observed_dates FROM periods p JOIN \`${project}.${dataset}.conversion_breakdown\` c ON c.date BETWEEN p.start_date AND p.end_date WHERE c.device_category IN ('desktop','mobile') GROUP BY 1,2,3,4,5),
quality AS (SELECT p.period,COUNT(DISTINCT d.date) expected_dates,COUNTIF(d.ecommerce_reliable) reliable_dates,COUNTIF(d.ecommerce_observed) observed_ecommerce_dates FROM periods p LEFT JOIN \`${project}.${dataset}.daily\` d ON d.date BETWEEN p.start_date AND p.end_date GROUP BY 1)
SELECT c.*,q.expected_dates,q.reliable_dates,q.observed_ecommerce_dates FROM cells c JOIN quality q USING(period) ORDER BY session_default_channel_group,session_source,session_medium,device_category,period`;
}

export function createDeviceSourceConversionService({ bigquery, project, dataset = 'ga4' }) {
  return async args => {
    for (const key of ['before_start','before_end','after_start','after_end','launch_date']) assertDate(args[key], key);
    if (!String(args.launch_evidence || '').trim()) throw new Error('launch_evidence is required; the launch date must not be guessed');
    if (args.before_start > args.before_end || args.after_start > args.after_end || args.before_end >= args.launch_date || args.after_start < args.launch_date) throw new Error('Periods must be ordered on their respective sides of launch_date');
    const dateKeys = ['before_start','before_end','after_start','after_end'];
    const [rows] = await bigquery.query({ query: comparisonQuery(project, dataset), params: Object.fromEntries(dateKeys.map(key => [key, args[key]])), types: Object.fromEntries(dateKeys.map(key => [key, 'DATE'])), labels: { component: 'oracle_device_source_conversion' } });
    const keyed = new Map(rows.map(row => [[row.period,row.device_category,row.session_default_channel_group,row.session_source,row.session_medium].join('\0'), row]));
    const dimensions = [...new Set(rows.map(row => [row.session_default_channel_group,row.session_source,row.session_medium].join('\0')))];
    const cells = [];
    for (const source of dimensions) for (const device of ['desktop','mobile']) {
      const [channel, sessionSource, medium] = source.split('\0');
      const periods = Object.fromEntries(['before','after'].map(period => {
        const row = keyed.get([period,device,channel,sessionSource,medium].join('\0'));
        if (!row) return [period, { availability: 'unavailable', reason: 'No persisted GA4 row exists for this device × source cell.', sessions: null, ecommerce_purchases: null, conversion_rate: null }];
        const reliable = Number(row.reliable_dates) === Number(row.expected_dates) && Number(row.expected_dates) > 0;
        return [period, { availability: reliable ? 'available' : 'observed_but_not_reliable_for_platform_effect', sessions: Number(row.sessions), ecommerce_purchases: Number(row.ecommerce_purchases), conversion_rate: reliable && Number(row.sessions) ? Number(row.ecommerce_purchases) / Number(row.sessions) : null,
          observed_rate: Number(row.sessions) ? Number(row.ecommerce_purchases) / Number(row.sessions) : null, observed_dates: Number(row.observed_dates), expected_dates: Number(row.expected_dates) }];
      }));
      cells.push({ device_category: device, session_default_channel_group: channel, session_source: sessionSource, session_medium: medium, periods,
        comparable_platform_effect: periods.before.availability === 'available' && periods.after.availability === 'available' });
    }
    return { question: 'Compare desktop and mobile conversion before and after the Shopify launch, broken down by traffic source.', launch_boundary: { date: args.launch_date, evidence: args.launch_evidence, supplied_not_inferred: true },
      methods: { ga4_same_grain: 'GA4 ecommercePurchases / GA4 sessions from the same device × session channel × session source/medium rows.', shopify_native: 'Shopify Online Store sessions conversion is governed for overall/time-series reporting, but no governed device × traffic-source joint grain is established; those cells are unavailable.' },
      periods: { before: { start_date: args.before_start, end_date: args.before_end, platform: 'WooCommerce' }, after: { start_date: args.after_start, end_date: args.after_end, platform: 'Shopify' } }, cells,
      limitations: ['GA4 is behavioural measurement, not order truth.', 'Observed but unreliable rates are diagnostic only and are not presented as a like-for-like platform effect.', 'Shopify order counts are never divided by GA4 sessions.', 'Missing device × source cells are explicitly returned as unavailable.'] };
  };
}

export async function executeDeviceSourceConversionToolCall(service, name, args) {
  if (name !== DEVICE_SOURCE_CONVERSION_TOOL_DEFINITION.name) return { handled: false, result: null };
  return { handled: true, result: await service(args) };
}
