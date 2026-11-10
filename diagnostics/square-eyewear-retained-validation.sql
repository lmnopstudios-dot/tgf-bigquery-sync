-- Standard SQL, read only. Set maximum bytes billed to 5 GB before running.
-- Title matching only (no approved aliases); no personal data or raw lines returned.
WITH square_latest AS (SELECT * FROM `gf-full-data.square_data.retail_orders` o
        WHERE NULLIF(order_id,'') IS NOT NULL
        QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY updated_at DESC,TO_JSON_STRING(o) DESC)=1),
      eligible AS (SELECT order_id oid,DATE(created_at,'Europe/London') day,'Unknown' channel
        FROM square_latest WHERE UPPER(order_state) IN ('COMPLETE','COMPLETED') AND created_at>=TIMESTAMP('2023-11-10','Europe/London') AND created_at<TIMESTAMP(DATE_ADD(DATE('2026-11-09'),INTERVAL 1 DAY),'Europe/London')),
      line AS (SELECT order_id oid,COALESCE(CONCAT('uid:',NULLIF(line_item_uid,'')),CONCAT('offset:',CAST(source_line_offset AS STRING))) lid,
        COALESCE(catalog_item_id,catalog_object_id) product_id,COALESCE(catalog_variation_id,catalog_object_id) variant_id,
        transaction_item_name title,transaction_variation_name colour,SAFE_CAST(quantity AS NUMERIC) units,
        CAST(NULL AS NUMERIC) sales,UPPER(currency) currency FROM `gf-full-data.square_data.retail_order_items` t
        WHERE order_id IN (SELECT oid FROM eligible)
        QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id, COALESCE(CONCAT('uid:',NULLIF(line_item_uid,'')),CONCAT('offset:',CAST(source_line_offset AS STRING))) ORDER BY TO_JSON_STRING(t) DESC)=1),
    normalized AS (SELECT *,IF(NULLIF(TRIM(product_id),'') IS NULL OR product_id='0',NULL,
      CONCAT('square:square:',IF('square'='shopify',REGEXP_REPLACE(product_id,r'^gid://shopify/Product/',''),product_id))) ref FROM line),
    titled AS (SELECT DISTINCT ref FROM normalized WHERE ref IS NOT NULL AND REGEXP_CONTAINS(LOWER(COALESCE(title,'')),r'\bcutler\s*(?:and|&)\s*gross\b') AND NOT REGEXP_CONTAINS(LOWER(COALESCE(title,'')),r'\b(?:replacement|repair|spare|cleaning cloth|cleaning kit|glasses case|sunglasses case|eyewear case|lens only|lenses only|nose pads?|accessories)\b')),
    matched AS (SELECT n.*,e.day,e.channel FROM normalized n JOIN eligible e USING(oid)
      WHERE lid IS NOT NULL AND NOT REGEXP_CONTAINS(LOWER(COALESCE(title,'')),r'\b(?:replacement|repair|spare|cleaning cloth|cleaning kit|glasses case|sunglasses case|eyewear case|lens only|lenses only|nose pads?|accessories)\b') AND
        (REGEXP_CONTAINS(LOWER(COALESCE(title,'')),r'\bcutler\s*(?:and|&)\s*gross\b') OR ref IN (SELECT ref FROM titled) OR ref IN UNNEST(JSON_VALUE_ARRAY('[]')))
      ORDER BY day,oid,lid LIMIT 20001),
    represented AS (SELECT DISTINCT oid FROM line WHERE lid IS NOT NULL),
    population AS (SELECT CAST(DATE_TRUNC(day,MONTH) AS STRING) month,channel,COUNT(*) eligible_orders,
      COUNT(r.oid) orders_with_lines,
      CAST(MIN(day) AS STRING) first_date,CAST(MAX(day) AS STRING) last_date FROM eligible e LEFT JOIN represented r USING(oid) GROUP BY 1,2)
    SELECT p.*, eligible_orders-orders_with_lines AS orders_without_lines,
      COALESCE(m.eyewear_orders,0) AS observed_eyewear_orders, COALESCE(m.eyewear_lines,0) AS observed_eyewear_lines,
      m.pairs AS observed_pairs
    FROM population p LEFT JOIN (
      SELECT CAST(DATE_TRUNC(day,MONTH) AS STRING) month, channel,
        COUNT(DISTINCT oid) eyewear_orders, COUNT(*) eyewear_lines, SUM(units) pairs
      FROM matched GROUP BY 1,2
    ) m USING(month,channel)
    ORDER BY month,channel;
