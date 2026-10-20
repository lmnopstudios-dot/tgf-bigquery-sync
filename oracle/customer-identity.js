import {cohortRelations} from './cohort-execution.js';
import {boundedQuery} from './bounded-query.js';
import {fq,SCOPE} from '../customer-identity/collect.js';
import {HISTORY_SCOPE} from '../customer-identity/history-sql.js';

export function identityConfiguration(env=process.env) {
  if (!['email_candidate_v1','email_candidate_v2'].includes(env.ORACLE_CUSTOMER_IDENTITY_MODE)) return null;
  const dataset = env.ORACLE_CUSTOMER_IDENTITY_DATASET;
  const snapshot = env.ORACLE_CUSTOMER_IDENTITY_SNAPSHOT;
  if (!/^[A-Za-z0-9_]+$/.test(dataset||'') || !/^[A-Za-z0-9_-]{1,100}$/.test(snapshot||'')) return null;
  return {dataset,snapshot,mode:'email_candidate_v1',...(env.ORACLE_CUSTOMER_IDENTITY_MODE==='email_candidate_v2'?{orderLinks:true}: {})};
}
export function customerReferenceSql(identity) {
  return identity ? 'COALESCE((SELECT canonical_customer_ref FROM ci_aliases WHERE local_ref=@customer_ref),@customer_ref)' : '@customer_ref';
}
export function identityMappingCte(project,identity) {
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(identity.snapshot||''))throw Error('Invalid snapshot');
  if(identity.orderLinks)return `ci_mapping AS (
    SELECT source_store,source_order_id,ANY_VALUE(source_customer_id) source_customer_id,MIN(canonical_customer_ref) canonical_customer_ref,
      ANY_VALUE(resolution) resolution,ANY_VALUE(financial_status) financial_status,LOGICAL_OR(cancelled) cancelled
    FROM ${fq(project,identity.dataset,'identity_order_links')} WHERE snapshot_id='${identity.snapshot}' AND REGEXP_CONTAINS(canonical_customer_ref,r'^c_[A-Fa-f0-9]{64}$')
    GROUP BY source_store,source_order_id HAVING COUNT(*)=1
  )`;
  return `ci_mapping AS (
    SELECT source_store,source_customer_id,MIN(canonical_customer_ref) canonical_customer_ref
    FROM ${fq(project,identity.dataset,'identity_links')} WHERE snapshot_id='${identity.snapshot}' AND REGEXP_CONTAINS(canonical_customer_ref,r'^c_[A-Fa-f0-9]{64}$')
    GROUP BY source_store,source_customer_id HAVING COUNT(DISTINCT canonical_customer_ref)=1
  )`;
}
/** Relink only the customer reference, before any order sequencing or cohort dates.
 * Original transaction namespaces, product joins, filters and money are preserved. */
