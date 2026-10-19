import { ANALYTICAL_CAPABILITIES } from './analytical-capabilities.js';
import { oracleResultContent } from '../public/oracle/result-contract.js';
// Shared terminal accounting. Intent metadata never proves delivery. Failures
// are explicit and retain successful evidence and persisted artifacts.
export function componentOutcomes(context,result,{artifactBase='/api/oracle/exports'}={}){
  const e=result?.evidence;
  context=context||{requested_operations:e?.analytical_plan?.requested_operations||[],request_detail:e?.detail,output_preference:e?.report_config?.output_format||e?.analytical_plan?.presentation?.format};
  const outcomes=(context?.requested_operations||[]).map(operation=>{
    const executed=e?.components?.find(c=>c.operation===operation);
    return {component:operation,status:executed?({supported:'delivered',conditional:'partially_delivered',unavailable:'unsupported',blocked:'unsupported'}[executed.status]||executed.status):result?.analysis_unavailable?'unsupported':'failed',detail:executed?.detail||executed?.blocker||'No compatible executed component was recorded.'};
  });
  if(e?.kind==='governed_cohort_retention')for(const item of e.source_outcomes||[])outcomes.push({component:`cohort_${item.source_store}_${item.group}`,status:item.state==='fulfilled'?'delivered':item.state==='not_attempted'?'not_attempted':'failed',detail:item.status,request_id:e.request_id});
  const requested=context?.request_detail;
  if(requested&&e?.kind==='governed_basket_composition'){
    const sections=requested.subset?.exclude_sale?e.sections.filter(s=>s.label==='Exclusion comparison'):e.sections;
    const status=e.retrieval_failed?'failed':!sections.length?'unsupported':'delivered';
    for(const component of [...(requested.subset?['basket_subset']:[]),...(requested.bands?['basket_total_bands']:[]),...(requested.overlap?['highest_unit_interval']:[]),...(requested.level==='detail'?['product_combinations']:[])])outcomes.push({component,status,detail:status==='delivered'?'Calculated directly from reconciled basket membership.':'Compatible basket evidence or exclusion dates are unavailable.'});
    if(requested.level==='underlying')outcomes.push({component:'anonymous_basket_rows',status:oracleResultContent(result,{artifactBase}).artifactValid&&Array.isArray(e.anonymous_rows)?'delivered':'failed',detail:'Anonymous allowlisted rows require a persisted workbook.'});
  }
  const supportedFormats=ANALYTICAL_CAPABILITIES[context?.tool_route]?.delivery;
  const unsupportedFormat=format=>Array.isArray(supportedFormats)&&!supportedFormats.includes(format);
  const formats=new Set([...(context?.requested_formats||[]),...(context?.request_detail?.formats||[]),...(['xlsx','chart'].includes(context?.output_preference)?[context.output_preference]:[])]);
  if(formats.has('xlsx'))outcomes.push({component:'xlsx',status:oracleResultContent(result,{artifactBase}).artifactValid?'delivered':result?.export_outcome?.status==='failed'?'failed':result?.analysis_unavailable||unsupportedFormat('xlsx')?'unsupported':'failed',detail:result?.export_outcome?.detail||(!result?.artifact?'No persisted workbook download is available.':'Owner-scoped persisted workbook download.')});
  if(formats.has('chart'))outcomes.push({component:'chart',status:result?.charts?.length?'delivered':result?.analysis_unavailable||unsupportedFormat('chart')?'unsupported':'failed',detail:result?.charts?.length?'Validated evidence chart.':'No compatible chart was delivered.'});
  return result?.clarification?.fields?.length?outcomes.map(c=>({...c,status:'blocked_by_clarification',detail:'Execution requires: '+result.clarification.fields.join(', ')})):outcomes;
}
export function accountForDelivery(result,context,{artifactBase='/api/oracle/exports'}={}){
  const components=componentOutcomes(context,result,{artifactBase});
  if(!components.length)return result;
  const failed=components.filter(c=>c.status!=='delivered');
  let answer=result.answer||'';
  const notices=components.filter(c=>['xlsx','chart'].includes(c.component)&&c.status!=='delivered').map(c=>`${c.component.toUpperCase()}: ${c.status}. ${c.detail}`);
  if(notices.length&&!answer.includes(notices.join('\n')))answer+='\n\n'+notices.join('\n');
  if(oracleResultContent(result,{artifactBase}).artifactValid&&!answer.includes(result.artifact.download_url))answer+=`\n\n[Download XLSX](${result.artifact.download_url})`;
  return {...result,answer,component_outcomes:components,partial:Boolean(result.partial||failed.length)};
}
