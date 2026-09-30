import fs from 'node:fs';
import { HISTORICAL_PRODUCT_QUESTION } from '../oracle/historical-product-opportunity.js';

const file=process.argv.find(x=>x.startsWith('--result='))?.slice(9);
const base=process.argv.find(x=>x.startsWith('--url='))?.slice(6)?.replace(/\/$/,'');
if(base){
  const password=process.env.ORACLE_UI_PASSWORD;if(!password)throw new Error('ORACLE_UI_PASSWORD is required for --url');
  const login=await fetch(`${base}/api/oracle/auth/login`,{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({password})});
  const auth=await login.json(),cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');if(!login.ok)throw new Error('production diagnostic login failed');
  const requestId=`historical-opportunity-diagnostic-${Date.now()}`,headers={origin:base,cookie,'content-type':'application/json','x-csrf-token':auth.csrf,'x-request-id':requestId};
  const submitted=await fetch(`${base}/api/oracle/jobs`,{method:'POST',headers,body:JSON.stringify({message:HISTORICAL_PRODUCT_QUESTION})}),job=await submitted.json();if(!submitted.ok)throw new Error(`production diagnostic submission failed: ${job.code||submitted.status}`);
  const deadline=Date.now()+8*60_000;let outcome;while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,2_000));const response=await fetch(`${base}/api/oracle/jobs/${encodeURIComponent(job.job_id)}`,{headers:{cookie}});outcome=await response.json();if(['completed','failed','cancelled'].includes(outcome.status))break;}
  const diagnostic={diagnostic:'historical_product_opportunity_live',read_only_business_data:true,acceptance_question:HISTORICAL_PRODUCT_QUESTION,request_id:requestId,job_id:job.job_id,status:outcome?.status||'diagnostic_timeout',authoritative_outcome:outcome?.error||outcome?.progress||null};console.log(JSON.stringify(diagnostic,null,2));if(outcome?.status!=='completed')process.exitCode=1;process.exit();
}
if(!file)throw new Error('Usage: node diagnostics/historical-product-opportunity-production.js --url=https://SERVICE.onrender.com (live) OR --result=/path/to/tool-result.json (offline validator)');
const result=JSON.parse(fs.readFileSync(file,'utf8'));
const failures=[];
if(result.observation_windows?.shopify?.start_date!=='2025-11-20')failures.push('wrong public launch boundary');
if(result.trace?.tool_choice!=='get_historical_product_opportunities')failures.push('wrong tool choice');
if(result.trace?.join_policy!=='approved_identity_or_reporting_family_only')failures.push('ungoverned join');
if(result.money?.currencies_separate!==true)failures.push('currencies not separate');
if(!result.coverage||!Array.isArray(result.rows))failures.push('missing bounded evidence/coverage');
const stages=result.coverage?.stages;
if(!stages)failures.push('missing staged join counts');
if(result.coverage?.retrieval?.full_population!==true)failures.push('retrieval is a pagination sample, not the mapped population');
if(stages&&stages.complete_three_way_join?.total!==result.coverage.complete_join_candidates)failures.push('complete join count does not reconcile');
if(stages&&stages.eligible_mappings?.total>(stages.active_identity_mappings?.total+stages.active_reporting_family_mappings?.total))failures.push('eligible mappings exceed active governed mappings');
if(stages&&stages.mapping_intersect_inventory?.total>stages.mapped_shopify_parent_ids?.total)failures.push('inventory intersection exceeds mapped parents');
if(stages&&!stages.mapping_intersect_exact_positive_online_stock)failures.push('missing exact Online stocked-variant intersection');
if(result.coverage?.retrieval?.mapping_read?.same_active_records_as_product_mapping_ui!==true)failures.push('mapping read is not verified against Product Mapping UI active-state resolvers');
if(!result.coverage?.join_diagnostics?.identifier_examples)failures.push('missing safe typed join identifier examples');
for(const row of result.rows||[])if(!row.stocked_variants?.some(v=>v.online_available>0)||!row.mapping_provenance?.every(x=>['explicit_governed_mapping','governed_product_family'].includes(x)))failures.push(`invalid ranked row ${row.product_ref||'unknown'}`);
const diagnostic={diagnostic:'historical_product_opportunity',read_only:true,acceptance_question:HISTORICAL_PRODUCT_QUESTION,valid:failures.length===0,failures,trace:result.trace,stages,join_diagnostics:result.coverage?.join_diagnostics,join_failure_examples:result.coverage?.join_failure_examples||[],retrieval:result.coverage?.retrieval,windows:result.observation_windows};
console.log(JSON.stringify(diagnostic,null,2));if(failures.length)process.exitCode=1;
