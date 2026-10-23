import {governedDecisionCtes, productFamilyCtes} from './product-mapping.js';

// Representation normalization only: never collapse stores or ProductVariant IDs.
export const classificationRefSql=expression=>`IF(STARTS_WITH(${expression},'shopify:shopify:'), IF(REGEXP_CONTAINS(SUBSTR(${expression},17),r'^(?:gid://shopify/Product/)?[0-9]+$'),CONCAT('shopify:shopify:',REGEXP_EXTRACT(SUBSTR(${expression},17),r'^(?:gid://shopify/Product/)?([0-9]+)$')),NULL),${expression})`;
export function normalizeClassificationRef(ref){
 if(!String(ref||'').startsWith('shopify:shopify:'))return ref||null;
 const id=ref.slice(16).match(/^(?:gid:\/\/shopify\/Product\/)?([0-9]+)$/)?.[1];
 return id?`shopify:shopify:${id}`:null;
}

/** Shared read-only current evidence. No sync/setup, title inference or writes.
 * Collection decisions are append-only; resolve latest BEFORE filtering status.
 * Families use the same per-source current-state resolver as the review UI.
 * Reporting families route classifications towards members, never assert identity.
 */
export function classificationReaderCtes(project){
 const norm=classificationRefSql;
 return `${governedDecisionCtes(project,'cr_map')},
 ${productFamilyCtes(project,'cr_family')},
 cr_identity AS (SELECT ${norm('left_ref')} source_ref,${norm('right_ref')} classification_ref FROM cr_map_active UNION DISTINCT SELECT ${norm('right_ref')},${norm('left_ref')} FROM cr_map_active),
 cr_family AS (SELECT ${norm('source_ref')} source_ref,${norm('shopify_parent_ref')} classification_ref FROM cr_family_current WHERE status='active'),
 cr_routes AS (SELECT *, 'approved_identity' mapping_type FROM cr_identity UNION DISTINCT SELECT *, 'approved_reporting_family' FROM cr_family UNION DISTINCT SELECT i.source_ref,f.classification_ref,'approved_reporting_family' FROM cr_identity i JOIN cr_family f ON f.source_ref=i.classification_ref),
 cr_product_superseded AS (SELECT supersedes_classification_id classification_id FROM \`${project}.commerce.product_classifications\` WHERE supersedes_classification_id IS NOT NULL),
 cr_product AS (SELECT ${norm('c.subject_ref')} subject_ref,c.classification_type,c.classification_value,c.provenance,c.status FROM \`${project}.commerce.product_classifications\` c LEFT JOIN cr_product_superseded s USING(classification_id) WHERE s.classification_id IS NULL AND c.status IN ('active','conflict') AND c.provenance NOT IN ('shopify_governed_collection','canonical_propagated') AND (effective_from IS NULL OR effective_from<=CURRENT_DATE('Europe/London')) AND (effective_to IS NULL OR effective_to>=CURRENT_DATE('Europe/London'))),
 cr_collection_current AS (SELECT * FROM \`${project}.commerce.collection_classifications\` WHERE platform='shopify' QUALIFY ROW_NUMBER() OVER(PARTITION BY platform,collection_id,classification_type ORDER BY reviewed_at DESC,classification_id DESC)=1),
 cr_collection AS (SELECT DISTINCT CONCAT('shopify:shopify:',REGEXP_EXTRACT(CAST(pc.product_id AS STRING),r'^(?:gid://shopify/Product/)?([0-9]+)$')) subject_ref,IF(c.classification_type='collection_group','product_group',c.classification_type) classification_type,c.classification_value,'shopify_governed_collection' provenance,'active' status FROM \`${project}.shopify_catalogue.product_collections\` pc JOIN cr_collection_current c ON CAST(pc.collection_id AS STRING)=c.collection_id WHERE c.status='active' AND (c.classification_type='collaboration_name' OR (c.classification_type='collection_group' AND c.classification_value='collaboration'))),
 cr_direct AS (SELECT * FROM cr_product UNION DISTINCT SELECT * FROM cr_collection),
 cr_evidence AS (SELECT *, 'direct' mapping_type FROM cr_direct UNION DISTINCT SELECT r.source_ref,d.classification_type,d.classification_value,d.provenance,d.status,r.mapping_type FROM cr_routes r JOIN cr_direct d ON d.subject_ref=r.classification_ref),
 cr_conflicts AS (SELECT subject_ref,classification_type FROM cr_evidence GROUP BY 1,2 HAVING COUNT(DISTINCT IF(classification_type='collaboration_name' AND classification_value IN ('collaboration','collaborations'),NULL,classification_value))>1 OR COUNTIF(status='conflict')>0 UNION DISTINCT SELECT subject_ref,'collaboration_name' FROM cr_evidence GROUP BY subject_ref HAVING COUNTIF(classification_type='product_group' AND classification_value IN ('core','core_range'))>0 AND COUNTIF(classification_type='collaboration_name' AND classification_value NOT IN ('collaboration','collaborations'))>0 UNION DISTINCT SELECT subject_ref,'product_group' FROM cr_evidence GROUP BY subject_ref HAVING COUNTIF(classification_type='product_group' AND classification_value IN ('core','core_range'))>0 AND COUNTIF(classification_type='collaboration_name' AND classification_value NOT IN ('collaboration','collaborations'))>0),
 cr_resolved AS (SELECT e.* FROM cr_evidence e LEFT JOIN cr_conflicts c USING(subject_ref,classification_type) WHERE c.subject_ref IS NULL AND e.subject_ref IS NOT NULL AND e.status='active')`;
}

export function collaborationStateSql(alias='l'){
 const a=`${alias}.classifications`;
 const names=`(SELECT COUNT(*) FROM UNNEST(${a}) x WHERE STARTS_WITH(x,'collaboration_name=') AND x NOT IN ('collaboration_name=collaboration','collaboration_name=collaborations'))`;
 const core=`('product_group=core' IN UNNEST(${a}) OR 'product_group=core_range' IN UNNEST(${a}))`;
 return `CASE WHEN ${alias}.source_product_id IS NULL OR ${alias}.source_product_id IN ('','0','unknown') THEN 'product_identity_unmatched' WHEN 'classification_conflict=true' IN UNNEST(${a}) OR ${names}>1 OR (${names}>0 AND ${core}) THEN 'conflicting' WHEN ${names}=1 THEN 'named' WHEN 'product_group=collaboration' IN UNNEST(${a}) OR 'collaboration_name=collaboration' IN UNNEST(${a}) OR 'collaboration_name=collaborations' IN UNNEST(${a}) THEN 'generic_only' WHEN ${core} THEN 'core' ELSE 'classification_absent' END`;
}
