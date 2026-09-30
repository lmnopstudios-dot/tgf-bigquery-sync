export const SHOPIFY_PUBLIC_LAUNCH='2025-11-20';
export const PRODUCT_VIEW_PERIODS=Object.freeze({current:{start_date:'2026-01-01',end_date:'2026-09-30'},woocommerce:{start_date:'2024-11-20',end_date:'2025-11-19'}});
export const PRODUCT_VIEW_METRIC='distinct_products_viewed_before_first_purchase_per_purchasing_session';

const DATE=/^\d{4}-\d{2}-\d{2}$/;
const tableName=value=>{
  const name=String(value||'');
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_$*-]+$/.test(name))throw new Error('GA4 session-event table is not configured');
  return `\`${name}\``;
};

export const PRODUCT_VIEW_PURCHASE_TOOL={type:'function',name:'get_product_views_before_purchase',strict:true,description:'Return the governed aggregate number of distinct product IDs viewed strictly before the first purchase in each purchasing session. It requires established session-level GA4 event evidence and never substitutes event totals or order data.',parameters:{type:'object',additionalProperties:false,properties:{current_start:{type:'string'},current_end:{type:'string'},woocommerce_start:{type:'string'},woocommerce_end:{type:'string'}},required:['current_start','current_end','woocommerce_start','woocommerce_end']}};

export function productViewPurchaseSql(rawTable){
  const table=tableName(rawTable);
  return `WITH requested AS (SELECT 'current' period,@current_start start_date,@current_end end_date UNION ALL SELECT 'woocommerce',@woocommerce_start,@woocommerce_end), events AS (
  SELECT r.period,e.event_date,e.user_pseudo_id,e.ga_session_id,e.event_name,e.event_timestamp,NULLIF(TRIM(e.item_id),'') item_id
  FROM ${table} e JOIN requested r ON e.event_date BETWEEN r.start_date AND r.end_date
  WHERE e.event_name IN ('view_item','purchase') AND e.user_pseudo_id IS NOT NULL AND e.ga_session_id IS NOT NULL
), first_purchase AS (SELECT period,user_pseudo_id,ga_session_id,MIN(event_timestamp) first_purchase_timestamp FROM events WHERE event_name='purchase' GROUP BY 1,2,3), sessions AS (
  SELECT p.period,p.user_pseudo_id,p.ga_session_id,p.first_purchase_timestamp,
    COUNTIF(e.event_name='view_item' AND e.event_timestamp<p.first_purchase_timestamp) product_view_events_before_purchase,
    COUNT(DISTINCT IF(e.event_name='view_item' AND e.event_timestamp<p.first_purchase_timestamp,e.item_id,NULL)) distinct_products_viewed_before_purchase,
    COUNTIF(e.event_name='view_item' AND e.event_timestamp<p.first_purchase_timestamp AND e.item_id IS NULL) missing_product_id_view_events
  FROM first_purchase p LEFT JOIN events e USING(period,user_pseudo_id,ga_session_id) GROUP BY 1,2,3,4
), aggregate AS (SELECT period,COUNT(*) purchasing_sessions,AVG(distinct_products_viewed_before_purchase) average_distinct_products_viewed_before_first_purchase,AVG(product_view_events_before_purchase) average_product_view_events_before_first_purchase,SUM(missing_product_id_view_events) missing_product_id_view_events FROM sessions GROUP BY period), coverage AS (SELECT period,MIN(event_date) coverage_start,MAX(event_date) coverage_end,COUNT(*) relevant_event_rows FROM events GROUP BY period)
SELECT r.period,COALESCE(a.purchasing_sessions,0) purchasing_sessions,a.average_distinct_products_viewed_before_first_purchase,a.average_product_view_events_before_first_purchase,COALESCE(a.missing_product_id_view_events,0) missing_product_id_view_events,c.coverage_start,c.coverage_end,COALESCE(c.relevant_event_rows,0) relevant_event_rows
FROM requested r LEFT JOIN aggregate a USING(period) LEFT JOIN coverage c USING(period) ORDER BY period`;
}

