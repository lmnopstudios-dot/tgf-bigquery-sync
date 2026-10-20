import {fq} from './collect.js';

// Technical historical lower bound, not an asserted business launch date.
export const HISTORY_SCOPE=Object.freeze({start:'1900-01-01',end:'2026-10-19'});

export const HISTORY_TABLES={
  history_orders:[['source','STRING'],['order_id','STRING'],['customer_id','STRING'],['created_at','TIMESTAMP'],['currency','STRING'],['financial_status','STRING'],['cancelled','BOOLEAN']],
  email_observations:[['evidence_id','STRING'],['source','STRING'],['order_id','STRING'],['profile_key','STRING'],['provider','STRING'],['record_id','STRING'],['field_path','STRING'],['email','STRING'],['normalized','STRING'],['email_state','STRING'],['native_customer_id','STRING'],['metorik_customer_id','STRING'],['observed_at','TIMESTAMP'],['retrieved_at','TIMESTAMP']],
  history_progress:[['job_key','STRING'],['source','STRING'],['adapter','STRING'],['revision','STRING'],['cursor','STRING'],['complete','BOOLEAN'],['updated_at','TIMESTAMP']],
  identity_order_links:[['snapshot_id','STRING'],['source_store','STRING'],['source_order_id','STRING'],['source_customer_id','STRING'],['canonical_customer_ref','STRING'],['resolution','STRING'],['financial_status','STRING'],['cancelled','BOOLEAN'],['conflicting_email','BOOLEAN'],['shared_email','BOOLEAN']],
};
for(const key of Object.keys(HISTORY_TABLES))HISTORY_TABLES[key]=HISTORY_TABLES[key].map(([name,type])=>({name,type}));

export function historyRosterSql(project,source){
  const dataset=source==='ww'?'metorik_uk':source==='usd'?'metorik_us':'shopify_data';
  return source==='shopify'?`SELECT 'shopify' source,l.order_id,CAST(NULL AS STRING) customer_id,TIMESTAMP(l.created_at) created_at,CAST(NULL AS STRING) currency,CAST(NULL AS STRING) financial_status,CAST(NULL AS BOOL) cancelled FROM ${fq(project,dataset,'order_locations')} l WHERE DATE(l.created_at) BETWEEN @start AND @end QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY created_at)=1`:
    `SELECT '${source}' source,CAST(order_id AS STRING) order_id,NULLIF(NULLIF(CAST(customer_id AS STRING),'0'),'') customer_id,TIMESTAMP(order_created_at) created_at,currency,CAST(NULL AS STRING) financial_status,CAST(NULL AS BOOL) cancelled FROM ${fq(project,dataset,'orders')} WHERE DATE(order_created_at) BETWEEN @start AND @end QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY order_created_at)=1`;
}

// Every observation participates, including earlier usable revisions. An API
// placeholder cannot erase a historical address or hide a disagreement.
export function historyLinkCtes(project,dataset){
  const t=name=>fq(project,dataset,name);
  return `h_orders AS (SELECT * FROM ${t('history_orders')}),
  h_evidence AS (SELECT DISTINCT e.source,e.order_id,
    CASE WHEN e.provider='metorik_customers' AND e.native_customer_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM ${t('email_observations')} a JOIN h_orders o ON a.source=o.source AND a.order_id=o.order_id
      WHERE a.provider='metorik_orders' AND a.source=e.source AND a.native_customer_id=e.native_customer_id AND o.customer_id=e.native_customer_id
    ) THEN CONCAT('woo:',e.source,':',e.native_customer_id) ELSE e.profile_key END profile_key,
    e.normalized,e.email_state FROM ${t('email_observations')} e),
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
    FROM h_orders o LEFT JOIN h_addresses a USING(source,order_id) LEFT JOIN h_usable u USING(source,order_id) LEFT JOIN h_cross x USING(source,order_id))`;
}
export function historyCoverageSql(project,dataset){return `WITH ${historyLinkCtes(project,dataset)} SELECT source,COUNT(*) orders,COUNTIF(resolution='matched') matched,COUNTIF(resolution='unmatched') unmatched,COUNTIF(resolution='ambiguous') ambiguous,COUNTIF(resolution='unavailable') unavailable,COUNTIF(conflicting_email) conflicting_orders,COUNTIF(shared_email) shared_address_orders,COUNTIF(customer_id IS NULL OR customer_id IN ('','0')) guest_or_unknown_orders FROM h_resolved GROUP BY source ORDER BY source`;}
