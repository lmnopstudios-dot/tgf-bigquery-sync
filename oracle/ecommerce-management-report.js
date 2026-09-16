const REPORT_VERSION = '1.0';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value, name) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error(`${name} must be a date in YYYY-MM-DD format`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid calendar date`);
  }
  return date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

function shiftOneYear(date) {
  const shifted = new Date(date);
  shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
  // Make 29 February compare with 28 February rather than 1 March.
  if (shifted.getUTCMonth() !== date.getUTCMonth()) {
    shifted.setUTCDate(0);
  }
  return shifted;
}

export function deriveReportPeriods(startDate, endDate) {
  const start = parseDate(startDate, 'start_date');
  const end = parseDate(endDate, 'end_date');
  if (start > end) throw new Error('start_date must be on or before end_date');

  const days = Math.round((end - start) / 86400000) + 1;
  return {
    current: { start_date: startDate, end_date: endDate, days },
    previous_period: {
      start_date: formatDate(shiftDays(start, -days)),
      end_date: formatDate(shiftDays(start, -1)),
      days
    },
    prior_year: {
      start_date: formatDate(shiftOneYear(start)),
      end_date: formatDate(shiftOneYear(end)),
      days: Math.round((shiftOneYear(end) - shiftOneYear(start)) / 86400000) + 1
    }
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function compareValue(currentValue, comparisonValue) {
  const current = finiteNumber(currentValue);
  const comparison = finiteNumber(comparisonValue);
  if (current === null || comparison === null) {
    return { current, comparison, absolute_change: null, percentage_change: null };
  }
  const absoluteChange = current - comparison;
  return {
    current,
    comparison,
    absolute_change: absoluteChange,
    percentage_change: comparison === 0 ? null : (absoluteChange / Math.abs(comparison)) * 100
  };
}

function indexBy(rows, key) {
  return new Map((rows || []).map(row => [row[key], row]));
}

const FINANCE_METRICS = [
  'sales_transaction_count', 'refund_transaction_count', 'gross_sales',
  'refunds', 'net_gross', 'tax', 'net_ex_tax'
];

function financeComparison(currentRows, comparisonRows) {
  const comparisonByCurrency = indexBy(comparisonRows, 'currency');
  return (currentRows || []).map(current => {
    const comparison = comparisonByCurrency.get(current.currency) || {};
    return {
      currency: current.currency,
      metrics: Object.fromEntries(FINANCE_METRICS.map(metric => [
        metric,
        compareValue(current[metric], comparison[metric])
      ]))
    };
  });
}

function metricComparison(current, comparison) {
  if (!current || !comparison) return null;
  const keys = Object.keys(current).filter(key => finiteNumber(current[key]) !== null);
  return Object.fromEntries(keys.map(key => [key, compareValue(current[key], comparison[key])]));
}

function fulfilled(result) {
  return result.status === 'fulfilled' ? result.value : null;
}

export function createEcommerceManagementReportService({
  getFinanceReport,
  getConversionKpis,
  getCustomerKpis,
  getProductPerformance
}) {
  return async function getEcommerceManagementReport({ start_date, end_date }) {
    const periods = deriveReportPeriods(start_date, end_date);
    const periodList = [periods.current, periods.previous_period, periods.prior_year];
    const calls = [];
    for (const period of periodList) {
      calls.push(getFinanceReport(period));
      calls.push(getConversionKpis({ ...period, timeseries: 'none' }));
      calls.push(getCustomerKpis({ ...period, timeseries: 'none' }));
    }
    calls.push(getProductPerformance({ ...periods.current, limit: 10, sort_by: 'net_sales' }));
    const results = await Promise.allSettled(calls);
    const [finance, conversion, customers] = [0, 1, 2].map(offset =>
      periodList.map((_, index) => fulfilled(results[index * 3 + offset]))
    );
    const products = fulfilled(results[9]);
    const unavailable = [];
    if (!finance[0]) unavailable.push('Canonical finance evidence was unavailable.');
    if (!conversion[0]) unavailable.push('Shopify conversion evidence was unavailable.');
    if (!customers[0]) unavailable.push('Shopify customer evidence was unavailable.');
    if (!products) unavailable.push('Shopify product evidence was unavailable.');

    return {
      report_type: 'ecommerce_management',
      version: REPORT_VERSION,
      period: periods.current,
      comparison_periods: {
        previous_period: periods.previous_period,
        prior_year: periods.prior_year
      },
      finance: {
        source: 'BigQuery finance.accountant_transactions (derived from finance.sales_master)',
        headline_metric: 'net_gross',
        currency_policy: 'separate',
        current: finance[0],
        comparisons: {
          previous_period: financeComparison(finance[0], finance[1]),
          prior_year: financeComparison(finance[0], finance[2])
        }
      },
      conversion: {
        source: 'Controlled ShopifyQL sessions report; human sessions only',
        scope: 'Shopify Online Store behavioural evidence',
        current: conversion[0]?.metrics ?? null,
        comparisons: {
          previous_period: metricComparison(conversion[0]?.metrics, conversion[1]?.metrics),
          prior_year: metricComparison(conversion[0]?.metrics, conversion[2]?.metrics)
        }
      },
      customers: {
        source: 'Controlled ShopifyQL sales customer KPI reports; Online Store only',
        scope: 'Shopify customer behaviour; no cross-source identity resolution',
        current: customers[0] ? {
          overall: customers[0].overall,
          customer_types: customers[0].customer_types
        } : null,
        comparisons: {
          previous_period: metricComparison(customers[0]?.overall, customers[1]?.overall),
          prior_year: metricComparison(customers[0]?.overall, customers[2]?.overall)
        }
      },
      products: {
        source: 'Controlled ShopifyQL sales product-performance report; Online Store only',
        semantics: 'Shopify operational product metrics, not canonical cross-business finance',
        current: products?.products ?? null,
        sort_by: 'net_sales',
        limit: 10
      },
      evidence: [
        { system: 'BigQuery', source: 'finance.accountant_transactions', upstream_source: 'finance.sales_master', metric_family: 'canonical_finance', period: periods.current, semantic_version: REPORT_VERSION },
        { system: 'ShopifyQL', source: 'controlled sessions conversion KPI report', metric_family: 'online_store_conversion', period: periods.current, semantic_version: REPORT_VERSION },
        { system: 'ShopifyQL', source: 'controlled sales customer KPI reports', metric_family: 'online_store_customers', period: periods.current, semantic_version: REPORT_VERSION },
        { system: 'ShopifyQL', source: 'controlled sales product-performance report', metric_family: 'online_store_products', period: periods.current, semantic_version: REPORT_VERSION }
      ],
      limitations: [
        'Financial currencies are reported independently and are never combined or converted.',
        'Shopify conversion represents Shopify Online Store behaviour, not total-business traffic.',
        'Shopify customer and product metrics are source-specific operational evidence.',
        'Cross-platform customer identity is not established; guests are not collapsed.',
        'Cross-platform product identity and automatic SKU/title canonicalisation are not established.',
        'Shopify returns quantities and operational sales are not accounting refund money or accounting profit.',
        'Attribution is not included in Ecommerce Management Report v1.',
        ...unavailable
      ],
      freshness: {
        finance: null,
        shopify_conversion: null,
        shopify_customers: null,
        shopify_products: null,
        semantics: 'unknown; source freshness is not queried by v1'
      }
    };
  };
}
