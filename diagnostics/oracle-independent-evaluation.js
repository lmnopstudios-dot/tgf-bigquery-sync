// Frozen-question evaluation, using the production provider factory and HTTP
// delivery fixtures. This is not a blind holdout or live warehouse validation.
import { readFileSync,writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { acceptanceFixture,acceptanceServer } from '../test/helpers/oracle-acceptance.js';
import { planOperation } from '../oracle/analytical-plan.js';
import { deliverOracleResult } from '../oracle/result-delivery.js';
import { transitionAnalysisContext } from '../oracle/analysis-context.js';
import { messageIntent } from '../oracle/message-intent.js';
const fixture=JSON.parse(readFileSync(new URL('../test/fixtures/oracle-independent-evaluation.json',import.meta.url)));
export async function evaluate(){
 const rows=[];
 for(const mode of ['direct','interactive','durable'])for(const entry of fixture.cases){
  const f=acceptanceFixture({retention:true,campaigns:true,country_conversion:true,now:Date.parse(fixture.runtime)}),h=await acceptanceServer(f,{durable:mode==='durable',now:Date.parse(fixture.runtime)});
  let prior=null,result,category,detail='';
  try{
   for(const question of entry.turns){
    result=mode==='direct'?await (await fetch(h.origin+'/agent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:question,analysis_context:prior})})).json():await h.submit(question);
    prior=result.analysis_context;
   }
   const operation=planOperation(prior);
   if(entry.outcome==='document')category=messageIntent(entry.turns.at(-1)).editing&&!prior?.tool_route&&!f.calls.length?'correct_document_boundary':'wrong_answer';
   else if(entry.outcome==='limitation'||entry.export==='limitation')category=result.analysis_unavailable?'correct_limitation':'wrong_answer';
   else if(entry.outcome==='clarification')category=result.clarification?.fields?.length?'necessary_clarification':'wrong_answer';
   else if(result.clarification?.fields?.length){
    // Reviewed rubric: a basket needs its currency; net sales is not the
    // product report's pre-refund product_sales measure. Both change results.
    const necessary=['basket','ranking'].includes(entry.id);
    category=necessary?'necessary_clarification':'unnecessary_clarification';detail=result.clarification.fields.join(',');
   }else if(result.analysis_unavailable){category=entry.id==='promotion'?'correct_limitation':'wrong_answer';detail='Requested combination unavailable; not a completed capability.';}
   else if(operation!==entry.operation||!result.evidence||!result.answer?.trim())category='wrong_answer';
   else {category=result.partial?'supported_partial_answer':'supported_answer';
    if(entry.operation==='cohort_retention'&&!result.evidence.rows.some(r=>r.repeat_rate===.75||r.repeat_rate===.5))category='wrong_answer';
    if(entry.operation==='population_comparison'&&!/2\.90%/.test(result.answer))category='wrong_answer';
    if(mode==='durable'){const before=f.calls.length,recovered=await h.get('/jobs/'+result.job_id);if(recovered.answer!==result.answer||f.calls.length!==before)category='execution_failure';}
   }
   rows.push({id:entry.id,mode,category,operation,provider_calls:f.calls.map(c=>c.provider),detail});
  }catch(error){rows.push({id:entry.id,mode,category:'execution_failure',detail:String(error.message).slice(0,180)});}
  finally{h.close();}
 }
 const negative_context=transitionAnalysisContext(null,'Which collaboration leads to return customers after their first item online in 2025?').context;
 const negatives=[
  [negative_context,{kind:'shopify_operational_sales_baseline'}],
  [transitionAnalysisContext(null,'Compare UK visitor conversion to global last month.').context,{kind:'governed_device_conversion'}],
  [transitionAnalysisContext(null,'Show UK GBP product combinations in online baskets last month.').context,{kind:'governed_order_values'}]
 ].map(([context,evidence])=>deliverOracleResult({answer:'A related successful report',evidence},context).delivery.code==='ANSWER_INCOMPLETE');
 const counts=Object.fromEntries(['supported_answer','supported_partial_answer','correct_limitation','necessary_clarification','unnecessary_clarification','correct_document_boundary','wrong_answer','execution_failure'].map(k=>[k,rows.filter(r=>r.category===k).length]));
 return {fixture_version:fixture.version,exposure:fixture.exposure,implementation_informed_by:['retention-export','document','retention intent without explicit first-purchase wording'],live:false,harness_corrections:['Country fixture now returns dates from actual provider arguments rather than fixed January dates.','Editing fallback permits only toolsAllowed:false and no provider calls.'],initial_run:{wrong_answer:3,execution_failure:2,reason:'Country fixture date mismatch and prohibited safe editing stub; see harness corrections.'},counts,clarification_rate:counts.necessary_clarification/rows.length,wrong_answer_rate:counts.wrong_answer/rows.length,unnecessary_clarification_rate:counts.unnecessary_clarification/rows.length,negative_substitution_rejected:negatives.every(Boolean),negative_cases_checked:negatives.length,rows};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const report=await evaluate();writeFileSync(new URL('../docs/oracle-independent-evaluation-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.counts));if(report.counts.wrong_answer||report.counts.execution_failure||report.counts.unnecessary_clarification||!report.negative_substitution_rejected)process.exitCode=1;}
