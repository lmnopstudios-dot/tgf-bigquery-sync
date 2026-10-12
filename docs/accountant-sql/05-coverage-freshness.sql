-- Repository-checked only; live schema/dry-run unverified. shopify_data location.
-- Evidence dates and retrieval timestamps for a bounded occurrence cohort, all statuses.
SELECT 'orders' evidence_kind,presentment_currency currency,COUNT(*) rows_in_window,
  MIN(created_at) first_occurrence,MAX(created_at) last_occurrence,
  MIN(synced_at) earliest_collection,MAX(synced_at) latest_collection,
  COUNTIF(synced_at IS NULL) missing_collection_timestamps
FROM `gf-full-data.shopify_data.order_financials`
WHERE created_at>=TIMESTAMP '2026-09-01 00:00:00+00'
  AND created_at<TIMESTAMP '2026-10-01 00:00:00+00'
GROUP BY currency
UNION ALL
SELECT 'refunds',presentment_currency,COUNT(*),MIN(refund_created_at),MAX(refund_created_at),
  MIN(synced_at),MAX(synced_at),COUNTIF(synced_at IS NULL)
FROM `gf-full-data.shopify_data.order_refunds`
WHERE refund_created_at>=TIMESTAMP '2026-09-01 00:00:00+00'
  AND refund_created_at<TIMESTAMP '2026-10-01 00:00:00+00'
GROUP BY presentment_currency;
-- Only if the control table exists; this is collection state, not sale-date completeness.
SELECT collector,successful_watermark,updated_at
FROM `gf-full-data.shopify_data.finance_refresh_state`
WHERE collector='shopify_finance';
