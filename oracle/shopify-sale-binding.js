const normalize=v=>String(v||'').trim().replace(/^(?:the\s+great\s+frog|tgf)\s+/i,'').replace(/\s+/g,' ').toLowerCase();
export const shopifyRecordedChannel="CASE WHEN l.retail_location_id IS NOT NULL THEN 'instore' WHEN LOWER(TRIM(l.order_source))='online store' THEN 'online' ELSE 'unknown' END";
export const shopifyRecordedSource="CASE WHEN l.retail_location_id IS NOT NULL THEN 'Shopify POS' WHEN LOWER(TRIM(l.order_source))='online store' THEN 'Shopify Online Store' ELSE 'Shopify Unknown' END";
export const shopifySaleTimeSql=t=>`(${t} >= TIMESTAMP(@start_at) AND ${t} < TIMESTAMP(@end_exclusive)) AND (ARRAY_LENGTH(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(@sale_sessions_json)))=0 OR EXISTS(SELECT 1 FROM UNNEST(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(@sale_sessions_json))) s WHERE ${t} >= TIMESTAMP(JSON_VALUE(s,'$.start_at')) AND ${t} < TIMESTAMP(JSON_VALUE(s,'$.end_exclusive')) AND (JSON_VALUE(s,'$.location_id') IS NULL OR l.retail_location_id=JSON_VALUE(s,'$.location_id'))))`;
export async function bindShopifySaleSessions(execute,project,w){
 let sessions=(w.sale_sessions||[]).map(s=>({...s}));
 if(sessions.some(s=>s.location_name)){
  const rows=await execute(`SELECT DISTINCT retail_location_id,retail_location_name FROM \`${project}.shopify_data.order_locations\` WHERE retail_location_id IS NOT NULL AND created_at>=TIMESTAMP(@start_at) AND created_at<TIMESTAMP(@end_exclusive)`,{start_at:w.start_at,end_exclusive:w.end_exclusive});
  sessions=sessions.map(s=>{
   if(!s.location_name)return s;
   const ids=[...new Set(rows.filter(r=>normalize(r.retail_location_name)===normalize(s.location_name)).map(r=>r.retail_location_id).filter(Boolean))];
   if(ids.length!==1)throw Object.assign(Error('Documented POS store cannot be bound'),{code:ids.length?'SALE_SHOPIFY_LOCATION_AMBIGUOUS':'SALE_SHOPIFY_LOCATION_NOT_VERIFIED',missing:[s.location_name]});
   return {...s,location_id:ids[0]};
  });
 }
 return {sale_channel:w.shopify_channel,sale_sessions_json:JSON.stringify(sessions)};
}
