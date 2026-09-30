import {BigQuery} from '@google-cloud/bigquery';

export async function runDiscovery({bigquery,project,rawTable=process.env.GA4_SESSION_EVENTS_TABLE,location=process.env.GA4_SESSION_EVENTS_LOCATION||'EU'}){
  const aggregate=[`${project}.ga4.daily`,`${project}.ga4.ecommerce_funnel`];
  const inventory=[];
  for(const name of aggregate){const [p,d,t]=name.split('.');const [rows]=await bigquery.query({query:`SELECT table_name,column_name,data_type FROM \`${p}.${d}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name=@table ORDER BY ordinal_position`,params:{table:t},location,maximumBytesBilled:10_000_000});inventory.push({table:name,columns:rows});}
  let session_level={configured:false,available:false,table:rawTable||null,required_columns:['event_date','event_name','event_timestamp','user_pseudo_id','ga_session_id','item_id'],missing_columns:[]};
  if(rawTable){const [p,d,t]=rawTable.split('.');const [rows]=await bigquery.query({query:`SELECT column_name,data_type FROM \`${p}.${d}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name=@table ORDER BY ordinal_position`,params:{table:t.replace(/\*$/,'')},location,maximumBytesBilled:10_000_000});const names=new Set(rows.map(r=>r.column_name));session_level={...session_level,configured:true,available:session_level.required_columns.every(x=>names.has(x)),missing_columns:session_level.required_columns.filter(x=>!names.has(x)),columns:rows};}
  return {diagnostic:'product_view_purchase_evidence',read_only:true,public_shopify_launch:'2025-11-20',requested_periods:{current:['2026-01-01','2026-09-30'],woocommerce:['2024-11-20','2025-11-19']},session_level,aggregate_sources:inventory,shopify_analytics:{status:'aggregate_only_for_this_metric',note:'Existing Shopify analytics integrations expose aggregate sessions/funnel measures, not product-ID event sequences within a session.'},determination:session_level.available?'SESSION_LEVEL_SCHEMA_PRESENT_VERIFY_COVERAGE':'METRIC_NOT_ESTABLISHED',warning:'Aggregate product views and purchase/order counts cannot establish products viewed before buying. Order data cannot reconstruct historical browsing.'};
}

if(import.meta.url===`file://${process.argv[1]}`){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';runDiscovery({bigquery:new BigQuery({projectId:project}),project}).then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});}