export function applyCustomerIdentitySql(sql,project,identity,reference='customer_ref') {
  if (!identity) return sql;
  const parsed = cohortRelations(sql);
  const qualifying = parsed.relations.find(r=>r.name==='qualifying_orders');
  if (!qualifying) throw Error('Missing shared qualifying order relation');
  if(identity.orderLinks){
    const raw=parsed.relations.find(r=>r.name==='raw_orders'||r.name==='order_evidence');
    if(!raw)throw Error('Missing original order evidence');
    const oid=reference==='customer_ref'?'source_order_id':'order_ref';
    raw.body=`SELECT r.* REPLACE(COALESCE(r.source_customer_id,m.source_customer_id) AS source_customer_id,
      COALESCE(r.status,m.financial_status) AS status,IF(r.status IS NULL,COALESCE(m.cancelled,r.cancelled),r.cancelled) AS cancelled)
      FROM (${raw.body}) r LEFT JOIN ci_mapping m ON m.source_store=r.source_store AND m.source_order_id=r.${oid}`;
    const gate=/source_customer_id IS NOT NULL AND source_customer_id NOT IN \(''\s*,\s*'0'\) AND /;
    if(!gate.test(qualifying.body))throw Error('Missing shared customer eligibility gate');
    qualifying.body=qualifying.body.replace(gate,'');
    qualifying.body=`SELECT q.* REPLACE(COALESCE(m.canonical_customer_ref,(SELECT canonical_customer_ref FROM ci_aliases WHERE local_ref=q.${reference}),IF(q.source_customer_id IS NOT NULL AND q.source_customer_id NOT IN ('','0'),q.${reference},NULL),CONCAT('c_',TO_HEX(SHA256(CONCAT('unlinked-order|',q.source_store,'|',q.${oid}))))) AS ${reference})
      FROM (${qualifying.body}) q LEFT JOIN ci_mapping m ON m.source_store=q.source_store AND m.source_order_id=q.${oid}`;
    const aliases=`ci_aliases AS (SELECT CONCAT('c_',TO_HEX(SHA256(CONCAT(IF(source_store='shopify','shopify','woo'),'|',source_store,'|',source_customer_id)))) local_ref,MIN(canonical_customer_ref) canonical_customer_ref FROM ci_mapping WHERE source_customer_id IS NOT NULL AND source_customer_id NOT IN ('','0') GROUP BY source_store,source_customer_id HAVING COUNT(DISTINCT canonical_customer_ref)=1)`;
    const result=reference==='customer_ref'?parsed.result.replaceAll('= @customer_ref','= COALESCE((SELECT canonical_customer_ref FROM ci_aliases WHERE local_ref=@customer_ref),@customer_ref)'):parsed.result;
    return `WITH ${identityMappingCte(project,identity)},${aliases},\n${parsed.relations.map(r=>`${r.name} AS (${r.body})`).join(',\n')}\n${result}`;
  }
  qualifying.body = `SELECT q.* REPLACE(COALESCE(m.canonical_customer_ref,q.${reference}) AS ${reference})
    FROM (${qualifying.body}) q LEFT JOIN ci_mapping m
    ON m.source_store=q.source_store AND m.source_customer_id=q.source_customer_id`;
  const aliases = `ci_aliases AS (SELECT CONCAT('c_',TO_HEX(SHA256(CONCAT(IF(source_store='shopify','shopify','woo'),'|',source_store,'|',source_customer_id)))) local_ref,canonical_customer_ref FROM ci_mapping)`;
  const result = reference==='customer_ref' ? parsed.result.replaceAll('= @customer_ref', '= COALESCE((SELECT canonical_customer_ref FROM ci_aliases WHERE local_ref=@customer_ref),@customer_ref)') : parsed.result;
  return `WITH ${identityMappingCte(project,identity)},${aliases},\n${parsed.relations.map(r=>`${r.name} AS (${r.body})`).join(',\n')}\n${result}`;
}
export function identityCoverageSql(baseSql,project,identity) {
  if(identity.orderLinks)return `WITH ci_counts AS (SELECT source_store,COUNT(*) qualifying_orders,
    COUNT(DISTINCT NULLIF(NULLIF(source_customer_id,''),'0')) identified_profiles,
    COUNT(DISTINCT IF(resolution='matched',NULLIF(NULLIF(source_customer_id,''),'0'),NULL)) mapped_profiles,
    COUNTIF(resolution='matched') matched_orders,COUNTIF(resolution='unmatched') unmatched_orders,COUNTIF(resolution='ambiguous') ambiguous_orders,COUNTIF(resolution='unavailable') unavailable_orders,
    COUNTIF(source_customer_id IS NULL OR source_customer_id IN ('','0')) email_linked_guest_or_unknown_records
    ,COUNTIF(conflicting_email) conflicting_orders,COUNTIF(shared_email) shared_address_orders
    FROM ${fq(project,identity.dataset,'identity_order_links')} WHERE snapshot_id='${identity.snapshot}' GROUP BY source_store)
    SELECT *,identified_profiles-mapped_profiles unmatched_profiles FROM ci_counts`;
  const parsed=cohortRelations(baseSql);
  const end=parsed.relations.findIndex(r=>r.name==='qualifying_orders');
  return `WITH ${identityMappingCte(project,identity)},
    ${parsed.relations.slice(0,end+1).map(r=>`${r.name} AS (${r.body})`).join(',')}
    ,ci_counts AS (SELECT q.source_store,COUNT(DISTINCT q.source_customer_id) identified_profiles,
      COUNT(DISTINCT IF(m.source_customer_id IS NOT NULL,q.source_customer_id,NULL)) mapped_profiles,
      COUNT(DISTINCT IF(m.source_customer_id IS NULL,q.source_customer_id,NULL)) unmatched_profiles,
      COUNT(*) qualifying_orders
    FROM qualifying_orders q LEFT JOIN ci_mapping m
      ON m.source_store=q.source_store AND m.source_customer_id=q.source_customer_id GROUP BY 1), ci_sources AS (SELECT 'ww' source_store UNION ALL SELECT 'usd' UNION ALL SELECT 'shopify')
    SELECT s.source_store,COALESCE(c.identified_profiles,0) identified_profiles,COALESCE(c.mapped_profiles,0) mapped_profiles,COALESCE(c.unmatched_profiles,0) unmatched_profiles,COALESCE(c.qualifying_orders,0) qualifying_orders
    FROM ci_sources s LEFT JOIN ci_counts c USING(source_store)`;
}
/** Resolve once per call, never retain a previous request's activation state.
 * Missing permissions/snapshot fail to source-local reporting, with visible metadata.
 * Query/provider failures after readiness retain their existing failure semantics. */
