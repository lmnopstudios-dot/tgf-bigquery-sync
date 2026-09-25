import { governedDecisionCtes, PRODUCT_FAMILY_TABLE } from './product-mapping.js';

export const CATEGORY_SALES_MAX_BYTES = 20_000_000_000;
export const JEWELLERY_CATEGORIES = Object.freeze(['ring','pendant','necklace','bracelet','chain','earrings']);
const DATE=/^\d{4}-\d{2}-\d{2}$/;

export function validateCategorySalesInput(input={}) {
  const {start_date,end_date}=input;
  for(const [key,value] of Object.entries({start_date,end_date})) if(typeof value!=='string'||!DATE.test(value)||new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)!==value) throw new Error(`${key} must be a valid YYYY-MM-DD date`);
  if(start_date>end_date)throw new Error('start_date must be on or before end_date');
  return {start_date,end_date};
}

/**
 * Category assignment is deliberately based only on active classifications.
 * An approved identity edge or reporting-family membership may route a
 * historical source product to a classified Shopify parent. Titles, SKUs and
 * current tags are never classification inputs.
 */
export function categorySalesSql(project) {
  const jewellery=JEWELLERY_CATEGORIES.map(x=>`'${x}'`).join(',');
  return `WITH ${governedDecisionCtes(project,'identity')},
  family_history AS (SELECT *,COALESCE(decision_id,event_id) resolved_decision_id FROM \`${project}.commerce.${PRODUCT_FAMILY_TABLE}\`),
  family_superseded AS (SELECT supersedes_decision_id decision_id FROM family_history WHERE supersedes_decision_id IS NOT NULL),
  family_current AS (SELECT h.*,ROW_NUMBER() OVER(PARTITION BY membership_id ORDER BY reviewed_at DESC,resolved_decision_id DESC) decision_rank FROM family_history h LEFT JOIN family_superseded s ON s.decision_id=h.resolved_decision_id WHERE s.decision_id IS NULL),
  family_active AS (SELECT source_ref,shopify_parent_ref FROM family_current WHERE decision_rank=1 AND status='active'),
  identity_routes AS (SELECT left_ref source_ref,right_ref classification_ref FROM identity_active UNION ALL SELECT right_ref,left_ref FROM identity_active),
  routes AS (SELECT source_ref,classification_ref,'approved_identity' mapping_type FROM identity_routes UNION ALL SELECT source_ref,shopify_parent_ref,'approved_reporting_family' FROM family_active),
  active_classifications AS (SELECT subject_ref,classification_type,classification_value,provenance FROM \`${project}.commerce.product_classifications\` WHERE status='active'),
  source_classifications AS (
    SELECT subject_ref source_ref,classification_type,classification_value,provenance,'direct' mapping_type FROM active_classifications
    UNION ALL SELECT r.source_ref,c.classification_type,c.classification_value,c.provenance,r.mapping_type FROM routes r JOIN active_classifications c ON c.subject_ref=r.classification_ref
  ), classification_sets AS (SELECT source_ref,
      LOGICAL_OR(classification_type='product_type' AND classification_value='sunglasses') is_sunglasses,
      LOGICAL_OR(classification_type='product_category' AND classification_value IN (${jewellery})) is_jewellery,
      COUNT(*) governed_classifications,LOGICAL_OR(mapping_type='direct') has_direct_classification,
      LOGICAL_OR(mapping_type='approved_identity') has_identity_mapping,LOGICAL_OR(mapping_type='approved_reporting_family') has_reporting_family_mapping,
      ARRAY_AGG(DISTINCT STRUCT(classification_type,classification_value,provenance,mapping_type) ORDER BY classification_type,classification_value LIMIT 50) evidence
    FROM source_classifications GROUP BY source_ref),
  woo_orders AS (
    SELECT 'ww' source_store,CAST(order_id AS STRING) order_ref,DATE(order_created_at) order_date,LOWER(status) status,total,ABS(COALESCE(total_refunds,0)) refunds FROM \`${project}.metorik_uk.orders\`
    UNION ALL SELECT 'usd',CAST(order_id AS STRING),DATE(order_created_at),LOWER(status),total,ABS(COALESCE(total_refunds,0)) FROM \`${project}.metorik_us.orders\`),
  woo_lines AS (
    SELECT 'woo' source_platform,'ww' source_store,CAST(order_id AS STRING) order_ref,CAST(product_id AS STRING) source_product_id,quantity units,total sales,UPPER(currency) currency,'major_unit' monetary_unit FROM \`${project}.metorik_uk.order_line_items\`
    UNION ALL SELECT 'woo','usd',CAST(order_id AS STRING),CAST(product_id AS STRING),quantity,total,UPPER(currency),'major_unit' FROM \`${project}.metorik_us.order_line_items\`),
  shopify_lines AS (SELECT 'shopify' source_platform,'shopify' source_store,li.order_id order_ref,REGEXP_EXTRACT(CAST(li.product_id AS STRING),r'([^/]+)$') source_product_id,li.quantity units,li.discounted_total_presentment sales,UPPER(li.presentment_currency) currency,'major_unit' monetary_unit,DATE(l.created_at) order_date,LOWER(c.display_financial_status) status,c.cancelled_at,l.source_app_id,f.original_total_presentment order_total,COALESCE(f.total_refunded_presentment,0) refunds
    FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) JOIN \`${project}.shopify_data.order_customers\` c USING(order_id) JOIN \`${project}.shopify_data.order_financials\` f USING(order_id)),
  square_returns AS (SELECT containing_order_id order_ref,source_line_item_uid line_item_uid,SUM(COALESCE(total_amount,0)) returned_amount FROM \`${project}.square_data.retail_returns\` GROUP BY 1,2),
  eligible_lines AS (
    SELECT l.*,o.order_date FROM woo_lines l JOIN woo_orders o USING(source_store,order_ref) WHERE o.status IN ('completed','processing') AND COALESCE(o.total,0)>COALESCE(o.refunds,0)
    UNION ALL SELECT source_platform,source_store,order_ref,source_product_id,units,sales,currency,monetary_unit,order_date FROM shopify_lines WHERE status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND (source_app_id IS NULL OR source_app_id!='gid://shopify/App/1758145') AND COALESCE(order_total,0)>COALESCE(refunds,0)
    UNION ALL SELECT 'square','square',i.order_id,COALESCE(JSON_VALUE(SAFE.PARSE_JSON(i.transaction_line_item_json),'$.item_id'),i.catalog_object_id),i.quantity,COALESCE(i.total_amount,0)-COALESCE(r.returned_amount,0),UPPER(i.currency),'minor_unit',i.order_date FROM \`${project}.square_data.retail_order_items\` i LEFT JOIN square_returns r ON r.order_ref=i.order_id AND r.line_item_uid=i.line_item_uid),
  assigned AS (SELECT l.*,CONCAT(source_platform,':',source_store,':',source_product_id) source_product_ref,
    CASE WHEN c.is_sunglasses THEN 'sunglasses' WHEN c.is_jewellery THEN 'jewellery' WHEN COALESCE(c.governed_classifications,0)=0 THEN 'unclassified' ELSE 'other' END sales_category,
    COALESCE(c.governed_classifications,0) governed_classifications,COALESCE(c.has_direct_classification,FALSE) has_direct_classification,
    COALESCE(c.has_identity_mapping,FALSE) has_identity_mapping,COALESCE(c.has_reporting_family_mapping,FALSE) has_reporting_family_mapping,c.evidence
    FROM eligible_lines l LEFT JOIN classification_sets c ON c.source_ref=CONCAT(source_platform,':',source_store,':',source_product_id)
    WHERE order_date BETWEEN DATE(@start_date) AND DATE(@end_date)),
  totals AS (SELECT source_platform,source_store,currency,monetary_unit,COUNT(*) eligible_lines,SUM(units) eligible_units,SUM(sales) eligible_sales,
    COUNTIF(governed_classifications>0) classified_lines,COUNTIF(governed_classifications=0) unclassified_lines,SUM(IF(governed_classifications=0,sales,0)) unclassified_sales,
    COUNTIF(has_direct_classification) directly_classified_lines,COUNTIF(has_identity_mapping) identity_mapped_lines,COUNTIF(has_reporting_family_mapping) reporting_family_mapped_lines
    FROM assigned GROUP BY 1,2,3,4),
  buckets AS (SELECT source_platform,source_store,currency,monetary_unit,sales_category,COUNT(*) line_items,SUM(units) units,SUM(sales) sales FROM assigned GROUP BY 1,2,3,4,5)
  SELECT b.*,t.eligible_lines,t.eligible_units,t.eligible_sales,t.classified_lines,t.unclassified_lines,t.unclassified_sales,
    t.directly_classified_lines,t.identity_mapped_lines,t.reporting_family_mapped_lines,SAFE_DIVIDE(t.classified_lines,t.eligible_lines) classified_line_share,SAFE_DIVIDE(t.unclassified_sales,t.eligible_sales) unclassified_sales_share,SAFE_DIVIDE(b.sales,t.eligible_sales) sales_share
  FROM buckets b JOIN totals t USING(source_platform,source_store,currency,monetary_unit)
  ORDER BY currency,monetary_unit,source_platform,source_store,sales_category LIMIT 100`;
}

