import {MATRIXIFY_APP_ID} from '../finance/canonical.js';
import {squarePaymentChannelEvidenceSql,squareOrderChannelsSql} from './square-channels.js';
const fail=(code,missing=[])=>Object.assign(Error(code),{code,missing});
const jf=(j,...paths)=>`COALESCE(${paths.map(p=>`JSON_VALUE(${j},'$.${p}')`).join(',')})`;
const ts=x=>`SAFE_CAST(${x} AS TIMESTAMP)`;
const money=x=>`SAFE_CAST(${x} AS NUMERIC)`;
const amount=j=>money(`COALESCE(${jf(j,'amount_money.amount','amount_money_amount','amount')},JSON_VALUE(SAFE.PARSE_JSON(JSON_VALUE(${j},'$.amount_money')),'$.amount'))`);
const currency=j=>`COALESCE(${jf(j,'amount_money.currency','amount_money_currency','currency')},JSON_VALUE(SAFE.PARSE_JSON(JSON_VALUE(${j},'$.amount_money')),'$.currency'))`;
const major=(a,c)=>`CASE WHEN UPPER(${c}) IN ('JPY','KRW') THEN ${a} WHEN UPPER(${c}) IN ('GBP','USD','EUR') THEN ${a}/100 ELSE NULL END`;
const inWindow=t=>`${t} >= TIMESTAMP(@start_at) AND ${t} < TIMESTAMP(@end_exclusive)`;
const safeProject=p=>{if(!/^[\w-]+$/.test(p))throw Error('Invalid project');return p;};
export function squareSessionCtes(project){safeProject(project);return `square_raw AS(SELECT TO_JSON(o,stringify_wide_numbers=>TRUE) j FROM \`${project}.square_data.orders\` o),
 sx_square AS(SELECT ${jf('j','order_id','id')} oid,JSON_VALUE(j,'$.location_id') location_id,UPPER(${jf('j','state','status')}) state,j FROM square_raw
 QUALIFY ROW_NUMBER() OVER(PARTITION BY ${jf('j','order_id','id')} ORDER BY ${ts(jf('j','updated_at','created_at'))} DESC,TO_JSON_STRING(j) DESC)=1),
 sx_channel_evidence AS(${squarePaymentChannelEvidenceSql(project)}),sx_channels AS(${squareOrderChannelsSql()}),
 square_payments AS(SELECT TO_JSON(p,stringify_wide_numbers=>TRUE) j FROM \`${project}.square_data.payments\` p),
 payment_latest AS(SELECT * FROM square_payments QUALIFY ROW_NUMBER() OVER(PARTITION BY ${jf('j','payment_id','id')} ORDER BY ${ts(jf('j','updated_at','created_at'))} DESC,TO_JSON_STRING(j) DESC)=1)`;}