export function identityAwareService(options,factory,coverageSql) {
  const base=factory({...options,identity:null});
  const config=identityConfiguration(options.env||process.env);
  return Object.fromEntries(Object.keys(base).map(method=>[method,async (...args)=>{
    if(!config){
      const result=await base[method](...args);
      return ['email_candidate_v1','email_candidate_v2'].includes((options.env||process.env).ORACLE_CUSTOMER_IDENTITY_MODE)?{...result,identity_evidence:{mode:'source_qualified_only',activation:'fallback',reason:'invalid_activation_configuration'}}:result;
    }
    let coverage;
    const started=Date.now();
    try {
      const [snapshots]=await boundedQuery(options.bigquery,{
        query:`SELECT state,start_date,end_date,mapping_count FROM ${fq(options.project,config.dataset,'identity_snapshots')} WHERE snapshot_id=@snapshot LIMIT 2`,
        params:{snapshot:config.snapshot},maximumBytesBilled:'10000000',jobTimeoutMs:5000,
      },{maximumMs:5000,...(args[1]?.signal?{signal:args[1].signal}:{})});
      const snapshot=snapshots[0];
      if (snapshots.length!==1 || snapshot.state!=='ready' || Number(snapshot.mapping_count)<1 ||
        (snapshot.start_date?.value||snapshot.start_date)!==(config.orderLinks?HISTORY_SCOPE.start:SCOPE.start) || (snapshot.end_date?.value||snapshot.end_date)!==SCOPE.end) throw Error('Snapshot not ready');
      const [counts]=await boundedQuery(options.bigquery,{
        query:identityCoverageSql(coverageSql(options.project),options.project,config),
        params:{matrixify_app_id:'gid://shopify/App/1758145'},maximumBytesBilled:SCOPE.bytes,jobTimeoutMs:5000,
      },{maximumMs:5000,...(args[1]?.signal?{signal:args[1].signal}:{})});
      if(counts.length!==3||new Set(counts.map(r=>r.source_store)).size!==3)throw Error('Incomplete identity coverage');
      coverage=counts.map(row=>{
        const result={source_store:row.source_store};
        if (!['ww','usd','shopify'].includes(row.source_store)) throw Error('Invalid identity coverage');
        for (const key of ['identified_profiles','mapped_profiles','unmatched_profiles','qualifying_orders']) {
          const n=Number(row[key]);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid identity coverage');result[key]=n;
        }
        if(result.mapped_profiles+result.unmatched_profiles!==result.identified_profiles)throw Error('Invalid identity coverage');
        if(config.orderLinks){
          for(const key of ['matched_orders','unmatched_orders','ambiguous_orders','unavailable_orders','email_linked_guest_or_unknown_records','conflicting_orders','shared_address_orders']){const n=Number(row[key]);if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid order coverage');result[key]=n;}
          if(result.matched_orders+result.unmatched_orders+result.ambiguous_orders+result.unavailable_orders!==result.qualifying_orders)throw Error('Invalid order coverage partition');
        }
        return result;
      });
    } catch(error) {
      if(args[1]?.signal?.aborted||error.code==='REQUEST_CANCELLED'||error.code==='LEASE_NOT_OWNED')throw error;
      const result=await base[method](...args);
      return {...result,identity_evidence:{mode:'source_qualified_only',activation:'fallback',reason:'snapshot_or_coverage_unavailable'}};
    }
    const remaining=Number(args[1]?.timeoutMs||45000)-(Date.now()-started);
    if(remaining<=0)throw Error('Identity read deadline');
    const active=factory({...options,identity:config});
    const activeArgs=[...args];
    if(method==='analyzeCustomerJourney')activeArgs[1]={...args[1],timeoutMs:remaining};
    const result=await active[method](...activeArgs);
    return {...result,identity_evidence:{mode:config.mode,snapshot:config.snapshot,activation:'active',coverage_scope:config.orderLinks?'snapshot original orders, all statuses; email-linked records include guests; unmatched anonymous orders remain separate records':'all qualifying source history; guests excluded',...(config.orderLinks?{identity_unit:'email-linked records; registered source IDs preserved; anonymous unmatched orders are isolated records',version:'order_email_v2'}:{}),sources:coverage,
      limitation:'Email links are analytical candidates, not verified people. Missing and unmatched profiles retain source-local identity; first-ever and complete follow-up coverage remain unverified.'}};
  }]));
}
