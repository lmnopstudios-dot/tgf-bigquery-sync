import { readFileSync } from 'node:fs';
import { createHistoricalEventDependencies } from '../../oracle/historical-event-provider.js';
import { createOracleBaselineDispatcher } from '../../oracle/baseline-dispatcher.js';
import { createMemoryExportStore } from '../../oracle/product-priority-storage.js';
export const multiPeriodPrompt = readFileSync(
  new URL('../fixtures/multi-period-daily-sales/request.txt', import.meta.url),
  'utf8'
).trimEnd();
export function multiPeriodFixture({
  failRefunds = false,
  failDaily = false,
  discrepancy = false
} = {}) {
  const queries = [];
  const knowledgeService = { searchKnowledge: async () => ({ items: [] }) };
  const bigquery = {
    dataset: () => ({ getMetadata: async () => [{ location: 'US' }] }),
    query: async (q) => {
      queries.push(q);
      if (/square_data|canonical_finance|product_mappings/.test(q.query))
        throw Error('Wrong provider selected');
      const daily = /\) date,/.test(q.query),
        refund = q.query.includes("'refund' transaction_type"),
        woo = q.query.includes('metorik_');
      if (failRefunds && refund && woo)
        throw Object.assign(Error('unavailable fixture'), {
          code: 'REFUND_SOURCE_UNAVAILABLE'
        });
      if (failDaily && daily && q.params.sale_channel === 'instore')
        throw Object.assign(Error('unavailable fixture'), {
          code: 'DAILY_READ_FAILED'
        });
      const source = woo
        ? 'WooCommerce ' + (q.query.includes('metorik_uk') ? 'ww' : 'usd')
        : q.params.sale_channel === 'online'
          ? 'Shopify Online Store'
          : q.params.sale_channel === 'instore'
            ? 'Shopify POS'
            : 'Shopify Unknown';
      const currency = source.endsWith('usd') ? 'USD' : 'GBP',
        channel = woo ? 'Online' : q.params.sale_channel;
      const dates = q.params.start_at.startsWith('2024')
        ? ['2024-11-08', '2024-11-09', '2024-11-10']
        : q.params.start_at.startsWith('2025')
          ? ['2025-11-27', '2025-11-28', '2025-11-29', '2025-11-30']
          : ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04'];
      const rows = dates.map((date, i) => ({
        date,
        source,
        channel,
        currency,
        transaction_type: refund ? 'refund' : 'sale',
        amount: refund ? -1 : (i + 1) * 10,
        missing_amounts: 0,
        ...(refund ? { refund_events: 1 } : { transaction_count: 1 })
      }));
      return [
        daily
          ? rows
          : [
              {
                ...rows[0],
                date: undefined,
                amount:
                  rows.reduce((n, r) => n + r.amount, 0) +
                  (discrepancy && !refund ? 2 : 0)
              }
            ]
      ];
    }
  };
  const deps = createHistoricalEventDependencies({
    bigquery,
    project: 'fixture',
    knowledgeService,
    now: () => new Date('2026-11-05T12:00:00Z')
  });
  return {
    bigquery,
    queries,
    exportStore: createMemoryExportStore(),
    baseline: createOracleBaselineDispatcher({
      historicalEventComparison: deps.historicalEventComparison
    })
  };
}

export const liveMultiPeriodPrompt = readFileSync(
  new URL(
    '../fixtures/multi-period-daily-sales/live-request.txt',
    import.meta.url
  ),
  'utf8'
).trimEnd();
