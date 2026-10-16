import { boundedEvidenceRead } from './bounded-evidence-read.js';
import { applyJourneyAnalysisContext } from './customer-journey.js';

// Projection of the existing journey contract. No second customer identity or
// classification model is introduced here.
export function retentionIntent(text){
  return /\bcollaborations?\b/i.test(text) && /\b(?:retention|repeat|return(?:ing)? customers?|return purchases?)\b/i.test(text);
}
export function retentionDefinition(context){
  return {...applyJourneyAnalysisContext({},context),group_by:['retention_windows'],
    cohort:{entry_product_classification:context.entry_product_classification||'collaboration',entry_channel:context.channel==='instore'?'In-store':context.channel==='online'?'Online':null},
    subsequent:{channel:context.channel==='instore'?'In-store':context.channel==='online'?'Online':null},
    sort:'repeat_rate_desc',limit:100};
}
export function retentionRows(rows){
  if(!Array.isArray(rows)||rows.length>100)throw new Error('Retention row bound exceeded');
  return rows.map(row=>{
    const count=key=>{const n=Number(row[key]);if(row[key]===null||row[key]===undefined||typeof row[key]==='boolean'||row[key]===''||!Number.isInteger(n)||n<0)throw new Error('Invalid retention count');return n;};
    const cohort_customers=count('cohort_customers'),mature_customers=count('mature_customers'),repeat_customers=count('repeat_customers');
    if(repeat_customers>mature_customers||mature_customers>cohort_customers||![90,180].includes(Number(row.window_days)))throw new Error('Invalid retention denominator');
    const median=row.median_days_to_second==null?null:Number(row.median_days_to_second);
    if(median!==null&&(!Number.isFinite(median)||median<0||median>Number(row.window_days))||repeat_customers===0&&median!==null||repeat_customers>0&&median===null)throw new Error('Invalid conditional retention median');
    if(!['woo','shopify'].includes(row.source_platform)||!row.source_store||!row.collaboration_name)throw new Error('Missing retention population');
    return {source_platform:row.source_platform,source_store:row.source_store,collaboration_name:row.collaboration_name,window_days:Number(row.window_days),cohort_customers,mature_customers,repeat_customers,repeat_rate:mature_customers?repeat_customers/mature_customers:null,median_days_to_second:median,small_sample:mature_customers<30};
  }).sort((a,b)=>a.source_platform.localeCompare(b.source_platform)||a.source_store.localeCompare(b.source_store)||a.window_days-b.window_days||(b.repeat_rate??-1)-(a.repeat_rate??-1)||b.mature_customers-a.mature_customers||a.collaboration_name.localeCompare(b.collaboration_name));
}
const safe=value=>String(value).replaceAll('|','\\|').replaceAll('<','&lt;').replaceAll('>','&gt;');
export function retentionMarkdown(e){
  const rows=e.rows||[];
  const findings=[];
  const sources=[...new Set(rows.map(r=>r.source_platform+'/'+r.source_store))];
  for(const source of sources){
    const candidates=rows.filter(r=>r.source_platform+'/'+r.source_store===source&&r.window_days===Math.max(...rows.filter(r=>r.source_platform+'/'+r.source_store===source).map(r=>r.window_days))&&r.repeat_rate!==null);
    if(!candidates.length)continue;
    const best=Math.max(...candidates.map(r=>r.repeat_rate)),leaders=candidates.filter(r=>r.repeat_rate===best),first=leaders[0];
    const label=source==='woo/ww'?'Woo UK':source==='woo/usd'?'Woo US':source==='shopify/shopify'?'Shopify':source;
    findings.push(`Among retrieved ${safe(label)} cohorts, **${leaders.map(r=>safe(r.collaboration_name)).join(' and ')}** ${leaders.length>1?'tie for':'has'} the highest ${first.window_days}-day repeat purchase rate: **${(best*100).toFixed(2)}%**${leaders.length===1?` (${first.repeat_customers} of ${first.mature_customers} mature customers)`:''}.`);
  }
  const lines=[findings.length?findings.join(' '):rows.length?'No retrieved cohort has a mature retention denominator. A repeat purchase ranking is unavailable.':'No classified first-observed collaboration cohorts were retrieved. This does not establish zero customers or zero retention.'];
  if(rows.length)lines.push(['| Source | Collaboration | Days | Cohort | Mature | Repeat | Rate | Median days to second |','|---|---|---|---|---|---|---|---|',...rows.map(r=>`| ${safe(r.source_platform+'/'+r.source_store)} | ${safe(r.collaboration_name)}${r.small_sample?' *':''} | ${r.window_days} | ${r.cohort_customers} | ${r.mature_customers} | ${r.repeat_customers} | ${r.repeat_rate===null?'Unavailable':(r.repeat_rate*100).toFixed(2)+'%'} | ${r.median_days_to_second??'Unavailable'} |`)].join('\n'));
  lines.push('<details><summary>Show details</summary>\n\n'+[
    `Cohort entry: ${e.periods[0].start_date} to ${e.periods[0].end_date}; observation ends ${e.observation_end} (UTC order dates).`,
    'First observed in all available governed history, with lookback before entry dates. Prior collection coverage is unverified; first-ever purchases are not established.',
    'The first eligible identified order must contain a governed collaboration. Each collaboration on a multi-collaboration entry order receives that customer; cohorts overlap and must not be added.',
    'Mature denominators include only entries with the full 90/180 calendar days available before the observation cutoff. The numerator measures any subsequent eligible purchase in the requested channel, rather than another purchase of the same collaboration. Median days is conditional on a qualifying second purchase within the mature window.',
    'A company-wide winning collaboration cannot be established. Woo UK, Woo US and Shopify customer identities remain separate. Migrated Shopify imports are excluded using the existing Matrixify rule; no deterministic cross-platform customer bridge is persisted. Unknown guests are excluded. No money is combined.',
    '* indicates fewer than 30 mature customers. Sample size and incomplete history limit comparisons. These are associations, not causal effects.',
    'Empty source periods and absent classifications are missing evidence, not zero-filled history. Full source/classification coverage and the company-wide ranking remain unverified.',
    ...(e.truncated?['The 100-row bound was reached. Rankings may be incomplete; narrow the cohort scope.']:[])
  ].join('\n\n')+'\n\n</details>');return lines.join('\n\n');
}
export async function answerCohortRetention({context,provider,...options}){
  if(!provider)return {answer:'The governed customer-journey provider is unavailable; no sales report was substituted.',analysis_unavailable:true,analysis_context:context,tools:[]};
  const definition=retentionDefinition(context);
  const result=await boundedEvidenceRead(timeoutMs=>provider.analyzeCustomerJourney(definition,{timeoutMs}),options);
  const rows=retentionRows(result.results||[]).filter(row=>!context.within_days||row.window_days===context.within_days);
  const evidence={kind:'governed_cohort_retention',subject:'customer_journey',operation:'cohort_retention',periods:[{start_date:context.start_date,end_date:context.end_date}],observation_end:definition.observation_end,definition:result.definition,rows,truncated:(result.results||[]).length===100,coverage:{complete:false,identity:'source_qualified_only',prior_history:'unverified'}};
  return {answer:retentionMarkdown(evidence),evidence,analysis_context:context,partial:true,...(!rows.length?{analysis_unavailable:true}:{}),tools:['analyze_customer_journey']};
}
