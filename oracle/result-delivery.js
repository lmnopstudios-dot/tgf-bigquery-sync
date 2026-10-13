import { normalizeOracleResult, oracleResultContent, RESULT_VERSION } from '../public/oracle/result-contract.js';
import { presentAnalyticalAnswer } from './answer-presentation.js';
import { evidenceSummary } from './evidence-summary.js';

export const safeDeliveryId=value=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(value||''))?String(value):'unknown';

/** Call only AFTER evidence scope validation. Reuse evidence; never rerun providers. */
export function deliverOracleResult(input,context, {present=presentAnalyticalAnswer,artifactBase='/api/oracle/exports'}={}) {
  let result=normalizeOracleResult(input);
  const prior=result.delivery?.version===RESULT_VERSION?result.delivery:null;
  let content=oracleResultContent(result,{artifactBase}),code=['EMPTY_TERMINAL_RESULT','PRESENTATION_FAILED','EVIDENCE_RENDER_FAILED','RESULT_SERIALIZATION_FAILED'].includes(prior?.code)?prior.code:null;
  if(!content.deliverable&&result.evidence){
    try{result=present({...result,answer:''},context);content=oracleResultContent(result,{artifactBase});}catch{code='PRESENTATION_FAILED';}
    if(!content.deliverable){
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
