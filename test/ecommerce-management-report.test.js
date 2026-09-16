import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareValue,
  createEcommerceManagementReportService,
  deriveReportPeriods
} from '../oracle/ecommerce-management-report.js';

test('derives inclusive, equal-length preceding and explicit prior-year periods', () => {
  assert.deepEqual(deriveReportPeriods('2026-08-01', '2026-08-31'), {
    current: { start_date: '2026-08-01', end_date: '2026-08-31', days: 31 },
    previous_period: { start_date: '2026-07-01', end_date: '2026-07-31', days: 31 },
    prior_year: { start_date: '2025-08-01', end_date: '2025-08-31', days: 31 }
  });
});

test('rejects invalid and reversed report dates', () => {
  assert.throws(() => deriveReportPeriods('2026-02-30', '2026-03-01'), /valid calendar date/);
  assert.throws(() => deriveReportPeriods('2026-09-02', '2026-09-01'), /on or before/);
});

test('comparison leaves a zero denominator percentage undefined', () => {
  assert.deepEqual(compareValue(12, 0), {
    current: 12,
    comparison: 0,
    absolute_change: 12,
    percentage_change: null
  });
});

test('builds a versioned report without combining currencies', async () => {
  const financePeriods = [
    [{ currency: 'GBP', sales_transaction_count: 10, refund_transaction_count: 1, gross_sales: 100, refunds: -10, net_gross: 90, tax: 15, net_ex_tax: 75 },
      { currency: 'USD', sales_transaction_count: 2, refund_transaction_count: 0, gross_sales: 20, refunds: 0, net_gross: 20, tax: 0, net_ex_tax: 20 }],
    [{ currency: 'GBP', sales_transaction_count: 8, refund_transaction_count: 0, gross_sales: 80, refunds: 0, net_gross: 80, tax: 13, net_ex_tax: 67 }],
    [{ currency: 'GBP', sales_transaction_count: 5, refund_transaction_count: 0, gross_sales: 50, refunds: 0, net_gross: 50, tax: 8, net_ex_tax: 42 }]
  ];
  let financeCall = 0;
  const service = createEcommerceManagementReportService({
    getFinanceReport: async () => financePeriods[financeCall++],
    getConversionKpis: async ({ start_date }) => ({ metrics: { sessions: start_date === '2026-08-01' ? 100 : 50, conversion_rate: 0.02 } }),
    getCustomerKpis: async () => ({ overall: { customers: 4 }, customer_types: { New: { customers: 3 }, Returning: { customers: 1 } } }),
    getProductPerformance: async () => ({ products: [{ product_title: 'Ring', net_sales: 40 }] })
  });

  const report = await service({ start_date: '2026-08-01', end_date: '2026-08-31' });
  assert.equal(report.report_type, 'ecommerce_management');
  assert.equal(report.version, '1.0');
  assert.deepEqual(report.finance.current.map(row => row.currency), ['GBP', 'USD']);
  assert.equal(report.finance.comparisons.previous_period[0].metrics.net_gross.absolute_change, 10);
  assert.equal(report.finance.comparisons.previous_period[1].metrics.net_gross.comparison, null);
  assert.equal(report.conversion.comparisons.previous_period.sessions.percentage_change, 100);
  assert.equal(report.products.current[0].product_title, 'Ring');
  assert.equal(report.freshness.finance, null);
});
