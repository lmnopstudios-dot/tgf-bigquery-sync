import { reportPeriod } from './report-period.js';

export const REPORT_SECTIONS = Object.freeze(['overview','sales','customers','products','geography','acquisition','organic','context']);
export const MATRIXIFY_APP_ID = 'gid://shopify/App/1758145';
export const REPORT_DEFINITIONS = Object.freeze({
  net_gross:'Canonical finance gross sales less accounting refunds, within one currency.',
  orders:'Canonical finance sale transaction count; not a GA4 transaction count.',
  product_sales:'Persisted source-native line-item sales; operational evidence, not canonical finance.',
  conversion:'GA4 behavioural conversion; not a finance metric.',
  first_observed:'First qualifying purchase visible in that governed source history, never first-ever.',
  product_ref:'Governed mapping, then exact unique non-empty SKU, then exact unique conservatively-normalized product title; collisions remain source-specific.',
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
  const fallback={product_ref:`${row.source_platform}:${row.source_product_id||'unknown'}`,mapping_method:'source_identity_only',mapping_status:'source_specific',resolved:false};
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
  const finance=p=>query(`WITH transactions AS (
    SELECT date,currency,gross,transaction_type,channel,source FROM \`${project}.finance.accountant_transactions\`
    WHERE date BETWEEN @start_date AND @end_date AND NOT REGEXP_CONTAINS(LOWER(COALESCE(source,'')),r'shopify')
    UNION ALL SELECT DATE(f.created_at),UPPER(f.presentment_currency),f.original_total_presentment,'sale',IF(l.retail_location_id IS NULL,'Online','In-store'),'Shopify'
    FROM \`${project}.shopify_data.order_financials\` f JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
    WHERE DATE(f.created_at) BETWEEN @start_date AND @end_date AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
    UNION ALL SELECT DATE(f.created_at),UPPER(f.presentment_currency),-COALESCE(f.total_refunded_presentment,0),'refund',IF(l.retail_location_id IS NULL,'Online','In-store'),'Shopify'
    FROM \`${project}.shopify_data.order_financials\` f JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
    WHERE DATE(f.created_at) BETWEEN @start_date AND @end_date AND COALESCE(f.total_refunded_presentment,0)>0 AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id))
    SELECT FORMAT_DATE('%Y-%m-%d', date) date, UPPER(currency) currency,
    SUM(IF(transaction_type='sale',gross,0)) gross_sales, SUM(IF(transaction_type='refund',gross,0)) refunds,
    SUM(gross) net_gross, COUNTIF(transaction_type='sale') orders, COALESCE(channel,'Unclassified') channel,
    COALESCE(source,'Unclassified') source
    FROM transactions GROUP BY date,currency,channel,source ORDER BY date,currency,channel,source`,{...p,matrixify_app_id:MATRIXIFY_APP_ID});
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
    SELECT 'woo' source_platform,'ww' source_store,'Online' channel,DATE(o.order_created_at) date,CAST(li.product_id AS STRING) source_product_id,CAST(li.variation_id AS STRING) source_variant_id,li.sku,li.name title,li.quantity units,li.total product_sales,li.currency FROM \`${project}.metorik_uk.order_line_items\` li JOIN \`${project}.metorik_uk.orders\` o USING(order_id)
    UNION ALL SELECT 'woo','usd','Online',DATE(o.order_created_at),CAST(li.product_id AS STRING),CAST(li.variation_id AS STRING),li.sku,li.name,li.quantity,li.total,li.currency FROM \`${project}.metorik_us.order_line_items\` li JOIN \`${project}.metorik_us.orders\` o USING(order_id)
    UNION ALL SELECT 'shopify','shopify',IF(l.retail_location_id IS NULL,'Online','In-store'),DATE(li.order_created_at),li.product_id,li.variant_id,li.sku,COALESCE(li.title,li.name),li.quantity,li.discounted_total_presentment,li.presentment_currency FROM \`${project}.shopify_data.order_line_items\` li JOIN \`${project}.shopify_data.order_locations\` l USING(order_id) WHERE (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
    UNION ALL SELECT 'square','square','In-store',order_date,catalog_object_id,catalog_variation_id,transaction_sku,transaction_item_name,quantity,total_amount,currency FROM \`${project}.square_data.retail_order_items\`
  ), normalized AS (SELECT *,LOWER(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(NORMALIZE(REPLACE(REPLACE(REPLACE(REPLACE(title,'&apos;',"'"),'&#39;',"'"),'&ndash;','-'),'&mdash;','-'),NFKC),r'[‘’ʼ]',"'"),r'[‐‑‒–—―−]','-'),r'\\s+',' '))) normalized_title,NULLIF(UPPER(TRIM(sku)),'') normalized_sku FROM lines), products AS (
    SELECT source_platform,source_store,source_product_id,ANY_VALUE(title) source_title,ANY_VALUE(normalized_title) normalized_title,ANY_VALUE(normalized_sku) normalized_sku,COUNT(DISTINCT source_variant_id) variant_count FROM normalized GROUP BY 1,2,3
  ), identity_counts AS (SELECT *,COUNT(DISTINCT source_product_id) OVER(PARTITION BY source_platform,normalized_title) title_products_in_namespace,COUNT(DISTINCT source_product_id) OVER(PARTITION BY source_platform,normalized_sku) sku_products_in_namespace FROM products), identity AS (
    SELECT *,COUNT(DISTINCT IF(title_products_in_namespace=1,source_platform,NULL)) OVER(PARTITION BY normalized_title) title_source_count,COUNT(DISTINCT IF(sku_products_in_namespace=1,source_platform,NULL)) OVER(PARTITION BY normalized_sku) sku_source_count,MAX(title_products_in_namespace) OVER(PARTITION BY normalized_title) max_title_collision,MAX(sku_products_in_namespace) OVER(PARTITION BY normalized_sku) max_sku_collision FROM identity_counts
  ), classified AS (SELECT n.*,i.source_title,i.variant_count,
    CASE WHEN i.normalized_sku IS NOT NULL AND i.sku_products_in_namespace=1 AND i.sku_source_count>1 THEN CONCAT('sku:',i.normalized_sku) WHEN i.normalized_title IS NOT NULL AND i.normalized_title!='' AND i.title_products_in_namespace=1 AND i.title_source_count>1 THEN CONCAT('title:',i.normalized_title) ELSE CONCAT(n.source_platform,':',COALESCE(n.source_product_id,'unknown')) END canonical_product_ref,
    CASE WHEN i.normalized_sku IS NOT NULL AND i.sku_products_in_namespace=1 AND i.sku_source_count>1 THEN 'exact_unique_sku' WHEN i.normalized_title IS NOT NULL AND i.normalized_title!='' AND i.title_products_in_namespace=1 AND i.title_source_count>1 THEN 'exact_unique_normalized_title' ELSE 'source_identity_only' END mapping_method,
    CASE WHEN (i.normalized_sku IS NOT NULL AND i.max_sku_collision>1) OR (i.normalized_title IS NOT NULL AND i.normalized_title!='' AND i.max_title_collision>1) THEN 'ambiguous' WHEN (i.sku_source_count>1 AND i.sku_products_in_namespace=1) OR (i.title_source_count>1 AND i.title_products_in_namespace=1) THEN 'resolved' ELSE 'source_specific' END mapping_status FROM normalized n JOIN identity i USING(source_platform,source_store,source_product_id))
    SELECT canonical_product_ref product_ref,ANY_VALUE(source_title) canonical_title,ANY_VALUE(title) source_title,ANY_VALUE(normalized_title) normalized_title,ANY_VALUE(sku) source_sku,mapping_method,mapping_status,source_platform,source_store,channel,currency,source_product_id,ARRAY_AGG(DISTINCT source_variant_id IGNORE NULLS LIMIT 100) source_variant_ids,MAX(variant_count) variant_count,SUM(units) units,SUM(product_sales) product_sales,COUNT(*) line_items,'persisted_source_line_item' provenance
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
    const limitations={organic:['Governed Search Console coverage begins 6 May 2025, so November 2024 organic-search evidence is unavailable. November 2025 evidence remains available for current-period analysis. Canonical daily evidence selects Domain first and historical www only as fallback; properties are never summed.'],acquisition:['GA4 is behavioural evidence; GA4 revenue is not canonical finance.'],customers:['Behavioural metrics share one definition by source namespace; no Woo-to-Shopify person identity resolution is attempted. Guests are excluded from customer denominators and Matrixify orders from Shopify history.'],products:['Identity precedence is explicit governed mapping, exact unique non-empty SKU, exact unique conservatively-normalized product title, then source-specific unresolved. Collisions are never merged; variants remain attached to their source product. Product sales are source-native and currencies stay separate.'],geography:['Woo geography uses directly observed shipping country. Current persisted Shopify operational tables do not contain a governed shipping destination, so Shopify coverage is explicitly unavailable and is never inferred from billing, currency, market, location or IP.']}[section];
    const kpis=current.length?Object.entries(current.reduce((a,r)=>{for(const m of section==='customers'?['identified_customers','first_observed_customers','returning_customers','repeat_within_period_customers','guest_unresolved_orders']:[] )a[m]=(a[m]||0)+Number(r[m]||0);return a;},{})).map(([metric,value])=>({metric,label:metric.replaceAll('_',' '),value,comparison_value:null})):[];
    return{...base,status:current.length||comparison.length?'available':'unavailable',rows:current,comparison_rows:comparison,kpis,trend:current,chart,currencies:[...new Set(current.map(x=>x.currency).filter(Boolean))],evidence_availability:{[key]:availability},limitations};
  };
}