export function timestampSalesSql(project,source,measure){
 safeProject(project);
 if(source==='square'){
  const c=squareSessionCtes(project);
  if(measure==='sales')return `WITH ${c} SELECT 'Square' source,c.channel,UPPER(${currency('p.j')}) currency,'sale' transaction_type,SUM(${major(amount('p.j'),currency('p.j'))}) amount,COUNT(*) transaction_count,COUNTIF(${amount('p.j')} IS NULL) missing_amounts
 FROM payment_latest p JOIN sx_square o ON o.oid=JSON_VALUE(p.j,'$.order_id') JOIN sx_channels c USING(oid)
 WHERE UPPER(JSON_VALUE(p.j,'$.status'))='COMPLETED' AND o.state IN ('COMPLETE','COMPLETED') AND o.location_id=@location_id AND JSON_VALUE(p.j,'$.location_id')=@location_id AND ${inWindow(ts(jf('p.j','created_at')))} GROUP BY source,c.channel,currency`;
  if(measure==='refunds')return `WITH ${c},raw_refunds AS(SELECT TO_JSON(r,stringify_wide_numbers=>TRUE) j FROM \`${project}.square_data.refunds\` r),refund_latest AS(SELECT * FROM raw_refunds QUALIFY ROW_NUMBER() OVER(PARTITION BY ${jf('j','refund_id','id')} ORDER BY ${ts(jf('j','updated_at','created_at'))} DESC,TO_JSON_STRING(j) DESC)=1)
 SELECT 'Square' source,c.channel,UPPER(${currency('r.j')}) currency,'refund' transaction_type,-SUM(ABS(${major(amount('r.j'),currency('r.j'))})) amount,COUNT(*) refund_events,COUNTIF(${amount('r.j')} IS NULL) missing_amounts FROM refund_latest r JOIN payment_latest p ON ${jf('p.j','payment_id','id')}=JSON_VALUE(r.j,'$.payment_id') JOIN sx_square o ON o.oid=JSON_VALUE(p.j,'$.order_id') JOIN sx_channels c USING(oid)
 WHERE UPPER(JSON_VALUE(r.j,'$.status'))='COMPLETED' AND o.location_id=@location_id AND JSON_VALUE(p.j,'$.location_id')=@location_id AND ${inWindow(ts(jf('r.j','created_at')))} GROUP BY source,c.channel,currency`;
 }
 if(source==='shopify'){
  const c=`f AS(SELECT * FROM \`${project}.shopify_data.order_financials\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1),l AS(SELECT * FROM \`${project}.shopify_data.order_locations\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1)`;
  const eligibility=`(l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id) AND LOWER(TRIM(l.order_source))='online store' AND f.cancelled_at IS NULL`;
  if(measure==='sales')return `WITH ${c} SELECT 'Shopify Online Store' source,'Online' channel,UPPER(f.presentment_currency) currency,'sale' transaction_type,SUM(f.original_total_presentment) amount,COUNTIF(f.original_total_presentment IS NULL) missing_amounts,COUNT(*) transaction_count FROM f JOIN l USING(order_id) WHERE ${eligibility} AND ${inWindow('f.created_at')} AND EXISTS(SELECT 1 FROM UNNEST(IFNULL(JSON_QUERY_ARRAY(SAFE.PARSE_JSON(f.transactions_json)),[])) t WHERE JSON_VALUE(t,'$.status')='SUCCESS' AND JSON_VALUE(t,'$.kind') IN ('SALE','CAPTURE')) GROUP BY currency`;
  if(measure==='refunds')return `WITH ${c},r AS(SELECT * FROM \`${project}.shopify_data.order_refunds\` QUALIFY ROW_NUMBER() OVER(PARTITION BY refund_id ORDER BY synced_at DESC)=1) SELECT 'Shopify Online Store' source,'Online' channel,UPPER(COALESCE(r.presentment_currency,f.presentment_currency)) currency,'refund' transaction_type,-SUM(ABS(r.refund_total_presentment)) amount,COUNTIF(r.refund_total_presentment IS NULL) missing_amounts,COUNT(*) refund_events FROM r JOIN f USING(order_id) JOIN l USING(order_id) WHERE ${eligibility} AND r.has_successful_refund_transaction AND ${inWindow('r.refund_created_at')} GROUP BY currency`;
 }
 if(['ww','usd'].includes(source)){
  const ds=source==='ww'?'metorik_uk':'metorik_us',c=`o AS(SELECT * FROM \`${project}.${ds}.orders\` QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC)=1)`;
  if(measure==='sales')return `WITH ${c} SELECT 'WooCommerce ${source}' source,'Online' channel,UPPER(currency) currency,'sale' transaction_type,SUM(total) amount,COUNTIF(total IS NULL) missing_amounts,COUNT(*) transaction_count FROM o WHERE LOWER(status) IN ('completed','processing') AND ${inWindow('order_created_at')} GROUP BY currency`;
  if(measure==='refunds')return `WITH ${c},r AS(SELECT * FROM \`${project}.${ds}.refunds_api\` QUALIFY ROW_NUMBER() OVER(PARTITION BY refund_id ORDER BY synced_at DESC)=1) SELECT 'WooCommerce ${source}' source,'Online' channel,UPPER(o.currency) currency,'refund' transaction_type,-SUM(ABS(r.refund_amount)) amount,COUNTIF(r.refund_amount IS NULL) missing_amounts,COUNT(*) refund_events FROM r JOIN o ON CAST(o.order_id AS STRING)=r.order_id WHERE ${inWindow('r.refund_date')} GROUP BY currency`;
 }
 throw fail('EVENT_TIMESTAMP_SOURCE_UNSUPPORTED');
}
export function createEventTimestampProvider({bigquery,project,run}){
 const execute=run||((query,params)=>(bigquery.query({query,params,types:Object.fromEntries(Object.keys(params).map(k=>[k,'STRING'])),useLegacySql:false,maximumBytesBilled:'1000000000',jobTimeoutMs:15000,labels:{component:'oracle_event_session'}}).then(r=>r[0])));
 return {
  async bind(w){
   if(w.time_issue)throw fail(w.time_issue);
   if(!w.start_at||!w.end_exclusive)throw fail('EVENT_EXACT_HOURS_NOT_RECORDED',['knowledge start/end clock bounds']);
   if(!w.source_selection)throw fail('EVENT_SOURCE_SELECTION_MISSING');
   let location_id=null,location_evidence=null;
   if(w.channel==='instore'){
    if(!w.location_name)throw fail('EVENT_STORE_NOT_RECORDED');
    let rows,locationSource='square_data.retail_locations';try{rows=await execute(`SELECT location_id,location_name,timezone,has_persisted_location_metadata FROM \`${project}.square_data.retail_locations\``,{});}catch{locationSource='square_data.locations';rows=await execute(`SELECT COALESCE(JSON_VALUE(j,'$.location_id'),JSON_VALUE(j,'$.id')) location_id,JSON_VALUE(j,'$.name') location_name,JSON_VALUE(j,'$.timezone') timezone,JSON_VALUE(j,'$.name') IS NOT NULL has_persisted_location_metadata FROM(SELECT TO_JSON(l,stringify_wide_numbers=>TRUE) j FROM \`${project}.square_data.locations\` l)`,{});}
    const norm=x=>String(x||'').toLowerCase().replace(/^tgf\s+/,'').trim(),matches=rows.filter(r=>r.has_persisted_location_metadata===true&&norm(r.location_name)===norm(w.location_name));
    if(matches.length!==1)throw fail(matches.length?'EVENT_LOCATION_AMBIGUOUS':'EVENT_LOCATION_NOT_VERIFIED',[w.location_name]);
    if(!matches[0].timezone||!['Europe/London','UTC','GMT'].includes(matches[0].timezone))throw fail('EVENT_STORE_TIMEZONE_NOT_VERIFIED',[matches[0].timezone||'timezone']);
    location_id=matches[0].location_id;location_evidence={...matches[0],observed_at:new Date().toISOString(),source:locationSource};
   }
   return {start_at:w.start_at,end_exclusive:w.end_exclusive,location_id,matrixify_app_id:MATRIXIFY_APP_ID,location_evidence};
  },
  async totals(w){
   const binding=await this.bind(w),{location_evidence,...params}=binding;
   const sources=w.source_selection==='woo'?['ww','usd']:[w.source_selection];
   const components=await Promise.all(sources.flatMap(source=>['sales','refunds'].map(async measure=>{try{const rows=await execute(timestampSalesSql(project,source,measure),params);return {source,measure,status:rows.length?'fulfilled':'unavailable',code:rows.length?null:'NO_OBSERVATIONS_COVERAGE_UNVERIFIED',rows:rows.map(r=>({...r,amount:r.missing_amounts?null:r.amount}))};}catch(e){return {source,measure,status:'failed',code:typeof e.code==='string'&&/^[A-Z0-9_]+$/.test(e.code)?e.code:'SOURCE_TIMESTAMP_OR_MEASURE_UNAVAILABLE',rows:[]};}})));
   return {period:w,definition:'timestamped_source_net_gross',exact_hours:w.time_precision!=='date_only',rows:components.flatMap(c=>c.rows),components,requires_refund_evidence:true,location_evidence,coverage:{complete:null},discount_attribution:'unavailable; temporal membership is not campaign-discount proof',limitations:['Native successful payments/orders less refund events in the exact half-open window; ledger reconciliation and collection completeness are unverified.',...(w.source_selection==='square'?['Square card-present channel classification reuses the existing payment evidence rule; unknown/cash/mixed tender channels stay separate.']:w.source_selection==='woo'?['Woo timestamp bindings cover WW and USD stores; a timestamped JP source is not bound, so JP sales/refunds remain unavailable.']:['Only native Shopify Online Store orders are eligible; Matrixify imports are excluded.'])]};
  }
 };
}
