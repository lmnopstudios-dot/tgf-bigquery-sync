import { answerCompleteness } from './answer-completeness.js';
import { normalizeOracleResult, oracleResultContent, RESULT_VERSION } from '../public/oracle/result-contract.js';
import { presentAnalyticalAnswer } from './answer-presentation.js';
import { evidenceSummary } from './evidence-summary.js';

export const safeDeliveryId=value=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(value||''))?String(value):'unknown';

/** Call only AFTER evidence scope validation. Reuse evidence; never rerun providers. */
export function deliverOracleResult(input,context, {present=presentAnalyticalAnswer,artifactBase='/api/oracle/exports'}={}) {
  let result=normalizeOracleResult(input);
  context=context||result.analysis_context;
  const completeness=answerCompleteness(context,result);
  if(completeness.status==='incomplete')return {...result,answer:'The retrieved evidence does not answer the requested '+completeness.operation.replaceAll('_',' ')+'. Missing: '+completeness.missing.map(field=>({executed_evidence:'evidence from the requested calculation',operation:'the requested calculation',cohort_outputs:'cohort results',period:'the requested reporting period',observation_window:'the requested observation window',entry_classification:'verified entry classifications',population:'the requested population',denominator:'valid mature-window counts and rates',retention_windows:'all requested retention windows',conditional_median:'valid time-to-second-purchase figures',identity:'governed source identities',duplicate_cohort:'unique cohort membership',row_bound:'a bounded cohort result',cohort_period:'the requested cohort dates',grouping:'the requested grouping'}[field]||field.replaceAll('_',' '))).join(', ')+'. No substitute report is presented.',presentation:null,charts:[],inline_chart:null,artifact:null,analysis_unavailable:true,partial:true,completeness,delivery:{version:RESULT_VERSION,status:'limitation',code:'ANSWER_INCOMPLETE',answer_present:true,evidence_present:Boolean(result.evidence),artifact_present:false}};
  result={...result,...(completeness.status!=='not_applicable'?{completeness}:{})};
  const prior=result.delivery?.version===RESULT_VERSION?result.delivery:null;
  let content=oracleResultContent(result,{artifactBase}),code=['EMPTY_TERMINAL_RESULT','PRESENTATION_FAILED','EVIDENCE_RENDER_FAILED','RESULT_SERIALIZATION_FAILED'].includes(prior?.code)?prior.code:null;
  if(result.evidence&&(!content.deliverable||!result.answer?.trim()&&!result.presentation?.summary_markdown?.trim())){
    try{result=present({...result,answer:''},context);content=oracleResultContent(result,{artifactBase});}catch{code='PRESENTATION_FAILED';}
    if(!content.deliverable||code==='PRESENTATION_FAILED'){
      const entries=result.evidence.kind==='governed_tool_results'&&Array.isArray(result.evidence.results)?result.evidence.results:[{name:'governed_evidence',result:result.evidence}];
      try{result={...result,answer:evidenceSummary(entries,{unavailable:result.evidence.unavailable||[]}),partial:true};}catch{code='EVIDENCE_RENDER_FAILED';}
      content=oracleResultContent(result,{artifactBase});
    }
  }
  if(!content.deliverable)code ||= 'EMPTY_TERMINAL_RESULT';
  const delivered={...result,answer:content.answer,delivery:{version:RESULT_VERSION,status:code||result.analysis_unavailable?'limitation':result.partial?'partial':'ready',code,answer_present:true,evidence_present:Boolean(result.evidence),artifact_present:content.artifactValid}};
  try{JSON.stringify(delivered);return delivered;}catch{
    const safe=value=>{try{return JSON.parse(JSON.stringify(value));}catch{return null;}};
    const recovered=deliverOracleResult({partial:true,evidence:safe(result.evidence),artifact:safe(result.artifact)},context,{artifactBase});
    return {...recovered,answer:'The final response could not be serialized.\n\n'+recovered.answer,delivery:{...recovered.delivery,status:'limitation',code:'RESULT_SERIALIZATION_FAILED'}};
  }
}

/** Preserve partial/limitation metadata across the internal /agent -> UI bridge. */
export function agentResultForUi(payload){
  const result=deliverOracleResult(payload);
  return {...result,tools:result.tools_used||result.tools||[]};
}
