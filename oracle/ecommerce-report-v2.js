import { reportPeriod } from './report-period.js';
import { sourceProductRef } from './product-identity.js';
import { governedDecisionCtes, productFamilyCtes } from './product-mapping.js';
import { createCanonicalFinanceService, MATRIXIFY_APP_ID } from '../finance/canonical.js';
export { buildCanonicalProductGraph, consolidateSourceProducts, mapProductPair, normalizeRingSize, rowsAtGrain, selectBaseTitle, sourceProductRef } from './product-identity.js';

export const REPORT_SECTIONS = Object.freeze(['overview','sales','customers','products','geography','acquisition','organic','context']);
export { MATRIXIFY_APP_ID } from '../finance/canonical.js';
export const REPORT_DEFINITIONS = Object.freeze({
  net_gross:'Canonical finance gross sales less accounting refunds, within one currency.',
  orders:'Canonical finance sale transaction count; not a GA4 transaction count.',
  product_sales:'Persisted source-native line-item sales; operational evidence, not canonical finance.',
  conversion:'GA4 behavioural conversion; not a finance metric.',
  first_observed:'First qualifying purchase visible in that governed source history, never first-ever.',
  product_ref:'Canonical product graph over stable source products: governed mapping, then pairwise exact unique non-empty SKU, then pairwise exact unique conservatively-normalized base product title; variants/options remain children.',
  geography:'Direct shipping country only. Missing country remains unresolved and is never treated as domestic.'
});
const DAY=86400000;
const shift=(date,days)=>new Date(new Date(`${date}T00:00:00Z`).getTime()+days*DAY).toISOString().slice(0,10);
const state=(rows,coverage=null)=>({status:rows.length?'available':'unavailable',available:rows.length>0,coverage});
export function periodAvailability(a,b,{currentCoverage=null,comparisonCoverage=null,semanticMismatch=false,partial=false,sourceSpecific=false}={}){
  const current=state(a,currentCoverage),comparison=state(b,comparisonCoverage);
  const comparability=current.available&&comparison.available?(sourceSpecific?'source-specific':partial?'partially_comparable':semanticMismatch?'not_directly_comparable':'comparable'):'comparison_unavailable';
  return {current,comparison,comparability};
}
export function normalizeProductTitle(value){
  return String(value??'').normalize('NFKC').replace(/&(?:apos|#0*39);/gi,"'").replace(/&(?:ndash|mdash|#0*8211|#0*8212);/gi,'-').replace(/[\u2018\u2019\u02BC]/g,"'").replace(/[\u2010-\u2015\u2212]/g,'-').toLocaleLowerCase('en').trim().replace(/\s+/g,' ');
}
export function productRef(row,{governedRef=null,skuUnique=true,titleUnique=true,titleMatched=false}={}){
  const fallback={product_ref:`source:${sourceProductRef(row)}`,mapping_method:'source_identity_only',mapping_status:'source_specific',resolved:false};
  if(governedRef)return{product_ref:`governed:${governedRef}`,mapping_method:'explicit_governed_mapping',mapping_status:'resolved',resolved:true};
  const sku=String(row.sku||'').trim().toUpperCase();
  if(sku&&skuUnique)return{product_ref:`sku:${sku}`,mapping_method:'exact_unique_sku',mapping_status:'resolved',resolved:true};
  const title=normalizeProductTitle(row.title);
  if(title&&titleMatched&&titleUnique)return{product_ref:`title:${title}`,mapping_method:'exact_unique_normalized_title',mapping_status:'resolved',resolved:true};
  if((sku&&!skuUnique)||(title&&titleMatched&&!titleUnique))return{...fallback,mapping_status:'ambiguous'};
  return fallback;
}

export function createEcommerceReportV2({bigquery,project,knowledgeService}){
  const query=async(sql,params)=>(await bigquery.query({query:sql,params,maximumBytesBilled:'5000000000',useLegacySql:false}))[0];
  const canonicalFinance=createCanonicalFinanceService({bigquery,project});
  const finance=async p=>{
    const rows=await canonicalFinance({...p,grain:'day',dimensions:['currency','channel','source','transaction_type']});
    if(rows.length&&rows.every(r=>r.transaction_type==null))return rows;
    const out=new Map();
    for(const r of rows){const k=[r.period,r.currency,r.channel,r.source].join('|'),x=out.get(k)||{date:r.period,currency:r.currency,channel:r.channel,source:r.source,gross_sales:0,refunds:0,net_gross:0,orders:0};const amount=Number(r.amount||0);x.net_gross+=amount;if(r.transaction_type==='sale'){x.gross_sales+=amount;x.orders+=Number(r.transaction_count||0);}else if(r.transaction_type==='refund')x.refunds+=amount;out.set(k,x);}return [...out.values()];
  };
  const ga4=p=>query(`WITH evidence AS (
    SELECT date,'channel' dimension_type,COALESCE(session_default_channel_group,'Unassigned') dimension,
      session_source source,session_medium medium,sessions,total_users,engaged_sessions
    FROM \`${project}.ga4.acquisition\` WHERE date BETWEEN @start_date AND @end_date
    UNION ALL
    SELECT date,'device',COALESCE(device_category,'unknown'),CAST(NULL AS STRING),CAST(NULL AS STRING),sessions,total_users,engaged_sessions
    FROM \`${project}.ga4.device_geo\` WHERE date BETWEEN @start_date AND @end_date)
    SELECT FORMAT_DATE('%Y-%m-%d',date) date,dimension_type,dimension,source,medium,
      SUM(sessions) sessions,SUM(total_users) total_users,SUM(engaged_sessions) engaged_sessions,
      SAFE_DIVIDE(SUM(engaged_sessions),SUM(sessions)) engagement_rate
    FROM evidence GROUP BY date,dimension_type,dimension,source,medium ORDER BY date,dimension_type,dimension`,p);
  const searchConsole=p=>query(`SELECT FORMAT_DATE('%Y-%m-%d',date) date,clicks,impressions,
    SAFE_DIVIDE(clicks,impressions) ctr,position,selected_source_property,selected_property_scope,selection_reason
    FROM \`${project}.search_console.canonical_daily\`
    WHERE date BETWEEN @start_date AND @end_date AND coverage_status='available' ORDER BY date`,p);
  const customers=p=>query(`WITH orders AS (
    SELECT 'woo' source_platform,'ww' source_store,CAST(order_id AS STRING) order_id,DATE(order_created_at) order_date,CAST(customer_id AS STRING) customer_id,FALSE migrated FROM \`${project}.metorik_uk.orders\` WHERE LOWER(status) IN ('completed','processing') AND total>0
    UNION ALL SELECT 'woo','usd',CAST(order_id AS STRING),DATE(order_created_at),CAST(customer_id AS STRING),FALSE FROM \`${project}.metorik_us.orders\` WHERE LOWER(status) IN ('completed','processing') AND total>0
    UNION ALL SELECT 'shopify','shopify',l.order_id,DATE(l.created_at),c.customer_id,l.source_app_id=@matrixify_app_id FROM \`${project}.shopify_data.order_locations\` l JOIN \`${project}.shopify_data.order_customers\` c USING(order_id) JOIN \`${project}.shopify_data.order_financials\` f USING(order_id) WHERE LOWER(c.display_financial_status) IN ('paid','partially_paid','partially_refunded') AND f.original_total_presentment>0
  ), qualified AS (SELECT *,IF(NULLIF(customer_id,'') IS NULL,NULL,CONCAT(source_platform,':',source_store,':',customer_id)) customer_ref FROM orders WHERE NOT migrated), history AS (
    SELECT *,MIN(order_date) OVER(PARTITION BY customer_ref) first_observed_date FROM qualified
  ), period AS (SELECT * FROM history WHERE order_date BETWEEN DATE(@start_date) AND DATE(@end_date)), by_customer AS (
    SELECT source_platform,source_store,customer_ref,MIN(first_observed_date) first_observed_date,COUNT(DISTINCT order_id) period_orders FROM period WHERE customer_ref IS NOT NULL GROUP BY 1,2,3)
  SELECT p.source_platform,p.source_store,COUNT(DISTINCT p.order_id) qualifying_orders,COUNTIF(p.customer_ref IS NULL) guest_unresolved_orders,
    COUNT(DISTINCT p.customer_ref) identified_customers,COUNT(DISTINCT IF(b.first_observed_date>=DATE(@start_date),p.customer_ref,NULL)) first_observed_customers,
    COUNT(DISTINCT IF(b.first_observed_date<DATE(@start_date),p.customer_ref,NULL)) returning_customers,COUNT(DISTINCT IF(b.period_orders>=2,p.customer_ref,NULL)) repeat_within_period_customers,
    SAFE_DIVIDE(COUNT(DISTINCT IF(p.customer_ref IS NOT NULL,p.order_id,NULL)),COUNT(DISTINCT p.customer_ref)) orders_per_identified_customer,
    SAFE_DIVIDE(COUNT(DISTINCT IF(b.first_observed_date<DATE(@start_date),p.customer_ref,NULL)),COUNT(DISTINCT p.customer_ref)) returning_share,
    SAFE_DIVIDE(COUNTIF(p.customer_ref IS NULL),COUNT(DISTINCT p.order_id)) guest_unresolved_share
  FROM period p LEFT JOIN by_customer b USING(source_platform,source_store,customer_ref) GROUP BY 1,2 ORDER BY 1,2`,{...p,matrixify_app_id:MATRIXIFY_APP_ID});
  const products=p=>query(`WITH lines AS (
    SELECT 'woo_ww' source_namespace,'woo' source_platform,'ww' source_store,'Online' channel,DATE(o.order_created_at) date,CAST(li.product_id AS STRING) source_product_id,CAST(li.variation_id AS STRING) source_variant_id,CAST(NULL AS STRING) variant_title,li.sku,li.name line_title,li.quantity units,li.total product_sales,li.currency FROM \`${project}.metorik_uk.order_line_items\` li JOIN \`${project}.metorik_uk.orders\` o USING(order_id)
    UNION ALL SELECT 'woo_usd','woo','usd','Online',DATE(o.order_created_at),CAST(li.product_id AS STRING),CAST(li.variation_id AS STRING),NULL,li.sku,li.name,li.quantity,li.total,li.currency FROM \`${project}.metorik_us.order_line_items\` li JOIN \`${project}.metorik_us.orders\` o USING(order_id)
    UNION ALL SELECT 'shopify','shopify','shopify',IF(l.retail_location_id IS NULL,'Online','In-store'),DATE(li.order_created_at),li.product_id,li.variant_id,li.variant_title,li.sku,COALESCE(li.title,li.name),li.quantity,li.discounted_total_presentment,li.presentment_currency FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) WHERE l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id
    UNION ALL SELECT 'square','square','square','In-store',order_date,COALESCE(JSON_VALUE(SAFE.PARSE_JSON(transaction_line_item_json),'$.item_id'),catalog_object_id),COALESCE(catalog_variation_id,catalog_object_id),transaction_variation_name,transaction_sku,transaction_item_name,quantity,total_amount,currency FROM \`${project}.square_data.retail_order_items\`
  ), titled AS (SELECT *,COUNT(*) OVER(PARTITION BY source_namespace,source_product_id,line_title) title_frequency,MAX(date) OVER(PARTITION BY source_namespace,source_product_id,line_title) title_latest FROM lines), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY source_namespace,source_product_id ORDER BY title_frequency DESC,title_latest DESC,line_title) title_rank FROM titled
  ), raw_products AS (SELECT source_namespace,source_platform,source_store,source_product_id,
    ARRAY_AGG(line_title IGNORE NULLS ORDER BY title_rank LIMIT 1)[SAFE_OFFSET(0)] base_title,
    ARRAY_AGG(NULLIF(UPPER(TRIM(sku)),'') IGNORE NULLS ORDER BY date DESC LIMIT 1)[SAFE_OFFSET(0)] normalized_sku
    FROM ranked GROUP BY 1,2,3,4
  ), base_products AS (SELECT *,LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NORMALIZE(base_title,NFKC),r'[‘’ʼ]',"'"),r'[‐‑‒–—―−]','-'),r'\s+',' '))) normalized_base_title FROM raw_products
  ), ${governedDecisionCtes(project)}, ${productFamilyCtes(project)}, governed AS (SELECT left_ref,right_ref FROM governed_active), pairs AS (SELECT 'woo_ww' left_ns,'shopify' right_ns UNION ALL SELECT 'woo_usd','shopify' UNION ALL SELECT 'woo_ww','woo_usd' UNION ALL SELECT 'square','shopify'), candidates AS (
    SELECT l.source_namespace left_ns,l.source_product_id left_id,r.source_namespace right_ns,r.source_product_id right_id,
      CASE WHEN l.normalized_sku IS NOT NULL AND l.normalized_sku=r.normalized_sku THEN 'exact_unique_sku' WHEN l.normalized_base_title IS NOT NULL AND l.normalized_base_title=r.normalized_base_title THEN 'exact_unique_normalized_base_title' END mapping_method
    FROM pairs p JOIN base_products l ON l.source_namespace=p.left_ns JOIN base_products r ON r.source_namespace=p.right_ns
    WHERE (l.normalized_sku IS NOT NULL AND l.normalized_sku=r.normalized_sku) OR (l.normalized_base_title IS NOT NULL AND l.normalized_base_title=r.normalized_base_title)
    UNION ALL SELECT l.source_namespace,l.source_product_id,r.source_namespace,r.source_product_id,'explicit_governed_mapping' FROM governed g JOIN base_products l ON CONCAT(l.source_platform,':',l.source_store,':',l.source_product_id)=g.left_ref JOIN base_products r ON CONCAT(r.source_platform,':',r.source_store,':',r.source_product_id)=g.right_ref
  ), unique_edges AS (SELECT * FROM candidates QUALIFY (mapping_method='explicit_governed_mapping' OR (COUNT(*) OVER(PARTITION BY left_ns,left_id,mapping_method)=1 AND COUNT(*) OVER(PARTITION BY right_ns,right_id,mapping_method)=1)) AND ROW_NUMBER() OVER(PARTITION BY left_ns,left_id,right_ns,right_id ORDER BY CASE mapping_method WHEN 'explicit_governed_mapping' THEN 0 WHEN 'exact_unique_sku' THEN 1 ELSE 2 END)=1), refs AS (
    SELECT source_namespace,source_product_id,MIN(peer_ref) canonical_product_ref,ARRAY_AGG(mapping_method ORDER BY CASE mapping_method WHEN 'explicit_governed_mapping' THEN 0 WHEN 'exact_unique_sku' THEN 1 ELSE 2 END LIMIT 1)[OFFSET(0)] mapping_method FROM (
      SELECT left_ns source_namespace,left_id source_product_id,CONCAT(right_ns,':',right_id) peer_ref,mapping_method FROM unique_edges UNION ALL SELECT right_ns,right_id,CONCAT(left_ns,':',left_id),mapping_method FROM unique_edges) GROUP BY 1,2
  ), family_members AS (SELECT source_ref,shopify_parent_ref,shopify_parent_title FROM family_active UNION ALL SELECT shopify_parent_ref source_ref,shopify_parent_ref,ANY_VALUE(shopify_parent_title) shopify_parent_title FROM family_active GROUP BY shopify_parent_ref), classified AS (SELECT l.*,p.base_title,p.normalized_base_title,COALESCE(CONCAT('family:',f.shopify_parent_ref),CONCAT('canonical:',r.canonical_product_ref),CONCAT('source:',l.source_namespace,':',COALESCE(l.source_product_id,'unknown'))) product_ref,IF(f.shopify_parent_ref IS NOT NULL,'governed_product_family',COALESCE(r.mapping_method,'source_identity_only')) mapping_method,IF(f.shopify_parent_ref IS NOT NULL,'family_resolved',IF(r.canonical_product_ref IS NULL,'source_specific','resolved')) mapping_status,f.shopify_parent_title family_title FROM lines l JOIN base_products p USING(source_namespace,source_platform,source_store,source_product_id) LEFT JOIN refs r USING(source_namespace,source_product_id) LEFT JOIN family_members f ON f.source_ref=CONCAT(l.source_platform,':',l.source_store,':',l.source_product_id))
  SELECT product_ref,COALESCE(ANY_VALUE(family_title),ANY_VALUE(base_title)) canonical_title,ANY_VALUE(line_title) source_title,ANY_VALUE(normalized_base_title) normalized_title,ANY_VALUE(sku) source_sku,mapping_method,mapping_status,source_platform,source_store,channel,currency,source_product_id,ARRAY_AGG(DISTINCT source_variant_id IGNORE NULLS LIMIT 100) source_variant_ids,COUNT(DISTINCT source_variant_id) variant_count,SUM(units) units,SUM(product_sales) product_sales,COUNT(*) line_items,'stable_source_product_with_child_variants' provenance,'product' report_grain
  FROM classified WHERE date BETWEEN DATE(@start_date) AND DATE(@end_date) GROUP BY product_ref,mapping_method,mapping_status,source_platform,source_store,channel,currency,source_product_id ORDER BY units DESC,product_sales DESC LIMIT 100`,{...p,matrixify_app_id:MATRIXIFY_APP_ID});
  const geography=p=>query(`WITH orders AS (
    SELECT 'woo' source_platform,'ww' source_store,'Online' channel,DATE(o.order_created_at) date,UPPER(g.shipping_country_iso2) shipping_country,o.currency,o.total sales FROM \`${project}.metorik_uk.orders\` o LEFT JOIN \`${project}.commerce.order_geography\` g ON g.source_store='ww' AND g.source_order_id=CAST(o.order_id AS STRING)
    UNION ALL SELECT 'woo','usd','Online',DATE(o.order_created_at),UPPER(g.shipping_country_iso2),o.currency,o.total FROM \`${project}.metorik_us.orders\` o LEFT JOIN \`${project}.commerce.order_geography\` g ON g.source_store='usd' AND g.source_order_id=CAST(o.order_id AS STRING))
    SELECT source_platform,source_store,channel,COALESCE(shipping_country,'Unresolved') shipping_country,currency,COUNT(*) orders,SUM(IF(shipping_country IS NULL,NULL,sales)) sales,
    SAFE_DIVIDE(COUNTIF(shipping_country IS NOT NULL),SUM(COUNT(*)) OVER(PARTITION BY source_platform,source_store)) observed_coverage,
    SAFE_DIVIDE(COUNT(*),SUM(COUNT(*)) OVER(PARTITION BY source_platform,source_store)) country_share
    FROM orders WHERE date BETWEEN DATE(@start_date) AND DATE(@end_date) GROUP BY 1,2,3,4,5 ORDER BY orders DESC`,p);
  const aggregate=rows=>[...rows.reduce((m,r)=>{const k=r.currency,x=m.get(k)||{currency:k,net_gross:0,gross_sales:0,refunds:0,orders:0};for(const f of ['net_gross','gross_sales','refunds','orders'])x[f]+=Number(r[f]||0);m.set(k,x);return m;},new Map()).values()];
  const contextFor=async p=>{const requested={start_date:shift(p.start_date,-14),end_date:p.end_date,topics:[]};const result=knowledgeService.getBusinessContext?await knowledgeService.getBusinessContext(requested):await knowledgeService.searchKnowledge({text:null,knowledge_type:null,start_date:requested.start_date,end_date:requested.end_date,status:'confirmed',tags:[],limit:20});return(result.items||[]).filter(x=>!['rejected','superseded'].includes(x.status)).map(x=>({...x,temporal_relation:x.effective_to&&x.effective_to<p.start_date?'nearby_before_period':'overlaps_period'}));};
  return async function load(section,raw={}){
    if(!REPORT_SECTIONS.includes(section))throw new Error('Unknown report section');
    const periods=reportPeriod(raw),base={section,generated_at:new Date().toISOString(),period:periods.current,comparison:periods.comparison,comparison_type:periods.comparison.mode,definitions:REPORT_DEFINITIONS};
    if(section==='overview'||section==='sales'){const [current,comparison]=await Promise.all([finance(periods.current),finance(periods.comparison)]),totals=aggregate(current),prior=new Map(aggregate(comparison).map(x=>[x.currency,x]));return{...base,status:current.length?'available':'unavailable',currencies:totals.map(x=>x.currency),kpis:totals.flatMap(r=>['net_gross','orders','refunds'].map(metric=>({metric,label:{net_gross:'Net sales',orders:'Transactions',refunds:'Refunds'}[metric],currency:metric==='orders'?null:r.currency,value:r[metric],comparison_value:prior.get(r.currency)?.[metric]??null}))),chart:{title:'Sales trend',metric:'net_gross',series:'currency',unit:'currency'},trend:current,rows:current,evidence_availability:{finance:periodAvailability(current,comparison)},limitations:['Canonical finance is authoritative. Shopify market currency is represented by presentment currency upstream; shop currency must not force USD orders into GBP.','Currencies are reported separately and never converted.']};}
    if(section==='context'){const [a,b]=await Promise.all([contextFor(periods.current),contextFor(periods.comparison)]);return{...base,status:a.length||b.length?'available':'unavailable',rows:a,context:{current:a,comparison:b},kpis:[],trend:[],evidence_availability:{knowledge:periodAvailability(a,b)},limitations:['Each period has an independent 14-day look-behind.']};}
    const config={organic:[searchConsole,{title:'Organic clicks',metric:'clicks',series:'selected_source_property',unit:'count'},'search_console'],acquisition:[ga4,{title:'Sessions trend',metric:'sessions',series:'dimension',unit:'count'},'ga4'],customers:[customers,{title:'Identified purchasing customers',metric:'identified_customers',series:'source_store',unit:'count'},'customers'],products:[products,{title:'Top products by units',metric:'units',series:'channel',unit:'count'},'products'],geography:[geography,{title:'Orders by shipping country',metric:'orders',series:'shipping_country',unit:'count'},'geography']}[section];
    const [loader,chart,key]=config,[current,comparison]=await Promise.all([loader(periods.current),loader(periods.comparison)]),partial=['products','geography'].includes(section),availability=periodAvailability(current,comparison,{partial,sourceSpecific:section==='products'});
    const limitations={organic:['Governed Search Console coverage begins 6 May 2025, so November 2024 organic-search evidence is unavailable. November 2025 evidence remains available for current-period analysis. Canonical daily evidence selects Domain first and historical www only as fallback; properties are never summed.'],acquisition:['GA4 is behavioural evidence; GA4 revenue is not canonical finance.'],customers:['Behavioural metrics share one definition by source namespace; no Woo-to-Shopify person identity resolution is attempted. Guests are excluded from customer denominators and Matrixify orders from Shopify history.'],products:['Governed reporting-family membership groups source products under one Shopify parent without changing canonical identity. Otherwise identity precedence is explicit governed mapping, exact unique non-empty SKU, exact unique conservatively-normalized product title, then source-specific unresolved. Each source line contributes once; source product IDs and variants remain visible, unresolved products remain separate, and product sales are source-native with currencies separate.'],geography:['This Report v2 section currently returns Woo direct-shipping rows. For Shopify Online top-country and within-country product analysis use get_shopify_online_country_products, backed by direct order_shipping_geography; missing or invalid country remains unknown and is never inferred from billing, currency, market, location or IP.']}[section];
    const kpis=current.length?Object.entries(current.reduce((a,r)=>{for(const m of section==='customers'?['identified_customers','first_observed_customers','returning_customers','repeat_within_period_customers','guest_unresolved_orders']:[] )a[m]=(a[m]||0)+Number(r[m]||0);return a;},{})).map(([metric,value])=>({metric,label:metric.replaceAll('_',' '),value,comparison_value:null})):[];
    return{...base,status:current.length||comparison.length?'available':'unavailable',rows:current,comparison_rows:comparison,kpis,trend:current,chart,currencies:[...new Set(current.map(x=>x.currency).filter(Boolean))],evidence_availability:{[key]:availability},limitations};
  };
}
