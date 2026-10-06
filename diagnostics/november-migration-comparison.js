import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {createKnowledgeService} from '../oracle/knowledge-bigquery.js';
import {createEcommerceReportV2} from '../oracle/ecommerce-report-v2.js';

/** Existing governed knowledge and persisted finance only. No source collectors. */
export async function diagnose({bigquery,project}){
  const knowledgeService=createKnowledgeService({bigquery,project});
  const load=createEcommerceReportV2({bigquery,project,knowledgeService});
  const scope={start_date:'2025-11-01',end_date:'2025-11-30',comparison:'custom',comparison_start:'2024-11-01',comparison_end:'2024-11-30'};
  const operations=[['confirmed_2024_online_event',()=>knowledgeService.getKnowledgeItem({knowledge_id:'ev_d62be9ed-527e-403a-a661-cb2d11095ca5'})],['both_period_context',()=>load('context',scope)],['finance_components_and_overlap',()=>load('sales',scope)]];
  const results=await Promise.allSettled(operations.map(([,run])=>run()));
  return {read_only:true,source_collection:false,source_mutation:false,scope,results:Object.fromEntries(operations.map(([name],index)=>[name,results[index].status==='fulfilled'?{status:'fulfilled',evidence:results[index].value}:{status:'unavailable',error_code:String(results[index].reason?.code||'RETRIEVAL_FAILED').replace(/[^A-Za-z0-9_.-]/g,'').slice(0,80)}]))};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)console.log(JSON.stringify(await diagnose(createBigQueryClient()),null,2));
