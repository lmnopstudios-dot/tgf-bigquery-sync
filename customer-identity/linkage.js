import {fq} from './collect.js';

// Includes *all* stored evidence, not just a qualifying purchase/cohort slice.
// Same global conflict/shared-address exclusions as the merged email audit.
export function linkageSql(project,dataset) {
  return `WITH raw AS (
    SELECT source,customer_id,email FROM ${fq(project,dataset,'order_identity')},
    UNNEST([order_email_normalized,customer_email_normalized]) email
    WHERE customer_id IS NOT NULL AND customer_id NOT IN ('','0') AND email IS NOT NULL
  ), profiles AS (
    SELECT source,customer_id,COUNT(DISTINCT email) addresses,MIN(email) email FROM raw GROUP BY 1,2
  ), bad_email AS (
    SELECT email FROM raw GROUP BY source,email HAVING COUNT(DISTINCT customer_id)>1
    UNION DISTINCT SELECT r.email FROM raw r JOIN profiles p USING(source,customer_id) WHERE p.addresses>1
  ), eligible AS (
    SELECT * FROM profiles WHERE addresses=1 AND email NOT IN (SELECT email FROM bad_email)
  )
  SELECT DISTINCT w.source woo_source,w.customer_id woo_customer_id,s.customer_id shopify_customer_id,
    'normalized_email_candidate' linkage_basis
  FROM eligible w JOIN eligible s USING(email)
  WHERE w.source IN ('ww','usd') AND s.source='shopify'`;
}
export function mappingSql(project,dataset) {
  return `WITH candidates AS (${linkageSql(project,dataset)})
    SELECT woo_source source_store,woo_customer_id source_customer_id,
      CONCAT('c_',TO_HEX(SHA256(CONCAT('shopify|shopify|',shopify_customer_id)))) canonical_customer_ref
    FROM candidates
    UNION DISTINCT
    SELECT 'shopify',shopify_customer_id,
      CONCAT('c_',TO_HEX(SHA256(CONCAT('shopify|shopify|',shopify_customer_id)))) FROM candidates`;
}
