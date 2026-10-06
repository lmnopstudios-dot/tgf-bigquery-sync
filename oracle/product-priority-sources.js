import { bigQueryErrorDiagnostic } from './analysis-jobs.js';
import { MATRIXIFY_APP_ID } from '../finance/canonical.js';

// Read only the existing governed, persisted source tables. No collection,
// inventory, title matching or reporting-family consolidation is performed.
export function prioritySourceQueries(project){
  if(!/^[A-Za-z0-9_-]+$/.test(project))throw new Error('Invalid project');
  return {
    sales:`WITH locations AS (
      SELECT * FROM \`${project}.shopify_data.order_locations\`
      QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id ORDER BY synced_at DESC,updated_at DESC,created_at DESC)=1
    ), lines AS (
      SELECT * FROM \`${project}.shopify_data.order_line_items\`
      QUALIFY ROW_NUMBER() OVER(PARTITION BY order_id,line_item_id ORDER BY synced_at DESC,order_created_at DESC)=1
    ), online AS (
      SELECT li.product_id,li.presentment_currency currency,DATE(li.order_created_at,'Europe/London') date,li.discounted_total_presentment sales
      FROM lines li JOIN locations l USING(order_id)
      WHERE l.retail_location_id IS NULL AND LOWER(COALESCE(l.order_source,'')) NOT IN ('pos','shopify pos','point of sale') AND (l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id)
        AND li.product_id IS NOT NULL AND DATE(li.order_created_at,'Europe/London')<=DATE(@end_date)
    ) SELECT product_id,currency,'recent' evidence_window,SUM(sales) sales FROM online WHERE date>=DATE(@start_date) GROUP BY 1,2
      UNION ALL SELECT product_id,currency,'history',SUM(sales) FROM online GROUP BY 1,2`,
    traffic:`SELECT landing_path,SUM(sessions) sessions,COUNT(DISTINCT date) observed_days FROM \`${project}.ga4.landing_pages\` WHERE date BETWEEN DATE(@start_date) AND DATE(@end_date) GROUP BY 1`,
    organic:`SELECT p.page,SUM(p.impressions) impressions,SUM(p.clicks) clicks,COUNT(DISTINCT p.date) observed_days FROM \`${project}.search_console.pages\` p
      JOIN \`${project}.search_console.canonical_daily\` c ON p.date=c.date AND p.source_property=c.selected_source_property
      WHERE p.date BETWEEN DATE(@start_date) AND DATE(@end_date) AND p.coverage_status='available' AND c.coverage_status='available' GROUP BY 1`
  };
}
export function createPrioritySourceLoader({bigquery,project,landingOrigin='https://www.thegreatfroglondon.com'}){
  const queries=prioritySourceQueries(project);
  return async (dates,{onProviderStage}={})=>Object.fromEntries(await Promise.all(Object.entries(queries).map(async([name,query])=>{
    try{const params={start_date:dates.start_date,end_date:dates.end_date,...(name==='sales'?{matrixify_app_id:MATRIXIFY_APP_ID}:{})};const [rows]=await bigquery.query({query,params,useLegacySql:false,maximumBytesBilled:'5000000000',jobTimeoutMs:'60000',labels:{component:'oracle_priority',source:name}});
      return[name,{status:rows.length?'available':'unavailable',complete:false,coverage:'Existing persisted evidence; complete day-level collection coverage not established. Omitted rows are unmatched, never assumed zero.',definition:name==='sales'?'Shopify online line-item discounted presentment sales; POS and Matrixify excluded. Same product ID history through end date retained separately.':name==='traffic'?'GA4 landing sessions from the governed website property; not product conversion.':'Search Console page impressions and clicks; one governed property selected per day.',rows:name==='traffic'?rows.map(row=>({...row,url:`${landingOrigin}${row.landing_path}`})):rows}];
    }catch(error){const diagnostic=bigQueryErrorDiagnostic(error);onProviderStage?.({stage:`priority_${name}`,status:'unavailable',reason:diagnostic.reason,...(diagnostic.location?{location:diagnostic.location}:{})});return[name,{status:'unavailable',complete:false,error_code:/^[A-Z0-9_]{1,64}$/.test(String(error.code||''))?String(error.code):'SOURCE_FAILED',rows:[]}];}
  })));
}