/** Reference implementation used to lock the SQL semantics in regression tests. */
export function aggregateSessionEvents(events){
  const groups=new Map();
  for(const event of events){if(event.user_pseudo_id==null||event.ga_session_id==null)continue;const key=`${event.user_pseudo_id}\u0000${event.ga_session_id}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(event);}
  const sessions=[];
  for(const rows of groups.values()){const purchases=rows.filter(x=>x.event_name==='purchase').map(x=>Number(x.event_timestamp));if(!purchases.length)continue;const first=Math.min(...purchases),views=rows.filter(x=>x.event_name==='view_item'&&Number(x.event_timestamp)<first);sessions.push({distinct_products_viewed_before_purchase:new Set(views.map(x=>String(x.item_id||'').trim()).filter(Boolean)).size,product_view_events_before_purchase:views.length,missing_product_id_view_events:views.filter(x=>!String(x.item_id||'').trim()).length});}
  const average=key=>sessions.length?sessions.reduce((sum,row)=>sum+row[key],0)/sessions.length:null;
  return {purchasing_sessions:sessions.length,average_distinct_products_viewed_before_first_purchase:average('distinct_products_viewed_before_purchase'),average_product_view_events_before_first_purchase:average('product_view_events_before_purchase'),missing_product_id_view_events:sessions.reduce((sum,row)=>sum+row.missing_product_id_view_events,0)};
}

export function createProductViewPurchaseService({bigquery,rawTable=process.env.GA4_SESSION_EVENTS_TABLE,location=process.env.GA4_SESSION_EVENTS_LOCATION||'EU'}){
  return async args=>{
    for(const [key,value] of Object.entries(args))if(!DATE.test(value))throw new Error(`invalid ${key}`);
    const expected={current_start:'2026-01-01',woocommerce_start:'2024-11-20',woocommerce_end:'2025-11-19'};
    for(const [key,value] of Object.entries(expected))if(args[key]!==value)throw new Error(`governed period mismatch: ${key}`);
    if(args.current_end!=='2026-09-30')throw new Error('current_end must remain the original request date');
    if(!rawTable)return {availability:'not_established',metric:PRODUCT_VIEW_METRIC,periods:args,launch_date:SHOPIFY_PUBLIC_LAUNCH,evidence_required:['product ID','user_pseudo_id + ga_session_id','event timestamp','purchase timestamp'],aggregate_evidence_limit:'Daily GA4 or Shopify funnel totals cannot establish within-session event order. All product views divided by purchases is not this metric.',historical_reconstruction:'Order data alone cannot reconstruct historical product views.',next_step:'Run npm run discover:product-views in production. Configure GA4_SESSION_EVENTS_TABLE only after its session-level fields and coverage are verified.'};
    const [rows]=await bigquery.query({query:productViewPurchaseSql(rawTable),params:args,types:Object.fromEntries(Object.keys(args).map(k=>[k,'DATE'])),location,maximumBytesBilled:2_000_000_000,labels:{component:'oracle_product_views_before_purchase'}});
    const covered=rows.filter(r=>Number(r.relevant_event_rows)>0);
    return {availability:covered.length?'observed_session_level':'session_schema_present_no_period_evidence',metric:PRODUCT_VIEW_METRIC,definition:'Mean of distinct nonblank product IDs in view_item events strictly before the earliest purchase event in the same user_pseudo_id + ga_session_id session.',periods:args,launch_date:SHOPIFY_PUBLIC_LAUNCH,coverage:rows.map(r=>({period:r.period,first_observed_date:r.coverage_start?.value||r.coverage_start||null,last_observed_date:r.coverage_end?.value||r.coverage_end||null,relevant_event_rows:Number(r.relevant_event_rows||0)})),rows,governance:{duplicate_handling:'Repeated views of the same product ID in a session count once; duplicate purchase events collapse to the earliest purchase timestamp.',missing_ids:'Blank/missing item IDs are excluded from the distinct-product numerator and counted separately.',excluded:'Sessions without a purchase are excluded. Views at or after the first purchase are excluded.',limitations:['Consent denial and blockers can omit events or identifiers.','Bot/internal-traffic filtering follows the source export configuration.','This is session-level, not customer-level; no customer rows are returned.']}};
  };
}

export async function executeProductViewPurchaseToolCall(service,name,args){return name==='get_product_views_before_purchase'?{handled:true,result:await service(args)}:{handled:false};}
