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
  ), governed_evidence AS (
    SELECT source_ref,classification_type,classification_value,provenance,mapping_type
    FROM source_classifications
    GROUP BY source_ref,classification_type,classification_value,provenance,mapping_type
  ), classification_sets AS (SELECT source_ref,
      LOGICAL_OR(classification_type='product_type' AND classification_value='sunglasses') is_sunglasses,
      LOGICAL_OR(classification_type='product_category' AND classification_value IN (${jewellery})) is_jewellery,
      COUNT(*) governed_classifications,LOGICAL_OR(mapping_type='direct') has_direct_classification,
      LOGICAL_OR(mapping_type='approved_identity') has_identity_mapping,LOGICAL_OR(mapping_type='approved_reporting_family') has_reporting_family_mapping,
      ARRAY_AGG(STRUCT(classification_type,classification_value,provenance,mapping_type) ORDER BY classification_type,classification_value,provenance,mapping_type LIMIT 50) evidence
    FROM governed_evidence GROUP BY source_ref),
  woo_orders AS (
    SELECT 'ww' source_store,CAST(order_id AS STRING) order_ref,DATE(order_created_at) order_date,LOWER(status) status,total,ABS(COALESCE(total_refunds,0)) refunds FROM \`${project}.metorik_uk.orders\`
    UNION ALL SELECT 'usd',CAST(order_id AS STRING),DATE(order_created_at),LOWER(status),total,ABS(COALESCE(total_refunds,0)) FROM \`${project}.metorik_us.orders\`),
  woo_lines AS (
    SELECT 'woo' source_platform,'ww' source_store,CAST(order_id AS STRING) order_ref,CAST(product_id AS STRING) source_product_id,quantity units,total sales,UPPER(currency) currency,'major_unit' monetary_unit FROM \`${project}.metorik_uk.order_line_items\`
    UNION ALL SELECT 'woo','usd',CAST(order_id AS STRING),CAST(product_id AS STRING),quantity,total,UPPER(currency),'major_unit' FROM \`${project}.metorik_us.order_line_items\`),
  shopify_locations AS (SELECT * FROM \`${project}.shopify_data.order_locations\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY created_at DESC,retail_location_id DESC)=1),
  shopify_customers AS (SELECT * FROM \`${project}.shopify_data.order_customers\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY cancelled_at DESC,display_financial_status DESC)=1),
  shopify_financials AS (SELECT * FROM \`${project}.shopify_data.order_financials\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY original_total_presentment DESC,total_refunded_presentment DESC)=1),
  shopify_orders AS (SELECT l.order_id,DATE(l.created_at) order_date,IF(l.retail_location_id IS NULL,'Online','POS') sales_channel,LOWER(c.display_financial_status) status,c.cancelled_at,l.source_app_id,f.original_total_presentment order_total,COALESCE(f.total_refunded_presentment,0) refunds
    FROM shopify_locations l JOIN shopify_customers c USING(order_id) JOIN shopify_financials f USING(order_id)),
  shopify_lines AS (SELECT 'shopify' source_platform,'shopify' source_store,o.sales_channel,CAST(li.order_id AS STRING) order_ref,REGEXP_EXTRACT(CAST(li.product_id AS STRING),r'([^/]+)$') source_product_id,li.quantity units,li.discounted_total_presentment sales,UPPER(li.presentment_currency) currency,'major_unit' monetary_unit,o.order_date,o.status,o.cancelled_at,o.source_app_id,o.order_total,o.refunds
    FROM \`${project}.shopify_data.order_line_items\` li JOIN shopify_orders o ON CAST(o.order_id AS STRING)=CAST(li.order_id AS STRING)),
  square_returns AS (SELECT containing_order_id order_ref,source_line_item_uid line_item_uid,SUM(COALESCE(total_return_amount,0)) returned_amount FROM \`${project}.square_data.retail_returns\` GROUP BY 1,2),
  eligible_lines AS (
    SELECT l.source_platform,l.source_store,'Online' sales_channel,l.order_ref,l.source_product_id,l.units,l.sales,l.currency,l.monetary_unit,o.order_date FROM woo_lines l JOIN woo_orders o USING(source_store,order_ref) WHERE o.status IN ('completed','processing') AND COALESCE(o.total,0)>COALESCE(o.refunds,0)
    UNION ALL SELECT source_platform,source_store,sales_channel,order_ref,source_product_id,units,sales,currency,monetary_unit,order_date FROM shopify_lines WHERE status IN ('paid','partially_paid','partially_refunded') AND cancelled_at IS NULL AND (source_app_id IS NULL OR source_app_id!='gid://shopify/App/1758145') AND COALESCE(order_total,0)>COALESCE(refunds,0)
    UNION ALL SELECT 'square','square','Square',i.order_id,COALESCE(JSON_VALUE(SAFE.PARSE_JSON(i.transaction_line_item_json),'$.item_id'),i.catalog_object_id),i.quantity,COALESCE(i.total_amount,0)-COALESCE(r.returned_amount,0),UPPER(i.currency),'minor_unit',i.order_date FROM \`${project}.square_data.retail_order_items\` i LEFT JOIN square_returns r ON r.order_ref=i.order_id AND r.line_item_uid=i.line_item_uid),
  assigned AS (SELECT l.*,CONCAT(source_platform,':',source_store,':',source_product_id) source_product_ref,
    CASE WHEN c.is_sunglasses THEN 'sunglasses' WHEN c.is_jewellery THEN 'jewellery' WHEN COALESCE(c.governed_classifications,0)=0 THEN 'unclassified' ELSE 'other' END sales_category,
    COALESCE(c.governed_classifications,0) governed_classifications,COALESCE(c.has_direct_classification,FALSE) has_direct_classification,
    COALESCE(c.has_identity_mapping,FALSE) has_identity_mapping,COALESCE(c.has_reporting_family_mapping,FALSE) has_reporting_family_mapping,c.evidence
    FROM eligible_lines l LEFT JOIN classification_sets c ON c.source_ref=CONCAT(source_platform,':',source_store,':',source_product_id)
    WHERE order_date BETWEEN DATE(@start_date) AND DATE(@end_date)),
  totals AS (SELECT source_platform,source_store,sales_channel,currency,monetary_unit,COUNT(*) eligible_lines,SUM(units) eligible_units,SUM(sales) eligible_sales,
    COUNTIF(governed_classifications>0) classified_lines,COUNTIF(governed_classifications=0) unclassified_lines,SUM(IF(governed_classifications=0,sales,0)) unclassified_sales,
    COUNTIF(has_direct_classification) directly_classified_lines,COUNTIF(has_identity_mapping) identity_mapped_lines,COUNTIF(has_reporting_family_mapping) reporting_family_mapped_lines
    FROM assigned GROUP BY 1,2,3,4,5),
  categories AS (SELECT sales_category FROM UNNEST(['sunglasses','jewellery','other','unclassified']) sales_category),
  shopify_dimensions AS (SELECT DISTINCT source_platform,source_store,channel sales_channel,currency,monetary_unit FROM assigned CROSS JOIN UNNEST(['Online','POS']) channel WHERE source_platform='shopify'),
  other_dimensions AS (SELECT DISTINCT source_platform,source_store,sales_channel,currency,monetary_unit FROM assigned WHERE source_platform!='shopify'),
  dimensions AS (SELECT * FROM shopify_dimensions UNION ALL SELECT * FROM other_dimensions),
  buckets AS (SELECT source_platform,source_store,sales_channel,currency,monetary_unit,sales_category,COUNT(*) line_items,SUM(units) units,SUM(sales) sales FROM assigned GROUP BY 1,2,3,4,5,6),
  complete_buckets AS (SELECT d.*,c.sales_category,COALESCE(b.line_items,0) line_items,COALESCE(b.units,0) units,COALESCE(b.sales,0) sales
    FROM dimensions d CROSS JOIN categories c LEFT JOIN buckets b USING(source_platform,source_store,sales_channel,currency,monetary_unit,sales_category)),
  channel_totals AS (SELECT d.*,COALESCE(t.eligible_lines,0) eligible_lines,COALESCE(t.eligible_units,0) eligible_units,COALESCE(t.eligible_sales,0) eligible_sales,COALESCE(t.classified_lines,0) classified_lines,COALESCE(t.unclassified_lines,0) unclassified_lines,COALESCE(t.unclassified_sales,0) unclassified_sales,COALESCE(t.directly_classified_lines,0) directly_classified_lines,COALESCE(t.identity_mapped_lines,0) identity_mapped_lines,COALESCE(t.reporting_family_mapped_lines,0) reporting_family_mapped_lines FROM dimensions d LEFT JOIN totals t USING(source_platform,source_store,sales_channel,currency,monetary_unit)),
  combined_raw AS (SELECT source_platform,source_store,currency,monetary_unit,sales_category,COUNT(*) combined_line_items,SUM(units) combined_units,SUM(sales) combined_sales FROM assigned GROUP BY 1,2,3,4,5),
  combined_buckets AS (SELECT DISTINCT d.source_platform,d.source_store,d.currency,d.monetary_unit,c.sales_category,COALESCE(r.combined_line_items,0) combined_line_items,COALESCE(r.combined_units,0) combined_units,COALESCE(r.combined_sales,0) combined_sales FROM dimensions d CROSS JOIN categories c LEFT JOIN combined_raw r USING(source_platform,source_store,currency,monetary_unit,sales_category)),
  synced_order_dates AS (SELECT 'woo' source_platform,source_store,order_date FROM woo_orders UNION ALL SELECT 'shopify','shopify',order_date FROM shopify_orders UNION ALL SELECT 'square','square',MAX(order_date) FROM \`${project}.square_data.retail_order_items\`),
  source_coverage AS (SELECT source_platform,source_store,MAX(order_date) latest_synced_order_date FROM synced_order_dates GROUP BY 1,2)
  SELECT b.*,t.eligible_lines,t.eligible_units,t.eligible_sales,t.classified_lines,t.unclassified_lines,t.unclassified_sales,
    t.directly_classified_lines,t.identity_mapped_lines,t.reporting_family_mapped_lines,SAFE_DIVIDE(t.classified_lines,t.eligible_lines) classified_line_share,SAFE_DIVIDE(t.unclassified_sales,t.eligible_sales) unclassified_sales_share,SAFE_DIVIDE(b.sales,t.eligible_sales) sales_share,
    cb.combined_line_items,cb.combined_units,cb.combined_sales,DATE(@end_date) requested_end_date,sc.latest_synced_order_date
  FROM complete_buckets b JOIN channel_totals t USING(source_platform,source_store,sales_channel,currency,monetary_unit) JOIN combined_buckets cb USING(source_platform,source_store,currency,monetary_unit,sales_category) JOIN source_coverage sc USING(source_platform,source_store)
  ORDER BY currency,monetary_unit,source_platform,source_store,sales_channel,sales_category LIMIT 100`;
}

