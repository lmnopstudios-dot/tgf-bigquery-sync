// Bounded, aggregate-only production binding check. No collector or persistent writes.
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {answerCohortRetention} from '../oracle/cohort-retention.js';
export const RETENTION_ANSWER_QUESTION='Which named collaborations have the highest mature 90-day repeat-purchase rates? Show Woo WW, Woo USD and Shopify separately, with cohort sizes, repeat counts and classification coverage. Use the last three years through yesterday. Distinguish first-observed from first-ever customers. Table only; no collection or mutation.';
export async function verifyRetentionAnswer({bigquery,project,now=Date.now()}){
 const context=transitionAnalysisContext(null,RETENTION_ANSWER_QUESTION,{now}).context;
 const provider=createOracleProviderDependencies({bigquery,project}).customerJourney;
 const result=await answerCohortRetention({context,provider,deadlineAt:Date.now()+45000});
 return {read_only:true,production_binding:true,deployed_delivery_verified:false,entry_start:context.start_date,entry_end:context.end_date,requested_observation_cutoff:context.observation_end,timezone:context.time_zone,source_outcomes:result.evidence.source_outcomes,coverage:result.evidence.coverage.classification,rows:result.evidence.rows,answer:result.answer};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const result=await verifyRetentionAnswer(createBigQueryClient());console.log(JSON.stringify(result));if(result.source_outcomes.some(s=>s.state!=='fulfilled'))process.exitCode=1;}
 catch{console.log(JSON.stringify({read_only:true,production_binding:true,deployed_delivery_verified:false,state:'rejected',stage:'client_setup',code:'COHORT_CLIENT_SETUP_FAILED'}));process.exitCode=1;}
}
