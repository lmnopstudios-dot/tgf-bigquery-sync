import fs from 'node:fs';
import { HISTORICAL_PRODUCT_QUESTION } from '../oracle/historical-product-opportunity.js';

const file=process.argv.find(x=>x.startsWith('--result='))?.slice(9);
if(!file)throw new Error('Usage: node diagnostics/historical-product-opportunity-production.js --result=/path/to/read-only-tool-result.json');
const result=JSON.parse(fs.readFileSync(file,'utf8'));
const failures=[];
if(result.observation_windows?.shopify?.start_date!=='2025-11-20')failures.push('wrong public launch boundary');
if(result.trace?.tool_choice!=='get_historical_product_opportunities')failures.push('wrong tool choice');
if(result.trace?.join_policy!=='approved_identity_or_reporting_family_only')failures.push('ungoverned join');
if(result.money?.currencies_separate!==true)failures.push('currencies not separate');
if(!result.coverage||!Array.isArray(result.rows))failures.push('missing bounded evidence/coverage');
for(const row of result.rows||[])if(!row.stocked_variants?.some(v=>v.online_available>0)||!row.mapping_provenance?.every(x=>['explicit_governed_mapping','governed_product_family'].includes(x)))failures.push(`invalid ranked row ${row.product_ref||'unknown'}`);
const diagnostic={diagnostic:'historical_product_opportunity',read_only:true,acceptance_question:HISTORICAL_PRODUCT_QUESTION,valid:failures.length===0,failures,trace:result.trace,coverage:result.coverage,windows:result.observation_windows};
console.log(JSON.stringify(diagnostic,null,2));if(failures.length)process.exitCode=1;