export function createCategorySalesService({bigquery,project}) {
  if(!bigquery?.query||!project)throw new Error('bigquery and project are required');
  return async input=>{const params=validateCategorySalesInput(input);const [rows]=await bigquery.query(categorySalesQueryOptions(project,params));assertCategorySalesReconciles(rows);return {period:{...params,latest_synced_order_dates:Object.fromEntries([...new Map(rows.map(r=>[`${r.source_platform}:${r.source_store}`,r.latest_synced_order_date])).entries()])},rows:JSON.parse(JSON.stringify(rows)),classification_contract:{sunglasses:'Active governed product_type=sunglasses, direct or inherited through an approved identity/reporting-family route.',jewellery:`Active governed product_category in ${JEWELLERY_CATEGORIES.join(', ')}, direct or inherited through an approved identity/reporting-family route.`,precedence:['sunglasses','jewellery','unclassified','other'],forbidden_inputs:['historical product title keywords','current tags alone','suggested or fuzzy mappings']},coverage:'Every source/currency/channel group includes sunglasses, jewellery, other and unclassified sales. For every Shopify currency/category, Online plus POS reconciles to the combined Shopify line, unit and sales totals.',money:{currencies_separate:true,major_unit_sources:['woo','shopify'],minor_unit_sources:['square'],fx_conversion:false},semantics:{eligibility:'Woo completed/processing; Shopify paid/partially paid/partially refunded, not cancelled, not Matrixify, and both exclude fully refunded orders.',refunds:'Woo and Shopify retain their established eligible-order and discounted-line contracts. Square subtracts persisted return-line amounts linked to the sold line.',channel:'Woo is Online; Shopify is split natively into Online and POS from retail location; Square remains a separate source and is never Shopify POS.'},contract:{read_only:true,aggregate_only:true,pii_free:true,maximum_rows:100}}};
}

