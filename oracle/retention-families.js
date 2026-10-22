import {classificationRefSql} from './classification-reader.js';
// Current active, reviewed reporting-family routes only. Reporting keys do not
// assert canonical product identity or change classification/transaction joins.
export function retentionFamilyCtes(){return `retention_family_candidates AS (
    SELECT source_ref,classification_ref family_ref FROM cr_routes WHERE mapping_type='approved_reporting_family'
    UNION DISTINCT SELECT classification_ref,classification_ref FROM cr_family
  ), retention_family_keys AS (
    SELECT source_ref,IF(COUNT(DISTINCT family_ref)=1,MIN(family_ref),NULL) family_ref,COUNT(DISTINCT family_ref) family_count
    FROM retention_family_candidates WHERE source_ref IS NOT NULL AND family_ref IS NOT NULL GROUP BY source_ref
  ), retention_family_labels AS (
    SELECT ${classificationRefSql('shopify_parent_ref')} family_ref,MIN(NULLIF(TRIM(shopify_parent_title),'')) family_title
    FROM cr_family_current WHERE status='active' GROUP BY family_ref
  ), retention_identity_keys AS (
    SELECT source_ref,IF(COUNT(DISTINCT classification_ref)=1,MIN(classification_ref),NULL) product_ref
    FROM cr_identity WHERE STARTS_WITH(classification_ref,'shopify:shopify:') GROUP BY source_ref
  ), retention_reporting_lines AS (
    SELECT l.*,IF(f.family_ref IS NOT NULL,CONCAT('family:',f.family_ref),COALESCE(i.product_ref,l.source_product_ref)) reporting_product_ref,
      IF(f.family_ref IS NOT NULL,COALESCE(t.family_title,CONCAT('Governed family ',f.family_ref)),COALESCE(NULLIF(TRIM(l.product_title),''),'Product title unavailable')) reporting_product_title,
      CASE WHEN f.family_ref IS NOT NULL THEN 'governed_family' WHEN f.family_count>1 THEN 'ambiguous_family' WHEN i.product_ref IS NOT NULL THEN 'governed_product' ELSE 'unmapped_item' END family_status
    FROM classified_lines l LEFT JOIN retention_family_keys f ON f.source_ref=l.source_product_ref LEFT JOIN retention_family_labels t ON t.family_ref=f.family_ref LEFT JOIN retention_identity_keys i ON i.source_ref=l.source_product_ref
  )`;}
