import {fq,identifier,SCOPE} from './collect.js';
import {HISTORY_SCOPE,historyLinkStages} from './history-sql.js';
import {orderSnapshotGuardSql} from '../oracle/customer-identity.js';
import {customerJourneySql} from '../oracle/customer-journey.js';
import {cohortRelations} from '../oracle/cohort-execution.js';

export const SQUARE_PREVIEW_EVIDENCE=Object.freeze({snapshot_candidate_square_ids:1543,snapshot_candidate_square_orders:2050,verified_people:false});
export const SQUARE_PREVIEW_LIMITS=Object.freeze({totalBytes:5000000000,stageMs:60000,totalMs:240000});
// Preview is deliberately not imported by collectors, publishers, Oracle services
// or activation configuration. All identity-bearing relations remain session-local.
export function squarePreviewPlan(project,identity){
 identifier(project);identifier(identity?.dataset);
 if(identity?.mode!=='email_candidate_v2'||!identity.orderLinks)throw Error('Existing order-email v2 snapshot required');
 if(!historyLinkStages(project,identity.dataset).find(s=>s.name==='h_resolved')?.sql.includes("CONCAT('email-record|',u.normalized)"))throw Error('Email-reference contract drift');
 const t=(d,n)=>fq(project,d,n),guard=orderSnapshotGuardSql(project,identity);
 const v=(j,k)=>`IF(NULLIF(TRIM(JSON_VALUE(${j},'$.${k}')),'') IS NULL,NULL,JSON_VALUE(${j},'$.${k}'))`;
 const co=(j,keys)=>`COALESCE(${keys.map(k=>v(j,k)).join(',')},CAST(NULL AS STRING))`;
 const valid=String.raw`LENGTH(email)<=320 AND REGEXP_CONTAINS(email,r'^[^\s@]+@[^\s@]+\.[^\s@]+$') AND NOT REGEXP_CONTAINS(email,r'^(?:test|unknown|none|null|noemail|no-email|noreply|no-reply|guest|placeholder)(?:[+._-]|@)|@(?:example\.(?:com|org|net)|invalid\.|test\.)|\.(?:invalid|test)$')`;
 const end=`DATE '${SCOPE.end}'`,start=`DATE '${HISTORY_SCOPE.start}'`;
 const raw=cohortRelations(customerJourneySql(project,'summary')).relations.find(r=>r.name==='raw_orders').body;
 const stages=[];const add=(name,select)=>stages.push({name,select});
 add('sp_guard',`SELECT ${guard} passed`);
 add('sp_square_latest',`WITH order_rows AS(SELECT TO_JSON(o,stringify_wide_numbers=>TRUE) j FROM ${t('square_data','orders')} o)
 SELECT ${co('j',['order_id','id'])} oid,${v('j','customer_id')} order_cid,${v('j','location_id')} location_id,
 SAFE_CAST(${co('j',['created_at','closed_at'])} AS TIMESTAMP) ts,UPPER(${co('j',['state','status'])}) state
 FROM order_rows WHERE ${co('j',['order_id','id'])} IS NOT NULL
 QUALIFY ROW_NUMBER() OVER(PARTITION BY ${co('j',['order_id','id'])} ORDER BY SAFE_CAST(${co('j',['updated_at','closed_at','created_at'])} AS TIMESTAMP) DESC,SAFE_CAST(${co('j',['created_at','closed_at'])} AS TIMESTAMP) DESC,TO_JSON_STRING(j) DESC)=1`);
 add('sp_payments',`WITH p AS(SELECT TO_JSON(p,stringify_wide_numbers=>TRUE) j FROM ${t('square_data','payments')} p)
 SELECT ${v('j','order_id')} oid,COUNT(DISTINCT ${v('j','customer_id')}) ids,MIN(${v('j','customer_id')}) cid FROM p GROUP BY oid`);
 add('sp_square',`SELECT o.*,COALESCE(p.ids>1 OR(o.order_cid IS NOT NULL AND p.ids=1 AND o.order_cid!=p.cid),FALSE) native_conflict,
 CASE WHEN p.ids>1 OR(o.order_cid IS NOT NULL AND p.ids=1 AND o.order_cid!=p.cid) THEN NULL ELSE COALESCE(o.order_cid,p.cid) END cid
 FROM _SESSION.sp_square_latest o LEFT JOIN _SESSION.sp_payments p USING(oid)`);
 add('sp_directory',`WITH p AS(SELECT TO_JSON(c,stringify_wide_numbers=>TRUE) j FROM ${t('customers','square_data')} c)
 SELECT DISTINCT ${v('j','id')} cid,LOWER(TRIM(${v('j','email_address')})) email FROM p`);
 add('sp_email_values',`SELECT DISTINCT cid,email,CONCAT('c_',TO_HEX(SHA256(CONCAT('email-record|',email)))) canonical
 FROM _SESSION.sp_directory WHERE cid IS NOT NULL AND ${valid}`);
 add('sp_email_bad',`WITH counts AS(SELECT cid,COUNT(DISTINCT email) n FROM _SESSION.sp_email_values GROUP BY cid)
 SELECT v.email FROM _SESSION.sp_email_values v JOIN counts c USING(cid) WHERE c.n>1
 UNION DISTINCT SELECT email FROM _SESSION.sp_email_values GROUP BY email HAVING COUNT(DISTINCT cid)>1`);
 add('sp_snapshot',`SELECT source_store source,source_order_id oid,
 CASE WHEN source_store='shopify' THEN COALESCE(REGEXP_EXTRACT(CAST(source_customer_id AS STRING),r'^gid://shopify/Customer/([0-9]+)$'),NULLIF(NULLIF(CAST(source_customer_id AS STRING),''),'0')) ELSE NULLIF(NULLIF(CAST(source_customer_id AS STRING),''),'0') END cid,
 canonical_customer_ref canonical,resolution,conflicting_email,shared_email,financial_status,cancelled
 FROM ${t(identity.dataset,'identity_order_links')} WHERE snapshot_id='${identity.snapshot}' AND ${guard}`);
 add('sp_snapshot_bad',`WITH ambiguous_profiles AS(SELECT source,cid FROM _SESSION.sp_snapshot WHERE cid IS NOT NULL GROUP BY source,cid HAVING COUNT(DISTINCT canonical)>1)
 SELECT canonical FROM _SESSION.sp_snapshot WHERE resolution IN ('ambiguous','unavailable') OR COALESCE(conflicting_email,FALSE) OR COALESCE(shared_email,FALSE)
 UNION DISTINCT SELECT canonical FROM _SESSION.sp_snapshot GROUP BY canonical,source HAVING COUNT(DISTINCT cid)>1
 UNION DISTINCT SELECT s.canonical FROM _SESSION.sp_snapshot s JOIN ambiguous_profiles p USING(source,cid)`);
 add('sp_links',`WITH directory_ids AS(SELECT DISTINCT cid FROM _SESSION.sp_directory WHERE cid IS NOT NULL),
 email_counts AS(SELECT cid,COUNT(*) addresses,MIN(canonical) canonical FROM _SESSION.sp_email_values GROUP BY cid),
 excluded_ids AS(SELECT DISTINCT v.cid FROM _SESSION.sp_email_values v JOIN _SESSION.sp_email_bad b USING(email)),
 snapshot_refs AS(SELECT DISTINCT canonical FROM _SESSION.sp_snapshot),
 square_ids AS(SELECT DISTINCT cid FROM _SESSION.sp_square WHERE state IN ('COMPLETE','COMPLETED') AND cid IS NOT NULL)
 SELECT n.cid,e.canonical email_candidate_ref,
 CASE WHEN d.cid IS NULL THEN 'no_exact_directory_id' WHEN e.cid IS NULL THEN 'no_usable_directory_email'
 WHEN e.addresses>1 THEN 'conflicting_directory_email' WHEN x.cid IS NOT NULL THEN 'shared_or_conflicting_directory_email'
 WHEN b.canonical IS NOT NULL THEN 'unsafe_snapshot_identity' WHEN r.canonical IS NULL THEN 'no_snapshot_candidate' ELSE 'email_candidate' END linkage,
 CASE WHEN e.addresses=1 AND x.cid IS NULL AND b.canonical IS NULL AND r.canonical IS NOT NULL THEN e.canonical
 ELSE CONCAT('c_',TO_HEX(SHA256(CONCAT('square|square|',n.cid)))) END identity_ref
 FROM square_ids n LEFT JOIN directory_ids d USING(cid) LEFT JOIN email_counts e USING(cid) LEFT JOIN excluded_ids x USING(cid)
 LEFT JOIN _SESSION.sp_snapshot_bad b ON e.canonical=b.canonical LEFT JOIN snapshot_refs r ON e.canonical=r.canonical`);
 add('sp_online_raw',raw.replaceAll('@matrixify_app_id',"'gid://shopify/App/1758145'"));
 add('sp_online_orders',`SELECT * FROM _SESSION.sp_online_raw QUALIFY ROW_NUMBER() OVER(PARTITION BY source_platform,source_store,order_ref ORDER BY order_timestamp,refunds DESC,migrated DESC,cancelled DESC,status)=1`);
 add('sp_online',`SELECT o.*,s.canonical,s.resolution,s.conflicting_email,s.shared_email,
 COALESCE(o.status,LOWER(s.financial_status)) effective_status,
 IF(o.status IS NULL,COALESCE(s.cancelled,o.cancelled),o.cancelled) effective_cancelled,
 COALESCE(o.source_customer_id IS NOT NULL AND o.source_customer_id NOT IN ('','0') AND s.cid IS NOT NULL AND
 (CASE WHEN o.source_store='shopify' THEN COALESCE(REGEXP_EXTRACT(o.source_customer_id,r'^gid://shopify/Customer/([0-9]+)$'),o.source_customer_id) ELSE o.source_customer_id END)!=s.cid,FALSE) native_conflict,
 s.oid IS NOT NULL snapshot_present,b.canonical IS NOT NULL unsafe_identity
 FROM _SESSION.sp_online_orders o LEFT JOIN _SESSION.sp_snapshot s ON s.source=o.source_store AND s.oid=o.order_ref
 LEFT JOIN _SESSION.sp_snapshot_bad b ON s.canonical=b.canonical`);
 add('sp_eligible',`SELECT 'square' source,o.oid,o.cid,o.ts,o.location_id,
 COALESCE(l.identity_ref,CONCAT('c_',TO_HEX(SHA256(CONCAT('unlinked-order|square|',o.oid))))) identity_ref,
 COALESCE(l.linkage,'missing_or_conflicting_native_id') linkage
 FROM _SESSION.sp_square o LEFT JOIN _SESSION.sp_links l USING(cid)
 WHERE state IN ('COMPLETE','COMPLETED') AND DATE(ts) BETWEEN ${start} AND ${end}
 UNION ALL SELECT source_store,order_ref,NULLIF(NULLIF(source_customer_id,''),'0'),order_timestamp,CAST(NULL AS STRING),canonical,'snapshot_email_candidate'
 FROM _SESSION.sp_online WHERE NOT migrated AND NOT effective_cancelled AND NOT native_conflict AND snapshot_present AND NOT unsafe_identity
 AND resolution IN ('matched','unmatched') AND NOT COALESCE(conflicting_email,FALSE) AND NOT COALESCE(shared_email,FALSE)
 AND ((source_platform='woo' AND effective_status IN ('completed','processing')) OR(source_platform='shopify' AND effective_status IN ('paid','partially_paid','partially_refunded')))
 AND COALESCE(order_total,0)>COALESCE(refunds,0) AND DATE(order_timestamp) BETWEEN ${start} AND ${end}`);
 add('sp_linked_refs',`SELECT identity_ref FROM _SESSION.sp_eligible GROUP BY identity_ref HAVING COUNTIF(source='square' AND linkage='email_candidate')>0 AND COUNTIF(source IN ('ww','usd','shopify'))>0`);
 add('sp_journeys',`WITH first_by_source AS(SELECT e.identity_ref,e.source,MIN(e.ts) first_ts FROM _SESSION.sp_eligible e JOIN _SESSION.sp_linked_refs r USING(identity_ref) GROUP BY e.identity_ref,e.source)
 SELECT f.source origin,e.source destination,e.identity_ref,e.oid,e.ts,e.location_id FROM first_by_source f JOIN _SESSION.sp_eligible e USING(identity_ref)
 WHERE e.ts>f.first_ts AND ((f.source='square' AND e.source IN ('ww','usd','shopify')) OR(f.source IN ('ww','usd','shopify') AND e.source='square'))`);
 // Result is a single JSON document made exclusively from aggregate relations.
 const result=`WITH source_year AS(SELECT e.source,EXTRACT(YEAR FROM e.ts) year,COUNT(*) eligible_orders,COUNT(DISTINCT e.cid) native_customer_ids,
 COUNTIF(r.identity_ref IS NOT NULL) linked_orders,COUNT(DISTINCT IF(r.identity_ref IS NOT NULL,e.identity_ref,NULL)) linked_email_candidate_records,
 MIN(e.ts) observed_start,MAX(e.ts) observed_end FROM _SESSION.sp_eligible e LEFT JOIN _SESSION.sp_linked_refs r USING(identity_ref) GROUP BY e.source,year),
 journey_totals AS(SELECT origin,destination,COUNT(DISTINCT identity_ref) email_candidate_records,COUNT(DISTINCT oid) destination_orders FROM _SESSION.sp_journeys GROUP BY origin,destination),
 journeys AS(SELECT origin,destination,EXTRACT(YEAR FROM ts) destination_year,location_id,COUNT(DISTINCT identity_ref) email_candidate_records,COUNT(DISTINCT oid) destination_orders FROM _SESSION.sp_journeys GROUP BY origin,destination,destination_year,location_id),
 exclusions AS(SELECT 'square' source,l.linkage reason,COUNT(*) orders,COUNT(DISTINCT o.cid) native_customer_ids FROM _SESSION.sp_square o JOIN _SESSION.sp_links l USING(cid) WHERE state IN ('COMPLETE','COMPLETED') GROUP BY l.linkage
 UNION ALL SELECT 'square','missing_or_conflicting_native_id',COUNT(*),0 FROM _SESSION.sp_square WHERE state IN ('COMPLETE','COMPLETED') AND cid IS NULL
 UNION ALL SELECT 'square','native_id_conflict',COUNT(*),0 FROM _SESSION.sp_square WHERE native_conflict
 UNION ALL SELECT 'square','ineligible_status',COUNT(*),COUNT(DISTINCT cid) FROM _SESSION.sp_square WHERE state IS NULL OR state NOT IN ('COMPLETE','COMPLETED')
 UNION ALL SELECT 'square','missing_or_out_of_scope_timestamp',COUNT(*),COUNT(DISTINCT cid) FROM _SESSION.sp_square WHERE ts IS NULL OR DATE(ts) NOT BETWEEN ${start} AND ${end}
 UNION ALL SELECT source_store,'matrixify_import',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE migrated GROUP BY source_store
 UNION ALL SELECT source_store,'native_id_conflict',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE native_conflict GROUP BY source_store
 UNION ALL SELECT source_store,'missing_snapshot_order',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE NOT snapshot_present GROUP BY source_store
 UNION ALL SELECT source_store,'unsafe_snapshot_identity',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE unsafe_identity GROUP BY source_store
 UNION ALL SELECT source_store,'cancelled',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE effective_cancelled GROUP BY source_store
 UNION ALL SELECT source_store,'ineligible_or_missing_financial_status',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE effective_status IS NULL OR NOT((source_platform='woo' AND effective_status IN ('completed','processing')) OR(source_platform='shopify' AND effective_status IN ('paid','partially_paid','partially_refunded'))) GROUP BY source_store
 UNION ALL SELECT source_store,'fully_refunded_or_missing_positive_total',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE COALESCE(order_total,0)<=COALESCE(refunds,0) GROUP BY source_store
 UNION ALL SELECT source_store,'missing_or_out_of_scope_timestamp',COUNT(*),COUNT(DISTINCT source_customer_id) FROM _SESSION.sp_online WHERE order_timestamp IS NULL OR DATE(order_timestamp) NOT BETWEEN ${start} AND ${end} GROUP BY source_store),
 summary AS(SELECT COUNT(DISTINCT IF(source='square' AND linkage='email_candidate',cid,NULL)) square_snapshot_candidate_ids,COUNTIF(source='square' AND linkage='email_candidate') square_snapshot_candidate_orders,
 COUNTIF(source='square' AND r.identity_ref IS NOT NULL) eligible_linked_square_orders,COUNT(DISTINCT IF(source='square' AND r.identity_ref IS NOT NULL,cid,NULL)) eligible_linked_square_ids,
 COUNTIF(source='square' AND r.identity_ref IS NULL) preserved_square_local_orders,
 COUNT(DISTINCT IF(source='square' AND r.identity_ref IS NULL,cid,NULL)) preserved_square_local_ids
 FROM _SESSION.sp_eligible e LEFT JOIN _SESSION.sp_linked_refs r USING(identity_ref))
 SELECT ${guard} existing_snapshot_guard_passed,(SELECT AS STRUCT * FROM summary) summary,
 ARRAY(SELECT AS STRUCT *,ROUND(100*SAFE_DIVIDE(linked_orders,eligible_orders),2) linked_order_pct FROM source_year ORDER BY source,year) eligible_by_source_year,
 ARRAY(SELECT AS STRUCT * FROM journey_totals ORDER BY origin,destination) journey_totals,
 ARRAY(SELECT AS STRUCT * FROM journeys ORDER BY origin,destination,destination_year,location_id) journeys,
 ARRAY(SELECT AS STRUCT * FROM exclusions ORDER BY source,reason) exclusions`;
 const count=stages.length+1,stageBytes=Math.floor(SQUARE_PREVIEW_LIMITS.totalBytes/count);
 return {stages,result,stageBytes:String(stageBytes),maximumExecutionBytes:String(stageBytes*count),limitations:[
 'Preview only. Email candidates are not verified people; no snapshot publication or activation.',
 'Journeys are any eligible origin followed by a strictly later eligible destination, not first-ever or immediate next purchases. Both directions and years/locations overlap.',
 'UTC years; observed timestamps do not certify continuous history or follow-up. Scope ends at the accepted snapshot boundary '+SCOPE.end+'.',
 'Snapshot candidate evidence 1543 IDs/2050 orders predates these eligibility/conflict filters and is not an assertion of current preview totals.',
 'Online orders must have an exact order-level snapshot match; no propagation to newly arrived orders. Unsafe references are excluded globally.',
 'Matrixify Shopify copies are excluded; original Woo orders count once per source/order. Other undocumented imports and cross-source duplicate originals remain unverified.',
 'Square location IDs are persisted transaction locations; physical-store provenance is not independently verified.',
 'Exclusion reasons overlap; native customer IDs and email candidate records are different units. Guests are not invented registered customers.',
 'Sequential stages are not an atomic source snapshot; the unchanged identity snapshot guard is evaluated at the start, snapshot read and result.'
 ]};
}
