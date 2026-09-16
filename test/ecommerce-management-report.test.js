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
  assert.equal(report.version, '1.1');
  assert.deepEqual(report.finance.current.map(row => row.currency), ['GBP', 'USD']);
  assert.equal(report.finance.comparisons.previous_period[0].metrics.net_gross.absolute_change, 10);
  assert.equal(report.finance.comparisons.previous_period[1].metrics.net_gross.comparison, null);
  assert.equal(report.conversion.comparisons.previous_period.sessions.percentage_change, 100);
  assert.equal(report.products.current[0].product_title, 'Ring');
  assert.equal(report.freshness.finance, null);
});

test('uses Metorik customer and product evidence without manufacturing identity or conversion continuity', async () => {
  const historical = {
    source: 'metorik_uk',
    system: 'Metorik / WooCommerce',
    dataset: 'metorik_uk',
    available: true,
    customers: {
      by_currency: [{
        currency: 'GBP',
        orders: 30,
        registered_purchasing_customers: 20,
        canonical_new_customers: 12,
        guest_orders: 5,
        orders_per_registered_customer: 1.5
      }]
    },
    products: [{
      currency: 'GBP', product_id: 7, variation_id: 9, sku: 'WOO-7',
      quantity_sold: 4, order_count: 3, gross_line_sales: 400, net_line_sales: 360
    }]
  };
  const service = createEcommerceManagementReportService({
    getFinanceReport: async () => [{ currency: 'GBP', net_gross: 100 }],
    getConversionKpis: async ({ start_date }) => {
      if (start_date === '2025-08-01') throw new Error('Shopify unavailable');
      return { metrics: { sessions: 100, conversion_rate: 0.02 } };
    },
    getCustomerKpis: async ({ start_date }) => {
      if (start_date === '2025-08-01') throw new Error('Shopify unavailable');
      return {
        overall: { customers: 25, new_customers: 15, returning_customers: 10, returning_customer_rate: 0.4, orders: 35 },
        customer_types: {}
      };
    },
    getProductPerformance: async () => ({ products: [{ product_id: 'shopify-7', product_title: 'Ring', net_sales: 500 }] }),
    getHistoricalEcommerce: async period => ({
      sources: period.start_date === '2025-08-01'
        ? [{ ...historical, period }]
        : []
    })
  });

  const report = await service({ start_date: '2026-08-01', end_date: '2026-08-31' });
  const comparison = report.customers.cross_platform_comparisons.prior_year[0]
    .metrics_by_currency[0];
  assert.equal(comparison.purchasing_customers.comparison, 20);
  assert.equal(comparison.new_customers.comparison, 12);
  assert.equal(comparison.orders_per_customer.comparison, 1.5);
  assert.equal(comparison.purchasing_customers.comparability.level, 'directional');
  assert.equal(comparison.returning_customers.comparison, null);
  assert.equal(comparison.returning_customers.comparability.level, 'unavailable');
  assert.equal(report.conversion.comparisons.prior_year, null);
  assert.equal(report.conversion.comparability.prior_year.level, 'unavailable');
  assert.equal(report.products.historical.prior_year[0].products[0].product_id, 7);
  assert.equal(report.products.current[0].product_id, 'shopify-7');
  assert.equal(report.products.cross_platform_comparability.level, 'not_comparable');
  assert.match(report.customers.identity_models.metorik_canonical, /metorik_customer_id/);
  assert.match(report.customers.identity_models.woo_order_level, /Woo customer_id/);
  assert.ok(report.evidence.some(item =>
    item.dataset === 'metorik_uk' &&
    item.metric_family === 'historical_ecommerce_customers' &&
    item.comparability_level === 'directional'
  ));
  assert.ok(report.limitations.some(item => item.includes('session-based conversion')));
});

test('keeps currencies and mixed platform sources isolated and degrades gracefully without history', async () => {
  const historical = period => ({
    sources: [{
      source: 'metorik_us',
      system: 'Metorik / WooCommerce',
      dataset: 'metorik_us',
      period,
      available: true,
      customers: {
        by_currency: [{ currency: 'USD', orders: 2, registered_purchasing_customers: 1 }]
      },
      products: []
    }]
  });
  let historyCall = 0;
  const service = createEcommerceManagementReportService({
    getFinanceReport: async () => [{ currency: 'GBP', net_gross: 1 }, { currency: 'USD', net_gross: 2 }],
    getConversionKpis: async () => ({ metrics: { sessions: 1 } }),
    getCustomerKpis: async () => ({ overall: { customers: 1, orders: 1 }, customer_types: {} }),
    getProductPerformance: async () => ({ products: [] }),
    getHistoricalEcommerce: async period => {
      historyCall++;
      if (historyCall === 1) return historical(period);
      if (historyCall === 2) throw new Error('history unavailable');
      return { sources: [{ available: false }] };
    }
  });

  const report = await service({ start_date: '2026-08-01', end_date: '2026-08-31' });
  assert.equal(report.ecommerce_sources.current.boundary, 'mixed_source_period_not_merged');
  assert.deepEqual(report.customers.historical.current[0].customers.by_currency.map(row => row.currency), ['USD']);
  assert.deepEqual(report.finance.current.map(row => row.currency), ['GBP', 'USD']);
  assert.deepEqual(report.customers.historical.previous_period, []);
  assert.deepEqual(report.customers.historical.prior_year, []);
  assert.equal(report.customers.cross_platform_comparisons.prior_year, null);
});
