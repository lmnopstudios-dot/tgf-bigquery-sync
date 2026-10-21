h_orders AS (SELECT * FROM history_orders),
  h_evidence AS (SELECT DISTINCT e.source,e.order_id,
    CASE WHEN e.provider='metorik_customers' AND e.native_customer_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM email_observations a JOIN h_orders o ON a.source=o.source AND a.order_id=o.order_id
      WHERE a.provider='metorik_orders' AND a.source=e.source AND a.native_customer_id=e.native_customer_id AND o.customer_id=e.native_customer_id
    ) THEN CONCAT('woo:',e.source,':',e.native_customer_id) ELSE e.profile_key END profile_key,
    e.normalized,e.email_state FROM email_observations e),
  h_edges AS (
    SELECT o.source,o.order_id,CONCAT(IF(o.source='shopify','shopify','woo'),':',o.source,':',o.customer_id) profile_key FROM h_orders o WHERE o.customer_id IS NOT NULL AND o.customer_id NOT IN ('','0')
    UNION DISTINCT SELECT e.source,e.order_id,e.profile_key FROM h_evidence e JOIN h_orders o USING(source,order_id) WHERE e.profile_key IS NOT NULL
  ), h_aliases AS (
    SELECT p.source,p.profile_key,COALESCE(MIN(CASE WHEN o.customer_id IS NOT NULL AND o.customer_id NOT IN ('','0') THEN CONCAT(IF(o.source='shopify','shopify','woo'),':',o.source,':',o.customer_id) ELSE NULL END),p.profile_key) canonical_profile_key
    FROM h_edges p JOIN h_orders o USING(source,order_id) GROUP BY p.source,p.profile_key
    HAVING COUNT(DISTINCT CASE WHEN o.customer_id IS NOT NULL AND o.customer_id NOT IN ('','0') THEN CONCAT(IF(o.source='shopify','shopify','woo'),':',o.source,':',o.customer_id) ELSE NULL END)<=1
  ), h_direct_values AS (
    SELECT e.source,e.order_id,e.normalized FROM h_evidence e JOIN h_orders o USING(source,order_id) WHERE e.normalized IS NOT NULL
    UNION DISTINCT SELECT o.source,o.order_id,c.normalized FROM h_edges o JOIN h_evidence c ON c.source=o.source AND c.profile_key=o.profile_key WHERE c.normalized IS NOT NULL
  ), h_profile_values AS (
    SELECT p.source,COALESCE(a.canonical_profile_key,p.profile_key) profile_key,v.normalized FROM h_edges p JOIN h_direct_values v USING(source,order_id) LEFT JOIN h_aliases a USING(source,profile_key)
    UNION DISTINCT SELECT e.source,COALESCE(a.canonical_profile_key,e.profile_key),e.normalized FROM h_evidence e LEFT JOIN h_aliases a USING(source,profile_key) WHERE e.profile_key IS NOT NULL AND e.normalized IS NOT NULL
  ), h_values AS (SELECT * FROM h_direct_values UNION DISTINCT SELECT p.source,p.order_id,v.normalized FROM h_edges p LEFT JOIN h_aliases a USING(source,profile_key) JOIN h_profile_values v ON v.source=p.source AND v.profile_key=COALESCE(a.canonical_profile_key,p.profile_key)),
  h_conflict_profiles AS (SELECT source,profile_key FROM h_profile_values GROUP BY 1,2 HAVING COUNT(DISTINCT normalized)>1),
  h_shared AS (SELECT normalized FROM h_profile_values GROUP BY source,normalized HAVING COUNT(DISTINCT profile_key)>1),
  h_bad AS (
    SELECT v.normalized FROM h_profile_values v JOIN h_conflict_profiles p USING(source,profile_key)
    UNION DISTINCT SELECT normalized FROM h_shared
    UNION DISTINCT SELECT v.normalized FROM h_values v JOIN (SELECT source,order_id FROM h_values GROUP BY 1,2 HAVING COUNT(DISTINCT normalized)>1) c USING(source,order_id)
  ), h_addresses AS (SELECT source,order_id,COUNT(DISTINCT normalized) addresses,MIN(normalized) normalized FROM h_values GROUP BY 1,2),
  h_usable AS (SELECT a.* FROM h_addresses a WHERE addresses=1 AND normalized NOT IN(SELECT normalized FROM h_bad)),
  h_cross AS (SELECT DISTINCT w.source,w.order_id FROM h_usable w JOIN h_usable s USING(normalized) WHERE w.source IN ('ww','usd') AND s.source='shopify'
    UNION DISTINCT SELECT DISTINCT s.source,s.order_id FROM h_usable w JOIN h_usable s USING(normalized) WHERE w.source IN ('ww','usd') AND s.source='shopify'),
  h_resolved AS (SELECT o.*,CASE WHEN a.addresses>1 OR a.normalized IN(SELECT normalized FROM h_bad) THEN 'ambiguous'
    WHEN x.order_id IS NOT NULL THEN 'matched' WHEN a.addresses=1 THEN 'unmatched'
    WHEN EXISTS(SELECT 1 FROM h_evidence e WHERE e.source=o.source AND e.order_id=o.order_id AND e.email_state NOT IN ('unavailable','extraction_failure')) THEN 'unmatched' ELSE 'unavailable' END resolution,
    CASE WHEN u.order_id IS NOT NULL THEN CONCAT('c_',TO_HEX(SHA256(CONCAT('email-record|',u.normalized))))
      WHEN o.customer_id IS NOT NULL AND o.customer_id NOT IN ('','0') THEN CONCAT('c_',TO_HEX(SHA256(CONCAT(IF(o.source='shopify','shopify','woo'),'|',o.source,'|',o.customer_id))))
      ELSE CONCAT('c_',TO_HEX(SHA256(CONCAT('unlinked-order|',o.source,'|',o.order_id)))) END canonical_customer_ref,
    COALESCE(a.addresses>1,FALSE) OR EXISTS(SELECT 1 FROM h_edges e JOIN h_conflict_profiles p USING(source,profile_key) WHERE e.source=o.source AND e.order_id=o.order_id) conflicting_email,
    EXISTS(SELECT 1 FROM h_values v JOIN h_shared s USING(normalized) WHERE v.source=o.source AND v.order_id=o.order_id) shared_email
    FROM h_orders o LEFT JOIN h_addresses a USING(source,order_id) LEFT JOIN h_usable u USING(source,order_id) LEFT JOIN h_cross x USING(source,order_id))
