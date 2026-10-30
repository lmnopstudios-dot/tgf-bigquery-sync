import {squarePreviewPlan} from '../customer-identity/square-preview.js';
import {fq} from '../customer-identity/collect.js';
import {cohortRelations} from './cohort-execution.js';
import {JOURNEY_SCOPE_VERSION,validateJourneyScope} from './journey-scope.js';

export const SQUARE_IDENTITY_VERSION='square_native_email_v1';
// A separate reviewed marker is required; the accepted identity snapshot is not
// extended or replaced. This module has no setup, collection or publication API.
export function squareExtensionConfiguration(env={}){
 if(env.ORACLE_SQUARE_REPORTING_VERSION!==JOURNEY_SCOPE_VERSION||!/^[A-Za-z0-9_-]{1,100}$/.test(env.ORACLE_SQUARE_REPORTING_EXTENSION_ID||''))return null;
 return {version:JOURNEY_SCOPE_VERSION,id:env.ORACLE_SQUARE_REPORTING_EXTENSION_ID,state:'reviewed'};
}
export function squareExtensionGuard(project,identity,extension){
 if(extension?.state==='preview')return 'TRUE'; // trusted diagnostic option only
 if(extension?.version!==JOURNEY_SCOPE_VERSION||!/^[A-Za-z0-9_-]{1,100}$/.test(extension.id||''))throw Error('Square reporting review required');
 return `(SELECT IF(COUNT(*)=1 AND COUNTIF(state='reviewed' AND reporting_version='${JOURNEY_SCOPE_VERSION}' AND identity_version='${SQUARE_IDENTITY_VERSION}' AND base_snapshot='${identity.snapshot}')=1,TRUE,ERROR('Square reporting extension review unavailable')) FROM ${fq(project,identity.dataset,'identity_reporting_extensions')} WHERE extension_id='${extension.id}')`;
}
export function extendJourneyChannelsSql(sql,project,identity,scope,extension){
 scope=validateJourneyScope(scope);if(!scope)return sql;
 if(!identity?.orderLinks)throw Error('Versioned journey scope requires existing order-email history');
 const parsed=cohortRelations(sql),get=n=>{const r=parsed.relations.find(r=>r.name===n);if(!r)throw Error('Missing shared journey relation '+n);return r;};
 const extra=[];
 const rawChannel=get('raw_orders');
 const oldChannel="IF(l.retail_location_id IS NULL,'Online','In-store') channel";
 if(!rawChannel.body.includes(oldChannel))throw Error('Shared Shopify channel contract drift');
 rawChannel.body=rawChannel.body.replace(oldChannel,"CASE WHEN NULLIF(TRIM(l.retail_location_id),'') IS NOT NULL THEN 'In-store' WHEN LOWER(TRIM(JSON_VALUE(TO_JSON(l,stringify_wide_numbers=>TRUE),'$.order_source'))) IN ('online store','shop') THEN 'Online' ELSE 'Unknown' END channel");

 if(scope.include_square){
  if(!extension)throw Error('Square reporting review required');
  // Reuse #400's successful exact-ID and global shared/conflicting-email rules.
  // Stop before its diagnostic-only online eligibility and reporting relations.
  const inputs=squarePreviewPlan(project,{...identity,mode:'email_candidate_v2'}).stages;
  for(const s of inputs.slice(0,inputs.findIndex(s=>s.name==='sp_online_raw'))){
   let body=s.select.replaceAll('_SESSION.sp_','sx_');
   if(s.name==='sp_guard')body=`SELECT (${s.select.replace(/^SELECT /,'').replace(/ passed$/,'')}) AND ${squareExtensionGuard(project,identity,extension)} passed`;
   if(s.name==='sp_square_latest')body=body.replace('SELECT COALESCE(', 'SELECT j,COALESCE(');
   extra.push({name:s.name.replace('sp_','sx_'),body});
  }
  extra.push({name:'sx_channel_evidence',body:`WITH p AS(SELECT TO_JSON(p,stringify_wide_numbers=>TRUE) j FROM ${fq(project,'square_data','payments')} p)
    SELECT JSON_VALUE(j,'$.order_id') oid,JSON_VALUE(j,'$.location_id') location_id,
    COUNTIF(UPPER(JSON_VALUE(j,'$.status'))='COMPLETED') completed_payments,
    COUNTIF(UPPER(JSON_VALUE(j,'$.status'))='COMPLETED' AND UPPER(JSON_VALUE(j,'$.source_type'))='CARD' AND UPPER(JSON_VALUE(j,'$.card_details.entry_method')) IN ('EMV','SWIPED','CONTACTLESS')) card_present_payments
    FROM p GROUP BY oid,location_id`});
  extra.push({name:'sx_square_channels',body:`SELECT o.oid,IF(COUNTIF(p.completed_payments>0 AND p.location_id=o.location_id)>0 AND SUM(p.completed_payments)=SUM(p.card_present_payments) AND COUNTIF(p.location_id IS NULL OR p.location_id!=o.location_id)=0,'In-store','Unknown') channel
    FROM sx_square o LEFT JOIN sx_channel_evidence p USING(oid) GROUP BY o.oid`});
  extra.push({name:'sx_square_projection',body:`SELECT 'square' source_platform,'square' source_store,c.channel,o.oid order_ref,o.cid source_customer_id,o.ts order_timestamp,LOWER(o.state) status,
    COALESCE(JSON_VALUE(o.j,'$.currency'),JSON_VALUE(o.j,'$.total_money.currency')) currency,CAST(NULL AS NUMERIC) order_total,CAST(NULL AS NUMERIC) refunds,FALSE migrated,FALSE cancelled,TRUE customer_record_present,o.cid IS NULL persisted_guest
    FROM sx_square o JOIN sx_square_channels c USING(oid) CROSS JOIN sx_guard g WHERE g.passed`});
  // Only the raw UNION and Square's native eligibility branch are additive.
  const raw=get('raw_orders');raw.body+=' UNION ALL SELECT * FROM sx_square_projection';
  const qualify=get('qualifying_orders');
  const status="((source_platform='woo' AND status IN ('completed','processing')) OR (source_platform='shopify' AND status IN ('paid','partially_paid','partially_refunded')))\n      AND COALESCE(order_total,0)>COALESCE(refunds,0)";
  if(!qualify.body.includes(status))throw Error('Shared eligibility contract drift');
  qualify.body=qualify.body.replace(status,`((source_platform='square' AND status IN ('complete','completed')) OR (${status}))`);
  qualify.body=`SELECT q.* REPLACE(IF(q.source_platform='square',COALESCE(s.identity_ref,q.governed_customer_ref),q.governed_customer_ref) AS governed_customer_ref)
    FROM (${qualify.body}) q LEFT JOIN sx_links s ON q.source_platform='square' AND q.source_customer_id=s.cid
    WHERE q.source_platform!='square' OR q.source_customer_id IS NOT NULL`;
  extra.push({name:'sx_expected_lines',body:`SELECT o.oid,off,COALESCE(NULLIF(JSON_VALUE(l,'$.uid'),''),NULLIF(JSON_VALUE(l,'$.id'),'')) line_id,
    COALESCE(NULLIF(JSON_VALUE(l,'$.item_id'),''),NULLIF(JSON_VALUE(l,'$.catalog_object_id'),'')) product_id,
    SAFE_CAST(JSON_VALUE(l,'$.quantity') AS NUMERIC) qty,JSON_VALUE(l,'$.name') title
    FROM sx_square o,UNNEST(COALESCE(JSON_QUERY_ARRAY(o.j,'$.line_items'),JSON_QUERY_ARRAY(SAFE.PARSE_JSON(JSON_VALUE(o.j,'$.line_items'))),ARRAY<JSON>[])) l WITH OFFSET off`});
  extra.push({name:'sx_persisted_lines',body:`SELECT DISTINCT CAST(order_id AS STRING) oid,source_line_offset off,line_item_uid line_id,
    COALESCE(NULLIF(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),''),NULLIF(catalog_object_id,'')) product_id,quantity qty
    FROM ${fq(project,'square_data','retail_order_items')}`});
  // Reconcile to latest persisted order lines, rather than multiplying revisions
  // of the retail view. Unreconciled lines remain explicit unknown attribution.
  extra.push({name:'sx_lines',body:`SELECT 'square' source_platform,'square' source_store,e.oid order_ref,
    IF(i.oid IS NOT NULL AND e.qty>0,e.product_id,NULL) source_product_id,e.title product_title,e.qty units,CAST(NULL AS NUMERIC) line_sales,CAST(NULL AS STRING) currency
    FROM sx_expected_lines e LEFT JOIN sx_persisted_lines i ON e.oid=i.oid AND e.off=i.off AND e.line_id IS NOT DISTINCT FROM i.line_id AND e.product_id IS NOT DISTINCT FROM i.product_id AND e.qty IS NOT DISTINCT FROM i.qty`});
  get('lines').body+=' UNION ALL SELECT * FROM sx_lines';
  const classified=get('classified_lines');
  classified.body=`SELECT q.* REPLACE(IF(q.source_platform='square' AND a.source_ref IS NOT NULL,ARRAY_CONCAT(q.classifications,['classification_conflict=true']),q.classifications) AS classifications)
    FROM (${classified.body}) q LEFT JOIN (SELECT source_ref FROM cr_routes WHERE STARTS_WITH(classification_ref,'shopify:shopify:') GROUP BY source_ref HAVING COUNT(DISTINCT classification_ref)>1) a ON q.source_product_ref=a.source_ref`;

  // Square type membership comes solely from governed classifications. A title
  // may label an unknown item; it cannot infer collaboration or Ring Sizer type.
  const pj=parsed.relations.find(r=>r.name==='pj_lines');
  if(pj)pj.body=pj.body.replace("REGEXP_CONTAINS(LOWER(TRIM(reporting_product_title)),r'^ring sizers?$')", ()=>"(source_platform!='square' AND REGEXP_CONTAINS(LOWER(TRIM(reporting_product_title)),r'^ring sizers?$'))");
  // Coverage and per-source diagnostics must retain Square rather than treating
  // a native eligible Square order as an excluded Shopify/Woo transaction.
  const history=get('source_history');
  history.body=history.body.replace("NOT ((source_platform='woo'", "source_platform!='square' AND (NOT ((source_platform='woo'").replace(' excluded_orders',' ) excluded_orders');
 }
 const next=get('retention_next_orders');
 if(scope.next==='anywhere_then_filter'){
  const filter=' AND (@subsequent_channel IS NULL OR r.channel=@subsequent_channel)';
  if(!next.body.includes(filter))throw Error('Shared next-order contract drift');
  next.body=`SELECT * FROM (${next.body.replace(filter,'')}) WHERE @subsequent_channel IS NULL OR channel=@subsequent_channel`;
 }
 // All lineage is combined before this existing ROW_NUMBER. Entry and return
 // channel filters remain downstream. Unknown channels survive all-history reads.
 extra.push({name:'sx_reporting_order_attribution',body:`SELECT source_platform,source_store,order_ref,COUNT(*) product_lines,
   COUNTIF(family_status IN ('governed_family','governed_product')) mapped_lines,
   COUNTIF(family_status='ambiguous_family' OR 'classification_conflict=true' IN UNNEST(classifications)) ambiguous_lines,
   COUNTIF((${/* shared governed classifier, no title inference */''}CASE WHEN 'classification_conflict=true' IN UNNEST(classifications) THEN FALSE ELSE EXISTS(SELECT 1 FROM UNNEST(classifications) x WHERE STARTS_WITH(x,'collaboration_name=') AND x NOT IN ('collaboration_name=collaboration','collaboration_name=collaborations')) END)) named_lines
   FROM retention_reporting_lines GROUP BY source_platform,source_store,order_ref`});
 extra.push({name:'sx_reporting_coverage',body:`WITH customer_coverage AS(SELECT q.source_platform,q.source_store,q.channel,EXTRACT(YEAR FROM q.order_timestamp) year,COUNT(*) eligible_orders,
   COUNT(DISTINCT q.governed_customer_ref) analytical_records,COUNTIF(q.source_customer_id IS NULL OR q.source_customer_id IN ('','0')) anonymous_orders,
   COUNTIF(a.order_ref IS NULL) orders_without_lines,COALESCE(SUM(a.product_lines),0) product_lines,COALESCE(SUM(a.mapped_lines),0) mapped_lines,COALESCE(SUM(a.ambiguous_lines),0) ambiguous_lines,COALESCE(SUM(a.named_lines),0) named_lines,
   ROUND(100*SAFE_DIVIDE(SUM(a.mapped_lines),SUM(a.product_lines)),2) mapped_line_pct,MIN(q.order_timestamp) observed_start,MAX(q.order_timestamp) observed_end
   FROM qualifying_orders q LEFT JOIN sx_reporting_order_attribution a USING(source_platform,source_store,order_ref) GROUP BY q.source_platform,q.source_store,q.channel,year)
   ${scope.include_square?`, square_population AS(SELECT 'square' source_platform,'square' source_store,c.channel,EXTRACT(YEAR FROM o.ts) year,COUNT(*) eligible_transaction_orders,COUNTIF(o.cid IS NULL) unidentifiable_orders,COUNTIF(o.native_conflict) native_conflict_orders
     FROM sx_square o JOIN sx_square_channels c USING(oid) WHERE o.state IN ('COMPLETE','COMPLETED') AND DATE(o.ts,@time_zone)<=@observation_end GROUP BY c.channel,year)
     SELECT COALESCE(c.source_platform,s.source_platform) source_platform,COALESCE(c.source_store,s.source_store) source_store,COALESCE(c.channel,s.channel) channel,COALESCE(c.year,s.year) year,
     COALESCE(c.eligible_orders,0) eligible_orders,COALESCE(c.analytical_records,0) analytical_records,COALESCE(c.anonymous_orders,0) anonymous_orders,COALESCE(c.orders_without_lines,0) orders_without_lines,
     COALESCE(c.product_lines,0) product_lines,COALESCE(c.mapped_lines,0) mapped_lines,COALESCE(c.ambiguous_lines,0) ambiguous_lines,COALESCE(c.named_lines,0) named_lines,c.mapped_line_pct,c.observed_start,c.observed_end,
     COALESCE(s.eligible_transaction_orders,c.eligible_orders) eligible_transaction_orders,COALESCE(s.unidentifiable_orders,0) unidentifiable_orders,COALESCE(s.native_conflict_orders,0) native_conflict_orders
     FROM customer_coverage c FULL OUTER JOIN square_population s USING(source_platform,source_store,channel,year)`:`SELECT *,eligible_orders eligible_transaction_orders,0 unidentifiable_orders,0 native_conflict_orders FROM customer_coverage`}`});
 // The source stages must precede raw_orders. Coverage depends on governed line
 // classification and eligible order relations, so it is appended after those.
 const source=extra.filter(r=>!r.name.startsWith('sx_reporting_')),coverage=extra.filter(r=>r.name.startsWith('sx_reporting_'));
 const all=[...source,...parsed.relations,...coverage];
 const result=parsed.result.replace(/^SELECT\s+/i,'SELECT ARRAY(SELECT AS STRUCT source_platform,source_store,channel,year,eligible_orders,analytical_records,anonymous_orders,orders_without_lines,product_lines,mapped_lines,ambiguous_lines,named_lines,mapped_line_pct,observed_start,observed_end,eligible_transaction_orders,unidentifiable_orders,native_conflict_orders FROM sx_reporting_coverage ORDER BY source_platform,source_store,channel,year) reporting_coverage,');
 if(result===parsed.result)throw Error('Missing terminal reporting projection');
 return `WITH ${all.map(r=>`${r.name} AS (${r.body})`).join(',\n')}\n${result}`;
}
export function finalizeJourneyExtensionSql(sql){
 const p=cohortRelations(sql),pj=p.relations.find(r=>r.name==='pj_lines');
 if(pj)pj.body=pj.body.replace("REGEXP_CONTAINS(LOWER(TRIM(reporting_product_title)),r'^ring sizers?$')", ()=>"(source_platform!='square' AND REGEXP_CONTAINS(LOWER(TRIM(reporting_product_title)),r'^ring sizers?$'))");
 return `WITH ${p.relations.map(r=>`${r.name} AS (${r.body})`).join(',\n')}\n${p.result.replace(/^SELECT\s+/i,'SELECT ARRAY(SELECT AS STRUCT source_platform,source_store,channel,year,eligible_orders,analytical_records,anonymous_orders,orders_without_lines,product_lines,mapped_lines,ambiguous_lines,named_lines,mapped_line_pct,observed_start,observed_end,eligible_transaction_orders,unidentifiable_orders,native_conflict_orders FROM sx_reporting_coverage ORDER BY source_platform,source_store,channel,year) reporting_coverage,')}`;
}
