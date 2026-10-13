// Shared wire contract: no provider calls, scope decisions or persistence here.
export const RESULT_VERSION = 1;
export const safeResultIdentifier=value=>/^[A-Za-z0-9_.-]{1,80}$/.test(String(value||''))?String(value):'unknown';
export const EMPTY_RESULT_MESSAGE = 'The analysis finished without a usable answer. The requested conclusions could not be verified. Retry explicitly with the correlation ID.';
const prose = value => typeof value === 'string' && value.replace(/<[^>]*>/g,'').replace(/[\s#*_`|>-]/g,'') ? value : null;
export function normalizeOracleResult(input) {
  let result=input;
  for(let depth=0;depth<3;depth++) {
    if(typeof result==='string'){try{result=JSON.parse(result);}catch{result=null;}}
    if(!result||typeof result!=='object'||Array.isArray(result))return {};
    if(prose(result.answer)||result.evidence||result.presentation||result.artifact||result.clarification)break;
    const nested=result.result_json??result.result;
    if(nested===undefined)break;
    result=nested;
  }
  return result&&typeof result==='object'&&!Array.isArray(result)?result:{};
}
export function oracleResultContent(input,{artifactBase='/api/oracle/exports'}={}) {
  const result=normalizeOracleResult(input);
  const artifact=result.artifact;
  const artifactUrl=typeof artifact?.download_url==='string'?artifact.download_url:'';
  const artifactValid=Boolean(artifact && ['/api/oracle/exports','/agent/exports'].includes(artifactBase)&&artifactUrl.startsWith(artifactBase+'/')&&/^[a-f0-9]{64}$/.test(artifactUrl.slice(artifactBase.length+1)) && !['expired','unavailable','failed'].includes(artifact.status));
  const answer=prose(result.answer)||(result.presentation?.version==null||result.presentation.version===RESULT_VERSION?prose(result.presentation?.summary_markdown):null)||prose(result.clarification?.message)||prose(result.clarification);
  return {result,answer:answer||(artifactValid?'Your analysis download is ready.':EMPTY_RESULT_MESSAGE),deliverable:Boolean(answer||artifactValid),artifactValid,version:RESULT_VERSION};
}
