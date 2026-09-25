import { ORDER_TOOL_DEFINITIONS } from './order-query.js';
import { CUSTOMER_TOOL_DEFINITIONS } from './customer-query.js';
import { CUSTOMER_JOURNEY_TOOL_DEFINITION } from './customer-journey.js';
import { KNOWLEDGE_TOOL_DEFINITIONS } from './knowledge.js';
import { SHOPIFY_COUNTRY_PRODUCTS_TOOL_DEFINITION } from './shopify-country-products.js';
import { CUSTOMER_ORDER_INTERVAL_TOOL_DEFINITION } from './customer-order-interval.js';
import { ONLINE_COUNTRY_SALES_TOOL_DEFINITION } from './online-country-sales.js';
import { DEVICE_SOURCE_CONVERSION_TOOL_DEFINITION } from './device-source-conversion.js';
import { CATEGORY_SALES_TOOL_DEFINITION } from './category-sales.js';

/** The exact OpenAI tool registry submitted by the Oracle request boundary. */
export function createOracleToolDefinitions() {
  return [
        ...ORDER_TOOL_DEFINITIONS,
        ...CUSTOMER_TOOL_DEFINITIONS,
        CUSTOMER_JOURNEY_TOOL_DEFINITION,
        ...KNOWLEDGE_TOOL_DEFINITIONS,
        SHOPIFY_COUNTRY_PRODUCTS_TOOL_DEFINITION,
        CUSTOMER_ORDER_INTERVAL_TOOL_DEFINITION,
        ONLINE_COUNTRY_SALES_TOOL_DEFINITION,
        DEVICE_SOURCE_CONVERSION_TOOL_DEFINITION,
        CATEGORY_SALES_TOOL_DEFINITION,
        {
          type: 'function',
          name: 'get_ecommerce_management_report',
          description:
            'Get the complete deterministic Ecommerce Management Report v1 for an explicit date range, including canonical finance by currency, Shopify conversion, customer and product evidence, comparisons, provenance and limitations.',
          strict: true,
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              start_date: {
                type: 'string',
                description: 'Inclusive start date in YYYY-MM-DD format.'
              },
              end_date: {
                type: 'string',
                description: 'Inclusive end date in YYYY-MM-DD format.'
              }
            },
            required: ['start_date', 'end_date']
          }
        },
        {
          type: 'function',
          name: 'get_ecommerce_report_v2_evidence',
          description: 'Get bounded persisted Report v2 evidence and period-specific availability for one domain. For comparison investigations call context, organic and acquisition as relevant; context retrieves both periods independently.',
          strict: true,
          parameters: {
            type: 'object', additionalProperties: false,
            properties: {
              section: { type: 'string', enum: ['overview','sales','customers','products','geography','acquisition','organic','context'] },
              current_start: { type: 'string' }, current_end: { type: 'string' },
              comparison_start: { type: 'string' }, comparison_end: { type: 'string' }
            },
            required: ['section','current_start','current_end','comparison_start','comparison_end']
          }
        },
        {
          type: 'function',
          name: 'get_sales_summary',
          description:
            'Get TGF sales totals for a date range, optionally filtered by location, channel or source.',
          parameters: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format'
              },
              end_date: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              },
              location: {
                type: ['string', 'null']
              },
              channel: {
                type: ['string', 'null']
              },
              source: {
                type: ['string', 'null']
              }
            },
            required: ['start_date', 'end_date']
          }
        },
        {
          type: 'function',
          name: 'get_sales_by_location',
          description:
            'Get TGF sales totals grouped by retail location for a date range.',
          parameters: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string'
              },
              end_date: {
                type: 'string'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              }
            },
            required: ['start_date', 'end_date']
          }
        },
        {
          type: 'function',
          name: 'compare_sales_periods',
          description:
            'Compare TGF sales performance between two date periods.',
          parameters: {
            type: 'object',
            properties: {
              period_1_start: {
                type: 'string'
              },
              period_1_end: {
                type: 'string'
              },
              period_2_start: {
                type: 'string'
              },
              period_2_end: {
                type: 'string'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              },
              location: {
                type: ['string', 'null']
              },
              channel: {
                type: ['string', 'null']
              },
              source: {
                type: ['string', 'null']
              }
            },
            required: [
              'period_1_start',
              'period_1_end',
              'period_2_start',
              'period_2_end'
            ]
          }
        },
        {
          type: 'function',
          name: 'get_sales_by_month',
          description:
            'Get TGF sales grouped by month for trend analysis over a date range.',
          parameters: {
            type: 'object',
            properties: {
              start_date: {
                type: 'string',
                description: 'Start date in YYYY-MM-DD format'
              },
              end_date: {
                type: 'string',
                description: 'End date in YYYY-MM-DD format'
              },
              currency: {
                type: 'string',
                enum: ['GBP', 'USD', 'JPY']
              },
              location: {
                type: ['string', 'null']
              },
              channel: {
                type: ['string', 'null']
              },
              source: {
                type: ['string', 'null']
              }
            },
            required: [
              'start_date',
              'end_date'
            ]
          }
        },
        {
  type: 'function',
  name: 'get_sales_by_channel',
  description:
    'Get TGF sales grouped by sales channel for a date range, such as Online or Retail.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      currency: {
        type: 'string',
        enum: ['GBP', 'USD', 'JPY']
      },
      location: {
        type: ['string', 'null']
      },
      source: {
        type: ['string', 'null']
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_refunds',
  description:
    'Analyse governed canonical refunds for a date range. Refund count means refund events; distinct refunded orders is also returned. Supports monthly rows split by source and Shopify channel. Displayed refunded_amount is a positive magnitude while refunds_gross retains the negative ledger sign.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string'
      },
      end_date: {
        type: 'string'
      },
      currency: {
        type: 'string',
        enum: ['GBP', 'USD', 'JPY']
      },
      location: {
        type: ['string', 'null']
      },
      channel: {
        type: ['string', 'null']
      },
      source: {
        type: ['string', 'null']
      },
      group_by: {
        type: 'string',
        enum: [
          'summary',
          'month',
          'location',
          'channel',
          'source',
          'month_source',
          'month_channel_source'
        ]
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_gift_card_issuance',
  description:
    'Get identified TGF gift card issuance. Can return an overall total or group by month, location, channel or source. Historical WooCommerce gift card identification is incomplete, so results primarily cover identified Shopify and Square issuance.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string'
      },
      end_date: {
        type: 'string'
      },
      currency: {
        type: 'string',
        enum: ['GBP', 'USD', 'JPY']
      },
      location: {
        type: ['string', 'null']
      },
      channel: {
        type: ['string', 'null']
      },
      source: {
        type: ['string', 'null']
      },
      group_by: {
        type: 'string',
        enum: [
          'summary',
          'month',
          'location',
          'channel',
          'source'
        ]
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_conversion_kpis',
  description:
    'Get Shopify online-store conversion KPIs for human sessions over an explicit date range, optionally as a daily, weekly or monthly timeseries.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      timeseries: {
        type: 'string',
        enum: ['none', 'day', 'week', 'month'],
        default: 'none',
        description:
          'Return one total or metrics grouped by this period.'
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_sales_kpis',
  description:
    'Get Shopify Online Store operational sales KPIs over an explicit date range, optionally as a daily, weekly or monthly timeseries.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      timeseries: {
        type: 'string',
        enum: ['none', 'day', 'week', 'month'],
        default: 'none',
        description:
          'Return one total or metrics grouped by this period.'
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_product_performance',
  description:
    'Get historical Shopify Online Store product sales performance, ranked by a selected sales metric. Returns value-based return ratios where calculable.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum number of products to return.'
      },
      sort_by: {
        type: 'string',
        enum: [
          'net_sales',
          'gross_sales',
          'net_items_sold',
          'orders',
          'returns'
        ],
        default: 'net_sales',
        description:
          'Sales metric used to rank products descending.'
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_customer_kpis',
  description:
    'Get period-based Shopify Online Store customer KPIs, including new and returning customer behaviour and a customer-type breakdown for summary reports.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      timeseries: {
        type: 'string',
        enum: ['none', 'day', 'week', 'month'],
        default: 'none',
        description:
          'Return one summary or overall KPIs grouped by this period.'
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_inventory_performance',
  description:
    'Analyse historical Shopify inventory snapshots by location, product and variant. This is not current live inventory; days of inventory remaining is an estimate and inventory value depends on recorded costs.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25
      },
      location: {
        type: ['string', 'null'],
        description: 'Exact Shopify inventory location name.'
      },
      sort_by: {
        type: 'string',
        enum: [
          'ending_inventory_units_at_location',
          'days_of_inventory_remaining_at_location',
          'days_out_of_stock_at_location',
          'ending_inventory_value_at_location'
        ],
        default: 'ending_inventory_units_at_location'
      },
      sort_direction: {
        type: 'string',
        enum: ['asc', 'desc'],
        default: 'desc'
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_inventory_efficiency',
  description:
    'Analyse aggregate historical Shopify inventory across all locations by product, including velocity, sell-through, stock duration, value, overstock and stockout risk. This is not current live stock.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      sort_by: {
        type: 'string',
        enum: [
          'sell_through_rate',
          'inventory_units_sold',
          'inventory_units_sold_per_day',
          'ending_inventory_units',
          'days_of_inventory_remaining',
          'days_out_of_stock',
          'ending_inventory_value',
          'ending_inventory_retail_value'
        ],
        default: 'sell_through_rate'
      },
      sort_direction: { type: 'string', enum: ['asc', 'desc'], default: 'desc' }
    },
    required: ['start_date', 'end_date', 'limit', 'sort_by', 'sort_direction']
  }
},
{
  type: 'function',
  name: 'get_shopify_profitability',
  description:
    'Analyse Shopify operational order profitability and supported cost components before returns are settled. Payment-processing and international fee components are unavailable and omitted. This is an operational estimate, not accounting profit or BigQuery financial truth.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      start_date: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      end_date: { type: 'string', description: 'End date in YYYY-MM-DD format' },
      timeseries: {
        type: 'string',
        enum: ['none', 'day', 'week', 'month'],
        default: 'none'
      }
    },
    required: ['start_date', 'end_date', 'timeseries']
  }
},
{
  type: 'function',
  name: 'get_shopify_customer_lifetime_metrics',
  description:
    'Analyse non-sensitive customer lifetime value, order frequency, acquisition and recency for customers acquired in a date range. Lifetime values are not limited to that date range.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      start_date: { type: 'string', description: 'Customer acquisition start date in YYYY-MM-DD format' },
      end_date: { type: 'string', description: 'Customer acquisition end date in YYYY-MM-DD format' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      sort_by: {
        type: 'string',
        enum: [
          'total_amount_spent',
          'total_number_of_orders',
          'total_amount_spent_per_order',
          'days_since_last_order',
          'new_customer_records'
        ],
        default: 'total_amount_spent'
      },
      sort_direction: { type: 'string', enum: ['asc', 'desc'], default: 'desc' }
    },
    required: ['start_date', 'end_date', 'limit', 'sort_by', 'sort_direction']
  }
},
{
  type: 'function',
  name: 'get_shopify_customer_product_behavior',
  description:
    'Run bounded Shopify-native customer/product behavioural analysis in BigQuery. Matrixify-imported WooCommerce orders and guest identities are excluded where appropriate.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      analysis: {
        type: 'string',
        enum: [
          'product_customers',
          'customer_products',
          'product_affinity',
          'repeat_customer_products',
          'lapsed_high_value_customers'
        ]
      },
      start_date: { type: ['string', 'null'], description: 'Activity or acquisition start date in YYYY-MM-DD format, or null.' },
      end_date: { type: ['string', 'null'], description: 'Activity or acquisition end date in YYYY-MM-DD format, or null.' },
      product_query: { type: ['string', 'null'], description: 'Stable product ID or title search; required for product_customers and product_affinity.' },
      customer_query: { type: ['string', 'null'], description: 'Stable customer ID or display-name search; required for customer_products.' },
      minimum_lifetime_spend: { type: ['number', 'null'], minimum: 0, description: 'Minimum available-history operational purchased-line value.' },
      minimum_orders: { type: ['integer', 'null'], minimum: 1, description: 'Minimum distinct available-history Shopify-native orders.' },
      inactive_days: { type: ['integer', 'null'], minimum: 0, description: 'Minimum days since last available-history order.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: [
      'analysis', 'start_date', 'end_date', 'product_query', 'customer_query',
      'minimum_lifetime_spend', 'minimum_orders', 'inactive_days', 'limit'
    ]
  }
},
{
  type: 'function',
  name: 'get_shopify_returns_analysis',
  description:
    'Analyse Shopify returned item quantities by reason, historical product or variant naming at the time of sale, or return status. This item-level report may identify products and variants by historical titles or SKUs rather than stable product IDs, and reports units rather than accounting refund value.',
  parameters: {
    type: 'object',
    properties: {
      start_date: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format'
      },
      end_date: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 25
      },
      group_by: {
        type: 'string',
        enum: ['reason', 'product', 'variant', 'status'],
        default: 'reason'
      },
      status: {
        type: ['string', 'null'],
        description: 'Exact Shopify return status to filter by.'
      }
    },
    required: ['start_date', 'end_date']
  }
},
{
  type: 'function',
  name: 'get_shopify_inventory_by_location',
  description:
    'Get current live available physical inventory for every variant of matched Shopify products, broken down by active inventory location. This is read-only and is not historical or aggregate inventory.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        description: 'Shopify product search text. Multiple named products should be batched with Shopify OR syntax, for example title:"First" OR title:"Second".'
      },
      location: {
        type: ['string', 'null'],
        description: 'Exact location name, matched case-insensitively, or null for every active inventory location.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        default: 10,
        description: 'Maximum number of matched products; variants are fully paginated.'
      }
    },
    required: ['query', 'location', 'limit']
  }
},
{
  type: 'function',
  name: 'search_shopify_products',
  description:
    'Search the current live Shopify product catalogue, including variants, prices, tags, Made-to-Order status and aggregate inventory across Shopify locations.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'A Shopify product search query. Batch multiple named products with Shopify OR syntax rather than issuing equivalent per-product lookups.'
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        default: 10,
        description:
          'Maximum number of products to return.'
      }
    },
    required: ['query']
  }
}
  ];
}
