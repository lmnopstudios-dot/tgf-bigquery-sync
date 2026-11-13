// Bounded retained-data diagnostic, aggregate-only; no source collection or exports.
import {createBigQueryClient} from '../bigquery/client.js';
import {loadLoyaltyConfig} from '../loyaltylion/runtime-config.js';
import {createLoyaltyReportService} from '../oracle/loyaltylion.js';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
const [start,end]=process.argv.slice(2);
if(!/^\d{4}-\d{2}-\d{2}$/.test(start||'')||!/^\d{4}-\d{2}-\d{2}$/.test(end||'')||start>end||Date.parse(end)-Date.parse(start)>366*86400000)throw Error('Bounded YYYY-MM-DD dates required');
try{
 const {bigquery,project}=createBigQueryClient(),config=loadLoyaltyConfig();
 const context=transitionAnalysisContext(null,`LoyaltyLion performance report from ${start} through ${end}`).context;
 const provider=createLoyaltyReportService({bigquery,project,config,env:{...process.env,LOYALTYLION_REPORTING_ENABLED:'true'}});
 const e=await provider(context,{deadlineAt:Date.now()+110000,signal:AbortSignal.timeout(110000)});
 console.log(JSON.stringify({read_only:true,warehouse_writes:false,source_collection:false,start,end,snapshot_observed_at:e.snapshot_observed_at,sections:e.sections.map(s=>({section:s.section,status:s.status,code:s.code,aggregate_rows:s.rows.length})),performance:e.performance?.tables.map(s=>({section:s.section,status:s.status,code:s.code,aggregate_rows:s.rows.length,...(s.section==='linkage'?{outcomes:s.rows}:{})}))}));
}catch{console.error(JSON.stringify({read_only:true,status:'validation_unavailable'}));process.exitCode=1;}