export function createCategorySalesService({bigquery,project}) {
  if(!bigquery?.query||!project)throw new Error('bigquery and project are required');
  return async input=>{const params=validateCategorySalesInput(input);const [rows]=await bigquery.query({query:categorySalesSql(project),params,useLegacySql:false,maximumBytesBilled:String(CATEGORY_SALES_MAX_BYTES),labels:{component:'oracle',operation:'category_sales'}});return {period:params,rows:JSON.parse(JSON.stringify(rows)),classification_contract:{sunglasses:'Active governed product_type=sunglasses, direct or inherited through an approved identity/reporting-family route.',jewellery:`Active governed product_category in ${JEWELLERY_CATEGORIES.join(', ')}, direct or inherited through an approved identity/reporting-family route.`,precedence:['sunglasses','jewellery','unclassified','other'],forbidden_inputs:['historical product title keywords','current tags alone','suggested or fuzzy mappings']},coverage:'Every source/currency row includes eligible sales and category share; unclassified is returned rather than discarded.',money:{currencies_separate:true,major_unit_sources:['woo','shopify'],minor_unit_sources:['square'],fx_conversion:false},semantics:{eligibility:'Woo completed/processing; Shopify paid/partially paid/partially refunded, not cancelled, not Matrixify, and both exclude fully refunded orders.',refunds:'Woo and Shopify retain their established eligible-order and discounted-line contracts. Square subtracts persisted return-line amounts linked to the sold line.',channel:'Woo is Online; Shopify includes native Online and POS; Square is In-store.'},contract:{read_only:true,aggregate_only:true,pii_free:true,maximum_rows:100}}};
}

export const CATEGORY_SALES_TOOL_DEFINITION={type:'function',name:'get_governed_category_sales',strict:true,description:'Compare governed sunglasses, jewellery, other-classified and unclassified product-line sales with coverage by source and currency. Use for category sales questions, including partial historical classification coverage. Never use customer cohorts/order sequences or infer categories from titles/current tags.',parameters:{type:'object',additionalProperties:false,properties:{start_date:{type:'string',description:'Inclusive YYYY-MM-DD date.'},end_date:{type:'string',description:'Inclusive YYYY-MM-DD date.'}},required:['start_date','end_date']}};

export async function executeCategorySalesToolCall(service,name,args){if(name!==CATEGORY_SALES_TOOL_DEFINITION.name)return {handled:false,result:null};return {handled:true,result:await service(args)}}
