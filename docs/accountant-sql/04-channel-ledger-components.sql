-- As of 2026-10-12, main eeb685631b2d609415a072d5520be0531a6bef4d.
-- Repository-checked only; live schema/dry-run unverified. GoogleSQL SELECT only.
SELECT FORMAT_DATE('%Y-%m',date) month,source AS source_store_label,
  channel,COALESCE(NULLIF(TRIM(location),''),'Unknown / unallocated') selling_location,
  UPPER(currency) currency,LOWER(transaction_type) transaction_type,COUNT(*) transaction_rows,
  IF(COUNTIF(gross IS NULL)=0,SUM(CAST(gross AS NUMERIC)),NULL) signed_gross,
  IF(COUNTIF(tax IS NULL)=0,SUM(CAST(tax AS NUMERIC)),NULL) signed_recorded_tax,
  IF(COUNTIF(net_ex_tax IS NULL)=0,SUM(CAST(net_ex_tax AS NUMERIC)),NULL) signed_ex_tax,
  COUNTIF(tax IS NULL) missing_tax_rows,
  IF(COUNTIF(gross IS NULL OR tax IS NULL OR net_ex_tax IS NULL)=0,
    SUM(CAST(net_ex_tax AS NUMERIC)+CAST(tax AS NUMERIC)-CAST(gross AS NUMERIC)),NULL)
    stored_component_difference
FROM `gf-full-data.finance.accountant_transactions`
WHERE date>=DATE '2025-11-01' AND date<DATE '2025-12-01'
  AND LOWER(transaction_type) IN ('sale','refund')
GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6;
