-- Repository-checked only; live schema/dry-run unverified. Run in finance's actual location.
-- Repeat separately with dataset identifier replaced by each approved dataset.
SELECT c.table_catalog,c.table_schema,c.table_name,t.table_type,
  c.column_name,c.data_type,c.is_nullable,c.ordinal_position
FROM `gf-full-data.finance.INFORMATION_SCHEMA.COLUMNS` c
JOIN `gf-full-data.finance.INFORMATION_SCHEMA.TABLES` t
  USING(table_catalog,table_schema,table_name)
WHERE c.table_name IN ('sales_master','accountant_transactions','accountant_monthly_summary',
  'accountant_annual_summary','accountant_location_summary','accountant_gift_cards')
ORDER BY c.table_name,c.ordinal_position;
-- Separate metadata-only SELECT for view SQL/dependencies and transformation definitions:
SELECT table_name,view_definition,use_standard_sql
FROM `gf-full-data.finance.INFORMATION_SCHEMA.VIEWS`
WHERE table_name IN ('sales_master','accountant_transactions','accountant_monthly_summary',
  'accountant_annual_summary','accountant_location_summary','accountant_gift_cards')
ORDER BY table_name;
