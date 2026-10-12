-- Repository-checked only; live schema/dry-run unverified. shopify_data location.
-- Full key-space check is intentional: filtering by creation date can hide competing revisions.
-- Dry-run and review estimated bytes before execution. No identifying values are output.
WITH keys AS (
 SELECT 'financials' object_name,order_id key,COUNT(*) n
 FROM `gf-full-data.shopify_data.order_financials` GROUP BY order_id
 UNION ALL
 SELECT 'locations',order_id,COUNT(*)
 FROM `gf-full-data.shopify_data.order_locations` GROUP BY order_id
 UNION ALL
 SELECT 'refunds',refund_id,COUNT(*)
 FROM `gf-full-data.shopify_data.order_refunds` GROUP BY refund_id
)
SELECT object_name,COUNT(*) key_groups,COUNTIF(key IS NULL) null_key_groups,
 COUNTIF(n>1) repeated_key_groups,SUM(IF(n>1,n-1,0)) extra_rows
FROM keys GROUP BY object_name ORDER BY object_name;