export function categorySalesQueryOptions(project,input){return {query:categorySalesSql(project),params:validateCategorySalesInput(input),useLegacySql:false,maximumBytesBilled:String(CATEGORY_SALES_MAX_BYTES),labels:{component:'oracle',operation:'category_sales'}}}


const numeric=value=>Number(value?.value??value??0);
export function assertCategorySalesReconciles(rows){
  const groups=new Map();
  for(const row of rows){
    const key=[row.source_platform,row.source_store,row.sales_channel,row.currency,row.monetary_unit].join('\u0000');
    const group=groups.get(key)||{categories:new Set(),sales:0,total:numeric(row.eligible_sales)};
    if(group.categories.has(row.sales_category))throw new Error('category sales response repeats a governed bucket within a source/currency group');
    group.categories.add(row.sales_category);group.sales+=numeric(row.sales);
    if(Math.abs(group.total-numeric(row.eligible_sales))>.000001)throw new Error('category sales total changed within a source/currency group');
    groups.set(key,group);
  }
  const shopify=new Map();
  for(const row of rows)if(row.source_platform==='shopify'){
    const key=[row.source_store,row.currency,row.monetary_unit,row.sales_category].join('\u0000'),g=shopify.get(key)||{channels:new Set(),lines:0,units:0,sales:0,combinedLines:numeric(row.combined_line_items),combinedUnits:numeric(row.combined_units),combinedSales:numeric(row.combined_sales)};
    if(g.channels.has(row.sales_channel))throw new Error('Shopify category sales repeats a channel');g.channels.add(row.sales_channel);g.lines+=numeric(row.line_items);g.units+=numeric(row.units);g.sales+=numeric(row.sales);shopify.set(key,g);
  }
  for(const g of shopify.values()){if(!g.channels.has('Online')||!g.channels.has('POS'))throw new Error('Shopify category sales is missing Online or POS');for(const [actual,total,label] of [[g.lines,g.combinedLines,'lines'],[g.units,g.combinedUnits,'units'],[g.sales,g.combinedSales,'sales']])if(Math.abs(actual-total)>.000001*Math.max(1,Math.abs(total)))throw new Error(`Shopify Online + POS ${label} do not reconcile to combined total`);}
  for(const group of groups.values()){
    if(['sunglasses','jewellery','other','unclassified'].some(category=>!group.categories.has(category)))throw new Error('category sales response is missing a governed bucket');
    if(Math.abs(group.sales-group.total)>.000001*Math.max(1,Math.abs(group.total)))throw new Error('category sales buckets do not reconcile to eligible sales');
  }
  return true;
}

export const CATEGORY_SALES_TOOL_DEFINITION={type:'function',name:'get_governed_category_sales',strict:true,description:'Compare governed sunglasses, jewellery, other-classified and unclassified product-line sales with coverage by source-native currency. Shopify results are split into native Online and POS and reconciled to combined totals; Square remains separate. Return both the requested period and latest synced-order coverage. Use for category-sales questions and channel-split follow-ups; never use customer cohorts/order sequences or infer categories from titles/current tags.',parameters:{type:'object',additionalProperties:false,properties:{start_date:{type:'string',description:'Inclusive requested YYYY-MM-DD date.'},end_date:{type:'string',description:'Inclusive requested YYYY-MM-DD date; results separately disclose the latest synced order date.'}},required:['start_date','end_date']}};

export async function executeCategorySalesToolCall(service,name,args){if(name!==CATEGORY_SALES_TOOL_DEFINITION.name)return {handled:false,result:null};return {handled:true,result:await service(args)}}
