import {withOracleCharts} from './evidence-charts.js';
import {reportWorkbook} from './report-export.js';
import {priorityArtifactId} from './product-priority-storage.js';
import {createHash} from 'node:crypto';
import {evidenceNumber} from './numeric-evidence.js';
const esc=v=>String(v?.value??v??'Unavailable').replaceAll('|','\\|').replace(/[\r\n]/g,' ').replaceAll('<','&lt;').replaceAll('>','&gt;').slice(0,240);
const n=v=>evidenceNumber(v)==null?'Unavailable':evidenceNumber(v).toLocaleString('en-GB',{maximumFractionDigits:2});
const label=r=>r.campaign_name||r.adset_name||r.ad_name||r.destination_url||r.creative_id||r.report_month?.value||r.report_month||r.resource_id||r.account_name||r.account_id;
const table=(headers,rows)=>rows.length?['| '+headers.join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |',...rows.slice(0,12).map(r=>'| '+r.map(esc).join(' | ')+' |')].join('\n'):null;
export function socialBusinessView(e){
 const ig=e.subject==='instagram',rows=e.rows||[],lines=[rows.length?ig?rows.some(r=>r.availability==='available')?'Available Instagram native observations are shown below.':`Instagram ${e.selected_metric} evidence is unsupported or unavailable for this scope; missing evidence is not zero.`:'Meta spend and native attributed purchase performance are shown below.':`${ig?'Instagram':'Meta'} evidence is unavailable for this scope. Missing evidence does not establish zero activity.`];
 lines.push(ig?table(['Account','Content / date','Metric','Value','Evidence kind','Availability','Observed at'],rows.map(r=>[r.account_id,r.permalink||r.report_date||r.publication_at,e.selected_metric,n(r.value),r.evidence_kind,r.availability,r.observed_at])):table(['Account','Group','Currency','Spend','Attributed purchases','Attributed value','Purchase CPA','ROAS'],rows.map(r=>[r.account_name||r.account_id,[label(r),r.breakdown_json&&r.breakdown_json!=='{}'?r.breakdown_json:null,r.comparison_period].filter(Boolean).join(' · '),r.currency,n(r.spend),n(r.purchase_count),n(r.purchase_value),n(r.cpa),n(r.roas)])));
 if(ig&&e.selected_metric==='profile_activity')lines.push('Native profile activity does not establish website sessions or sales; supported action breakdowns and definitions are in Show details.');
 if(!ig&&['creative','destination'].includes(e.social_scope?.group_by))lines.push('Creative formats and destination URLs are current native observations; their historical applicability is unverified.');
 if(e.limited)lines.push('The result is bounded; the displayed ranking may omit other rows.');
 if(ig)lines.push(e.social_scope?.scope==='account'?'Account figures preserve native daily buckets, exact windows and observation-date snapshots. Reach, followers and audience snapshots are not additive across days; paid versus organic scope remains unverified.':'Media rankings select publication dates and show current lifetime totals, not activity during those dates. Paid versus organic scope and unavailable historical metrics remain unverified.');
 else lines.push('Attributed purchases are not verified first-time customers, and attributed value is not incremental revenue. Reach and frequency are unavailable for this period.');
 if(e.sections?.some(s=>!s.coverage?.complete))lines.push('Collection coverage is incomplete or unverified. Available evidence is shown; missing figures are not zero.');
 if(e.sections?.some(s=>s.coverage?.unresolved_failed_attempts))lines.push('Some collection or attribution-refresh attempts failed; retained evidence may be stale.');
 if(e.sections?.some(s=>s.coverage?.configuration_scope_verified===false))lines.push('Account scope includes stored accounts; the complete configured account population is unverified.');
 if(e.comparison_compatible===false)lines.push('Comparison populations or attribution contracts differ; a like-for-like change is unverified.');
 return lines.filter(Boolean);
}
export async function answerSocialAnalysis({context,provider,exportStore=null,exportOwner=null,requestId=null,onProviderStage,now=()=>new Date()}){
 const subject=context.requested_subject,ig=subject==='instagram',scope=context.social_scope,periods=[{start_date:context.start_date,end_date:context.end_date},...(context.comparison_start_date?[{start_date:context.comparison_start_date,end_date:context.comparison_end_date}]:[])];
 if(!provider||!scope)throw Object.assign(new Error('Meta/Instagram governed binding unavailable'),{code:'SOCIAL_BINDING_UNAVAILABLE'});
 if(context.output_preference==='xlsx'){
   if(!exportStore||!exportOwner||!requestId)throw Object.assign(new Error('Governed export ownership/storage required'),{code:'SOCIAL_EXPORT_BINDING_UNAVAILABLE'});
   const id=priorityArtifactId(exportOwner,requestId),saved=await exportStore.get(id,exportOwner);
   if(saved){if(saved.envelope.subject!==subject||JSON.stringify(saved.envelope.social_scope)!==JSON.stringify(scope)||JSON.stringify(saved.envelope.periods)!==JSON.stringify(periods))throw Object.assign(new Error('Export request scope conflict'),{code:'EXPORT_SCOPE_CONFLICT'});return {answer:saved.answer,tools:[context.tool_route],evidence:saved.envelope,artifact:{id,filename:saved.filename,row_count:saved.envelope.rows.length,download_url:`/api/oracle/exports/${id}`}};}
 }
 const sections=[];
 for(const period of periods){const args={...period,account_id:scope.account_id,limit:context.limit||100,...(ig?{scope:scope.scope,metric:scope.metric,media_type:scope.media_type}:{group_by:scope.group_by,breakdown:scope.breakdown,sort_metric:scope.metric,sort_direction:scope.sort_direction})};onProviderStage?.({stage:'social_evidence',status:'started',provider:context.tool_route,...period});const result=await provider(context.tool_route,args);sections.push({period,...result});}
 const rows=sections.flatMap((s,i)=>s.rows.map(r=>({...r,...(sections.length>1?{comparison_period:`${periods[i].start_date} to ${periods[i].end_date}`}:{})}))),contract=s=>[...new Set(s.rows.map(r=>[r.account_id,r.currency,r.attribution_contract_id||r.profile_key,r.evidence_kind||''].join('|')))].sort().join(';'),compatible=sections.length===1||(!ig&&sections.every(s=>s.coverage?.complete)&&contract(sections[0])===contract(sections[1]));
 const e={kind:'governed_social',subject,metrics:[subject],periods,comparison_type:context.comparison_type,comparison_compatible:compatible,social_scope:scope,selected_metric:scope.metric,rows,sections,limited:sections.some(s=>s.limited),definitions:sections.map(s=>s.definitions),limitations:[...new Set(sections.flatMap(s=>s.limitations||[]))],historical_metric_coverage_verified:sections.every(s=>s.historical_metric_coverage_verified),generated_at:now().toISOString()};
 const provenance=JSON.stringify({scope,periods,coverage:sections.map(s=>s.coverage),definitions:e.definitions,limitations:e.limitations},null,2).replaceAll('`','\\u0060');
 const answer=socialBusinessView(e).join('\n\n')+`\n\n<details>\n<summary>Show details</summary>\n\nNative metric definitions, coverage, attribution and collection provenance\n\n\`\`\`json\n${provenance}\n\`\`\`\n\n</details>`;
 e.chart_datasets=[{id:`${subject}-${scope.metric}`,shape:sections.length>1?'comparison':'ranking',compatible,title:ig?`Instagram ${scope.metric} observations`:`Meta ${scope.metric}`,period:periods.map(p=>`${p.start_date} to ${p.end_date}`).join(' versus '),metric:scope.metric,unit:scope.metric==='roas'?'ratio':ig||scope.metric==='purchase_count'?'count':'money',definition:ig?'Native current lifetime media totals or account observations; not reconstructed period activity':scope.metric==='cpa'?'Aggregate spend / selected native attributed purchases':scope.metric==='roas'?'Native attributed purchase value / aggregate spend':'Native additive Meta evidence; not incremental revenue',source:'Governed persisted Meta/Instagram',bounded:true,direction:scope.sort_direction,points:rows.map(r=>({id:r.ad_id||r.campaign_id||r.resource_id||r.account_id,label:label(r),currency:!ig&&!['purchase_count','roas'].includes(scope.metric)?r.currency:null,value:ig?r.value:r[scope.metric],series:r.comparison_period,population:[r.account_id,r.currency||'',r.attribution_contract_id||r.profile_key,r.evidence_kind||''].join('|')}))}];
 const result=withOracleCharts({answer,tools:[context.tool_route],evidence:e});
 if(context.output_preference==='xlsx'){
   const id=priorityArtifactId(exportOwner,requestId);
   const bytes=Buffer.from(await reportWorkbook({generated_at:e.generated_at,kpis:rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v&&typeof v==='object'?(v.value??JSON.stringify(v)):v]))),period:periods[0],comparison:periods[1]||periods[0],limitations:e.limitations,context:sections.map(s=>({start:s.period.start_date,end:s.period.end_date,coverage_complete:s.coverage?.complete,definitions:JSON.stringify(s.definitions)}))})),filename=ig?'oracle-instagram-evidence.xlsx':'oracle-meta-evidence.xlsx';
   await exportStore.put(id,exportOwner,{answer,envelope:result.evidence,filename,sha256:createHash('sha256').update(bytes).digest('hex'),xlsx_base64:bytes.toString('base64')});
   result.artifact={id,filename,row_count:rows.length,download_url:`/api/oracle/exports/${id}`};
 }
 return result;
}
