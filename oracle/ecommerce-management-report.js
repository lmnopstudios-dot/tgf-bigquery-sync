const REPORT_VERSION = '1.1';
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

const CUSTOMER_DEFINITIONS = Object.freeze({
  shopify: Object.freeze({
    customers: 'Distinct Shopify customers attributed to Online Store sales in the period.',
    new_customers: 'Shopify customers classified as new for Online Store sales in the period.',
    returning_customers: 'Shopify customers classified as returning for Online Store sales in the period.',
    returning_customer_rate: 'Shopify returning-customer rate for Online Store sales in the period.',
    orders: 'Orders attributed by Shopify to Online Store customers in the period.',
    orders_per_customer: 'Shopify Online Store orders divided by Shopify customers in the period.'
  }),
  metorik: Object.freeze({
    registered_purchasing_customers: 'Distinct non-null Woo customer_id values on Metorik orders in the period; guest orders are excluded and this is not the canonical Metorik identity.',
    canonical_new_customers: 'Canonical metorik_customer_id records whose first_order_date falls in the period, grouped by the customer record currency.',
    orders: 'Count of historical WooCommerce order records ingested by Metorik in the period.',
    guest_orders: 'Historical WooCommerce order records with no Woo customer_id in the period.',
    orders_per_registered_customer: 'WooCommerce orders divided by distinct non-null Woo customer_id values; guest orders remain in the numerator and identities are not joined to canonical Metorik customers.'
  })
});

function historicalSources(value) {
  return (value?.sources || []).filter(source => source?.available === true);
}

function sourceDescriptor(source) {
  return {
    source: source.source,
    system: source.system,
    dataset: source.dataset,
    period: source.period
  };
}

function comparisonMetadata(currentSource, comparisonSource, family) {
  if (!currentSource || !comparisonSource) {
    return {
      level: 'unavailable',
      reason: `Equivalent ${family} evidence is unavailable for one or both periods.`
    };
  }
  if (currentSource === comparisonSource) {
    return {
      level: 'direct',
      reason: `Both periods use the same ${currentSource} metric definition.`
    };
  }
  return {
    level: family === 'customers' ? 'directional' : 'not_comparable',
    reason: family === 'customers'
      ? 'Customer identity and new/returning classification differ across Shopify and historical Metorik/WooCommerce.'
      : 'Shopify and WooCommerce products have no governed cross-platform product identity bridge.'
  };
}

function historicalCustomerKpiComparisons(shopify, sources) {
  if (!shopify || sources.length === 0) return null;
  return sources.map(source => ({
    comparison_source: sourceDescriptor(source),
    currency_policy: 'separate',
    metrics_by_currency: (source.customers?.by_currency || []).map(row => ({
      currency: row.currency,
      orders: {
        current: finiteNumber(shopify.overall?.orders),
        comparison: finiteNumber(row.orders),
        current_definition: CUSTOMER_DEFINITIONS.shopify.orders,
        comparison_definition: CUSTOMER_DEFINITIONS.metorik.orders,
        comparability: comparisonMetadata('shopify', source.source, 'customers')
      },
      purchasing_customers: {
        current: finiteNumber(shopify.overall?.customers),
        comparison: finiteNumber(row.registered_purchasing_customers),
        current_definition: CUSTOMER_DEFINITIONS.shopify.customers,
        comparison_definition: CUSTOMER_DEFINITIONS.metorik.registered_purchasing_customers,
        comparability: comparisonMetadata('shopify', source.source, 'customers')
      },
      new_customers: {
        current: finiteNumber(shopify.overall?.new_customers),
        comparison: finiteNumber(row.canonical_new_customers),
        current_definition: CUSTOMER_DEFINITIONS.shopify.new_customers,
        comparison_definition: CUSTOMER_DEFINITIONS.metorik.canonical_new_customers,
        comparability: comparisonMetadata('shopify', source.source, 'customers')
      },
      returning_customers: {
        current: finiteNumber(shopify.overall?.returning_customers),
        comparison: null,
        current_definition: CUSTOMER_DEFINITIONS.shopify.returning_customers,
        comparison_definition: null,
        comparability: {
          level: 'unavailable',
          reason: 'Metorik orders cannot be deterministically joined to canonical Metorik customer identities for period-level returning-customer classification.'
        }
      },
      returning_customer_rate: {
        current: finiteNumber(shopify.overall?.returning_customer_rate),
        comparison: null,
        current_definition: CUSTOMER_DEFINITIONS.shopify.returning_customer_rate,
        comparison_definition: null,
        comparability: {
          level: 'unavailable',
          reason: 'No equivalent historical returning-customer classification can be derived without inferring customer identity.'
        }
      },
      orders_per_customer: {
        current: finiteNumber(shopify.overall?.orders) !== null && finiteNumber(shopify.overall?.customers) > 0
          ? finiteNumber(shopify.overall.orders) / finiteNumber(shopify.overall.customers)
          : null,
        comparison: finiteNumber(row.orders_per_registered_customer),
        current_definition: CUSTOMER_DEFINITIONS.shopify.orders_per_customer,
        comparison_definition: CUSTOMER_DEFINITIONS.metorik.orders_per_registered_customer,
        comparability: comparisonMetadata('shopify', source.source, 'customers')
      },
      guest_orders: {
        current: null,
        comparison: finiteNumber(row.guest_orders),
        current_definition: null,
        comparison_definition: CUSTOMER_DEFINITIONS.metorik.guest_orders,
        comparability: {
          level: 'not_comparable',
          reason: 'Guest-order evidence is source-specific and is not a cross-platform customer identity metric.'
        }
      }
    }))
  }));
}

