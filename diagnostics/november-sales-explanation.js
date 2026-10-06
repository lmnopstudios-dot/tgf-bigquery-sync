#!/usr/bin/env node
/** Read-only live acceptance of the same parser/report/explanation path. */
import {BigQuery} from '@google-cloud/bigquery';
import {createEcommerceReportV2} from '../oracle/ecommerce-report-v2.js';
import {createKnowledgeService} from '../oracle/knowledge-bigquery.js';
import {createGeneralAnalyticsService} from '../oracle/general-analytics.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {dispatchAnalysisRequest} from '../oracle/analysis-route-dispatcher.js';
const message='Why did November 2025 online sales change versus November 2024?';
if(!process.env.GOOGLE_PROJECT_ID||!process.env.GOOGLE_SERVICE_ACCOUNT_JSON){
  console.log(JSON.stringify({live_acceptance:'blocked',reason:'Configured Google project/service-account bindings are unavailable.'}));process.exitCode=1;
}else{
  let stage='credential_configuration';
  try{
    const bigquery=new BigQuery({projectId:process.env.GOOGLE_PROJECT_ID,credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)}),project=process.env.GOOGLE_PROJECT_ID;
    stage='shared_explanation';
    const knowledgeService=createKnowledgeService({bigquery,project}),baselineOverview=createGeneralAnalyticsService({loadReport:createEcommerceReportV2({bigquery,project,knowledgeService})});
    const analysisContext=transitionAnalysisContext(null,message).context;
    const result=await dispatchAnalysisRequest({message,analysisContext,baselineOverview,chat:async()=>{throw new Error('Unexpected fallback')}});
    console.log(JSON.stringify({read_only:true,message,analysisContext,result},null,2));
    stage='migration_overlap';
    const [migration]=await bigquery.query({query:`SELECT
      COUNTIF(l.source_app_id=@matrixify_app_id) excluded_matrixify_representations,
      COUNTIF(l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id) native_representations,
      MIN(IF(l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id,DATE(f.created_at),NULL)) first_native_order_date,
      MAX(IF(l.source_app_id IS NULL OR l.source_app_id!=@matrixify_app_id,DATE(f.created_at),NULL)) last_native_order_date
      FROM \`${project}.shopify_data.order_financials\` f JOIN \`${project}.shopify_data.order_locations\` l USING(order_id)
      WHERE DATE(f.created_at) BETWEEN DATE(@start_date) AND DATE(@end_date) AND l.retail_location_id IS NULL`,params:{matrixify_app_id:'gid://shopify/App/1758145',start_date:'2025-11-01',end_date:'2025-11-30'},maximumBytesBilled:'5000000000',useLegacySql:false});
    console.log(JSON.stringify({read_only:true,migration_overlap:migration},null,2));
    if(result.evidence.retrieval?.some(x=>x.status==='failed'))process.exitCode=1;
  }catch(error){
    console.log(JSON.stringify({live_acceptance:'blocked',stage,error_class:error?.name||'Error',reason:'Configured provider access failed; live data and migration counts remain unverified.'}));process.exitCode=1;
  }
}
