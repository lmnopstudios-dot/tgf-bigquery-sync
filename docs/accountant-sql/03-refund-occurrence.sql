-- As of 2026-10-12, main eeb685631b2d609415a072d5520be0531a6bef4d.
-- Repository-checked only; live schema/dry-run unverified. GoogleSQL SELECT only.
WITH legacy_non_shopify AS (
    SELECT date transaction_date,LOWER(transaction_type) transaction_type,
      COALESCE(source,'Unclassified') source,COALESCE(channel,'Unclassified') channel,
      UPPER(currency) currency,CAST(gross AS NUMERIC) amount,CAST(tax AS NUMERIC) tax,
      CAST(net_ex_tax AS NUMERIC) net_ex_tax,CAST(NULL AS STRING) order_id,
      CAST(NULL AS STRING) transaction_id,'finance.accountant_transactions' provenance
    FROM `gf-full-data.finance.accountant_transactions`
    WHERE NOT REGEXP_CONTAINS(LOWER(COALESCE(source,'')),r'shopify')
  ), native_shopify_sales AS (
    SELECT DATE(f.created_at),'sale','Shopify',
      IF(l.retail_location_id IS NULL,'Online','POS'),UPPER(f.presentment_currency),
      CAST(f.original_total_presentment AS NUMERIC),CAST(f.original_tax_presentment AS NUMERIC),
      CAST(f.original_total_presentment-f.original_tax_presentment AS NUMERIC),f.order_id,f.order_id,
      'shopify_data.order_financials:presentment'
    FROM `gf-full-data.shopify_data.order_financials` f
    JOIN `gf-full-data.shopify_data.order_locations` l USING(order_id)
    WHERE (l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145')
      AND COALESCE(f.original_total_presentment,0)>0
      AND f.cancelled_at IS NULL
      AND EXISTS (SELECT 1 FROM UNNEST(IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(f.transactions_json)),[])) transaction
        WHERE JSON_VALUE(transaction,'$.status')='SUCCESS'
          AND JSON_VALUE(transaction,'$.kind') IN ('SALE','CAPTURE'))
  ), native_shopify_refunds AS (
    SELECT DATE(r.refund_created_at),'refund','Shopify',
      IF(l.retail_location_id IS NULL,'Online','POS'),
      UPPER(COALESCE(r.presentment_currency,f.presentment_currency)),
      -ABS(CAST(r.refund_total_presentment AS NUMERIC)),
      -ABS(CAST(COALESCE(r.refund_tax_presentment,0) AS NUMERIC)),
      -ABS(CAST(r.refund_total_presentment-COALESCE(r.refund_tax_presentment,0) AS NUMERIC)),
      r.order_id,r.refund_id,'shopify_data.order_refunds:presentment'
    FROM `gf-full-data.shopify_data.order_refunds` r
    JOIN `gf-full-data.shopify_data.order_locations` l USING(order_id)
    JOIN `gf-full-data.shopify_data.order_financials` f USING(order_id)
    WHERE (l.source_app_id IS NULL OR l.source_app_id!='gid://shopify/App/1758145')
      AND r.refund_created_at IS NOT NULL AND COALESCE(r.refund_total_presentment,0)>0
      AND r.has_successful_refund_transaction
  ), canonical_transactions AS (
    SELECT * FROM legacy_non_shopify UNION ALL
    SELECT * FROM native_shopify_sales UNION ALL
    SELECT * FROM native_shopify_refunds
  )
SELECT FORMAT_DATE('%Y-%m',transaction_date) refund_month,source AS source_store_label,
  channel,currency,provenance,COUNT(*) refund_rows,
  COUNT(DISTINCT order_id) native_shopify_refunded_orders,
  IF(COUNTIF(amount IS NULL)=0,SUM(amount),NULL) signed_refund_amount,
  IF(COUNTIF(tax IS NULL)=0,SUM(tax),NULL) signed_refund_tax,
  MIN(transaction_date) first_observed_date,MAX(transaction_date) last_observed_date
FROM canonical_transactions
WHERE transaction_type='refund'
  AND transaction_date>=DATE '2025-11-01' AND transaction_date<DATE '2025-12-01'
GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5;