export function createEcommerceManagementReportService({
  getFinanceReport,
  getConversionKpis,
  getCustomerKpis,
  getProductPerformance,
  getHistoricalEcommerce = async () => ({ sources: [] })
}) {
  return async function getEcommerceManagementReport({ start_date, end_date }) {
    const periods = deriveReportPeriods(start_date, end_date);
    const periodList = [periods.current, periods.previous_period, periods.prior_year];
    const calls = [];
    for (const period of periodList) {
      calls.push(getFinanceReport(period));
      calls.push(getConversionKpis({ ...period, timeseries: 'none' }));
      calls.push(getCustomerKpis({ ...period, timeseries: 'none' }));
      calls.push(getHistoricalEcommerce(period));
    }
    calls.push(getProductPerformance({ ...periods.current, limit: 10, sort_by: 'net_sales' }));
    const results = await Promise.allSettled(calls);
    const [finance, conversion, customers, historical] = [0, 1, 2, 3].map(offset =>
      periodList.map((_, index) => fulfilled(results[index * 4 + offset]))
    );
    const products = fulfilled(results[12]);
    const historicalByPeriod = historical.map(historicalSources);
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
      ecommerce_sources: {
        current: {
          shopify: Boolean(conversion[0] || customers[0] || products),
          historical: historicalByPeriod[0].map(sourceDescriptor),
          boundary: historicalByPeriod[0].length > 0 && (conversion[0] || customers[0] || products)
            ? 'mixed_source_period_not_merged'
            : null
        },
        previous_period: {
          shopify: Boolean(conversion[1] || customers[1]),
          historical: historicalByPeriod[1].map(sourceDescriptor),
          boundary: historicalByPeriod[1].length > 0 && (conversion[1] || customers[1])
            ? 'mixed_source_period_not_merged'
            : null
        },
        prior_year: {
          shopify: Boolean(conversion[2] || customers[2]),
          historical: historicalByPeriod[2].map(sourceDescriptor),
          boundary: historicalByPeriod[2].length > 0 && (conversion[2] || customers[2])
            ? 'mixed_source_period_not_merged'
            : null
        }
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
        },
        comparability: {
          previous_period: comparisonMetadata(conversion[0] ? 'shopify' : null, conversion[1] ? 'shopify' : null, 'conversion'),
          prior_year: comparisonMetadata(conversion[0] ? 'shopify' : null, conversion[2] ? 'shopify' : null, 'conversion')
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
        },
        historical: {
          current: historicalByPeriod[0].map(source => ({ ...sourceDescriptor(source), customers: source.customers })),
          previous_period: historicalByPeriod[1].map(source => ({ ...sourceDescriptor(source), customers: source.customers })),
          prior_year: historicalByPeriod[2].map(source => ({ ...sourceDescriptor(source), customers: source.customers }))
        },
        cross_platform_comparisons: {
          previous_period: historicalCustomerKpiComparisons(customers[0], historicalByPeriod[1]),
          prior_year: historicalCustomerKpiComparisons(customers[0], historicalByPeriod[2])
        },
        identity_models: {
          shopify: 'Shopify customer classification returned by controlled ShopifyQL.',
          metorik_canonical: 'metorik_customer_id is used only for canonical new-customer counts from metorik customers.',
          woo_order_level: 'Woo customer_id is used only for registered purchasing-customer counts from orders; null guest identities remain separate.'
        }
      },
      products: {
        source: 'Controlled ShopifyQL sales product-performance report; Online Store only',
        semantics: 'Shopify operational product metrics, not canonical cross-business finance',
        current: products?.products ?? null,
        sort_by: 'net_sales',
        limit: 10,
        historical: {
          current: historicalByPeriod[0].map(source => ({ ...sourceDescriptor(source), products: source.products, product_metrics: source.product_metrics, product_identity: source.product_identity })),
          previous_period: historicalByPeriod[1].map(source => ({ ...sourceDescriptor(source), products: source.products, product_metrics: source.product_metrics, product_identity: source.product_identity })),
          prior_year: historicalByPeriod[2].map(source => ({ ...sourceDescriptor(source), products: source.products, product_metrics: source.product_metrics, product_identity: source.product_identity }))
        },
        cross_platform_comparability: comparisonMetadata(
          products ? 'shopify' : null,
          historicalByPeriod[2][0]?.source,
          'products'
        )
      },
      evidence: [
        { system: 'BigQuery', source: 'finance.accountant_transactions', upstream_source: 'finance.sales_master', metric_family: 'canonical_finance', period: periods.current, semantic_version: REPORT_VERSION },
        { system: 'ShopifyQL', source: 'controlled sessions conversion KPI report', metric_family: 'online_store_conversion', period: periods.current, semantic_version: REPORT_VERSION },
        { system: 'ShopifyQL', source: 'controlled sales customer KPI reports', metric_family: 'online_store_customers', period: periods.current, semantic_version: REPORT_VERSION },
        { system: 'ShopifyQL', source: 'controlled sales product-performance report', metric_family: 'online_store_products', period: periods.current, semantic_version: REPORT_VERSION },
        ...historicalByPeriod.flatMap(sources => sources.flatMap(source => [
          {
            system: 'Metorik / WooCommerce',
            source: `${source.dataset}.orders and ${source.dataset}.customers`,
            dataset: source.dataset,
            metric_family: 'historical_ecommerce_customers',
            period: source.period,
            semantic_version: REPORT_VERSION,
            identity_model: 'Canonical metorik_customer_id is used only in customer-table new-customer counts; Woo customer_id is used separately for registered order purchasers; guest identities are not collapsed.',
            comparison_source: customers[0] ? 'ShopifyQL' : null,
            comparability_level: customers[0] ? 'directional' : 'unavailable',
            limitations: ['No inferred link between Woo customer_id and metorik_customer_id.', 'No historical session or funnel conversion metrics are derived.']
          },
          {
            system: 'Metorik / WooCommerce',
            source: `${source.dataset}.order_line_items`,
            dataset: source.dataset,
            metric_family: 'historical_ecommerce_products',
            period: source.period,
            semantic_version: REPORT_VERSION,
            identity_model: 'Source-native Woo product_id and variation_id only.',
            comparison_source: products ? 'ShopifyQL' : null,
            comparability_level: 'not_comparable',
            limitations: ['No SKU, title, or fuzzy cross-platform product matching.']
          }
        ]))
      ],
      acquisition: {
        normalized_section_exposed: false,
        historical_sources: historicalByPeriod.flatMap(sources => sources.map(source => ({
          ...sourceDescriptor(source),
          attribution: source.attribution
        }))),
        limitation: 'Historical Metorik attribution evidence exists, but Shopify attribution normalization is outside Report v1.1.'
      },
      limitations: [
        'Financial currencies are reported independently and are never combined or converted.',
        'Shopify conversion represents Shopify Online Store behaviour, not total-business traffic.',
        'Shopify customer and product metrics are source-specific operational evidence.',
        'Cross-platform customer identity is not established; guests are not collapsed.',
        'Cross-platform product identity and automatic SKU/title canonicalisation are not established.',
        'Shopify returns quantities and operational sales are not accounting refund money or accounting profit.',
        'Historical Metorik order attribution fields exist, but Report v1.1 intentionally does not expose a normalized acquisition section.',
        'Historical ecommerce/customer evidence may be available through Metorik, but equivalent session-based conversion evidence is not available from that source.',
        ...unavailable
      ],
      freshness: {
        finance: null,
        shopify_conversion: null,
        shopify_customers: null,
        shopify_products: null,
        metorik: null,
        semantics: 'unknown; source freshness is not queried by v1.1'
      }
    };
  };
}
