import { oracleResultContent, safeResultIdentifier } from './result-contract.js';
import { renderMarkdown } from './markdown.js';
import { placeInlineChart } from './inline-chart.js';

/** The same display path is used for immediate answers and recovered results. */
export function renderAnalyticalAnswer(target, message, result) {
  const content=oracleResultContent(result);result=content.result;
  const visible=['failed','cancelled'].includes(result.status)?`Analysis ${result.status}. Available partial result:\n\n${content.answer}`:content.answer;
  try{renderMarkdown(target,visible);}catch{target.textContent=visible;console.info('Oracle render outcome',{request_id:safeResultIdentifier(result.request_id),job_id:safeResultIdentifier(result.job_id),stage:'answer_render',status:'fallback',schema_version:content.version});}
  if(!target.textContent?.trim())target.textContent=visible;
  console.info('Oracle render outcome',{request_id:safeResultIdentifier(result.request_id),job_id:safeResultIdentifier(result.job_id),stage:'answer_render',status:'visible',schema_version:content.version,answer_present:true,artifact_present:content.artifactValid});
  const charts=Array.isArray(result.charts)&&result.charts.length?result.charts:[result.inline_chart];
  for(const chart of charts) {
    try { placeInlineChart(target,message,chart); }
    catch { /* Optional chart failure must leave the primary answer readable. */ }
  }
}
