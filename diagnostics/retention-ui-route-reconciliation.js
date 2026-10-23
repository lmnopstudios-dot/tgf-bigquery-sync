import {classificationReaderCtes,classificationRefSql} from '../oracle/classification-reader.js';
export const exactWooSubjects=Object.freeze({ww:['11737','11795','23150','44905','11549','11593','11594','92837','11634','80797','60637','80795'],usd:['106660','106592','106354','106178','106807','106986','106800','108048','108303','108052','108175','108623']});
// Exact subjects supplied by the user/successful discovery; these are diagnostic
// keys, never a report cohort list or an inferred governance relationship.
export function uiRouteReconciliationSql(project,{reader=classificationReaderCtes(project),raw=true,normalizeRef=classificationRefSql}={}){
 if(!/^[A-Za-z0-9_-]+$/.test(project))throw Error('Invalid project');
 const refs=Object.entries(exactWooSubjects).flatMap(([s,ids])=>ids.map(id=>`'woo:${s}:${id}'`)).join(',');
 const variation=Object.entries(exactWooSubjects).flatMap(([s,ids])=>['product_variations','order_line_items'].map(table=>`SELECT DISTINCT 'woo:${s}:' prefix,CAST(product_id AS STRING) parent_id,CAST(variation_id AS STRING) variation_id,name,sku,'${table}' evidence_source FROM \`${project}.${s==='ww'?'metorik_uk':'metorik_us'}.${table}\` WHERE CAST(product_id AS STRING) IN (${ids.map(id=>`'${id}'`).join(',')}) AND variation_id IS NOT NULL AND CAST(variation_id AS STRING) NOT IN ('','0')`)).join(' UNION DISTINCT ');
 const norm=normalizeRef;
 // Materialize logical key sets before selection. Never reference outer rows
 // from IN/EXISTS table subqueries; both deployed/candidate paths use these joins.
 const scope=`scope_parents AS (SELECT ref FROM UNNEST([${refs}]) ref),
 scope_variations AS (${variation}),
 scope_refs AS (SELECT ref FROM scope_parents UNION DISTINCT SELECT CONCAT(prefix,variation_id) FROM scope_variations WHERE variation_id IS NOT NULL),
 scope_ids AS (SELECT DISTINCT SPLIT(ref,':')[SAFE_OFFSET(2)] id FROM scope_refs),
 scope_map_seed AS (SELECT m.* FROM cr_map_history m
   LEFT JOIN scope_ids l ON l.id=SPLIT(m.left_ref,':')[SAFE_OFFSET(2)]
   LEFT JOIN scope_ids r ON r.id=SPLIT(m.right_ref,':')[SAFE_OFFSET(2)]
   WHERE l.id IS NOT NULL OR r.id IS NOT NULL),
 scope_relationship_keys AS (SELECT DISTINCT resolved_relationship_id FROM scope_map_seed),
 scope_map_decision_keys AS (SELECT DISTINCT resolved_decision_id FROM scope_map_seed),
 scope_family_seed AS (SELECT f.* FROM cr_family_history f JOIN scope_ids s ON s.id=SPLIT(f.source_ref,':')[SAFE_OFFSET(2)]),
 scope_family_decision_keys AS (SELECT DISTINCT resolved_decision_id FROM scope_family_seed),
 scope_targets AS (
   SELECT ${norm('m.right_ref')} ref FROM cr_map_history m JOIN scope_refs s ON s.ref=m.left_ref
   UNION DISTINCT SELECT ${norm('m.left_ref')} FROM cr_map_history m JOIN scope_refs s ON s.ref=m.right_ref
   UNION DISTINCT SELECT ${norm('f.shopify_parent_ref')} FROM cr_family_history f JOIN scope_refs s ON s.ref=f.source_ref),
 scope_classification_refs AS (SELECT ref FROM scope_refs UNION DISTINCT SELECT ref FROM scope_targets)`;
 const kinds=[
 ['current_identity',`SELECT TO_JSON_STRING(m) record FROM cr_map_current m LEFT JOIN scope_refs l ON l.ref=m.left_ref LEFT JOIN scope_refs r ON r.ref=m.right_ref WHERE l.ref IS NOT NULL OR r.ref IS NOT NULL`],
 ['current_family',`SELECT TO_JSON_STRING(f) record FROM cr_family_current f JOIN scope_refs s ON s.ref=f.source_ref`],
 ['routes',`SELECT TO_JSON_STRING(r) record FROM cr_routes r JOIN scope_refs s ON s.ref=r.source_ref`],
 ['resolved_classifications',`SELECT TO_JSON_STRING(c) record FROM cr_resolved c JOIN scope_refs s ON s.ref=c.subject_ref`],
 ['classification_conflicts',`SELECT TO_JSON_STRING(c) record FROM cr_conflicts c JOIN scope_refs s ON s.ref=c.subject_ref`]];
 if(raw)kinds.push(
 ['identity_history',`SELECT TO_JSON_STRING(m) record FROM cr_map_history m LEFT JOIN scope_relationship_keys r ON r.resolved_relationship_id=m.resolved_relationship_id LEFT JOIN scope_map_decision_keys d ON d.resolved_decision_id=m.supersedes_decision_id WHERE r.resolved_relationship_id IS NOT NULL OR d.resolved_decision_id IS NOT NULL`],
 ['family_history',`SELECT TO_JSON_STRING(f) record FROM cr_family_history f LEFT JOIN scope_ids s ON s.id=SPLIT(f.source_ref,':')[SAFE_OFFSET(2)] LEFT JOIN scope_family_decision_keys d ON d.resolved_decision_id=f.supersedes_decision_id WHERE s.id IS NOT NULL OR d.resolved_decision_id IS NOT NULL`],
 ['variation_keys',`SELECT TO_JSON_STRING(v) record FROM scope_variations v`],
 ['target_classifications',`SELECT TO_JSON_STRING(c) record FROM cr_evidence c JOIN scope_targets t ON t.ref=c.subject_ref`],
 ['source_target_classification_history',`SELECT TO_JSON_STRING(c) record FROM \`${project}.commerce.product_classifications\` c JOIN scope_classification_refs s ON s.ref=${norm('c.subject_ref')}`],
 ['target_collection_decisions',`SELECT TO_JSON_STRING(STRUCT(t.ref AS target_ref,CAST(pc.collection_id AS STRING) AS collection_id,c AS collection_decision)) record FROM scope_targets t JOIN \`${project}.shopify_catalogue.product_collections\` pc ON t.ref=CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(pc.product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) LEFT JOIN cr_collection_current c ON c.collection_id=CAST(pc.collection_id AS STRING)`]);
 return `WITH ${reader},${scope},`+kinds.map(([kind,q],i)=>`audit_${i} AS (SELECT '${kind}' kind,record,COUNT(*) OVER() available_records,ROW_NUMBER() OVER(ORDER BY record) record_number FROM (${q}))`).join(',')+' '+kinds.map((_,i)=>`SELECT * FROM audit_${i} WHERE record_number<=501`).join(' UNION ALL ')+' ORDER BY kind,record_number';
}
