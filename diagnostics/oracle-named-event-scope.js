// Bounded read-only production-factory diagnostic. Never logs prompts, provider
// bodies, knowledge descriptions, credentials, customer rows or raw identities.
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createBigQueryClient} from '../bigquery/client.js';
import {createKnowledgeService} from '../oracle/knowledge-bigquery.js';
import {createHistoricalEventDependencies} from '../oracle/historical-event-provider.js';
import {createOracleBaselineDispatcher} from '../oracle/baseline-dispatcher.js';
import {executeGovernedAgentAnalysis} from '../oracle/analysis-route-dispatcher.js';
import {boundedEvidenceRead} from '../oracle/bounded-evidence-read.js';
const question='Can you compare teh sales of the last 3 black friday sale periods';
const hash=x=>createHash('sha256').update(String(x)).digest('hex').slice(0,16);
export async function inspectNamedEventScope({env=process.env,execute=false,write=x=>console.log(JSON.stringify(x)),now=()=>new Date()}={}){
  const bounds={maximum_queries:8,maximum_bytes_per_query:1_000_000_000,deadline_ms:25000};
  if(!execute){write({read_only:true,status:'plan',...bounds});return;}
  let queries=0;const deadline=Date.now()+bounds.deadline_ms;
  const {bigquery,project}=createBigQueryClient(env);
  const guarded={query:async q=>{
    if(++queries>bounds.maximum_queries||Date.now()>=deadline||!/^\s*(SELECT|WITH)\b/i.test(q.query))throw Object.assign(Error('Bound'),{code:'DIAGNOSTIC_BOUND'});
    return boundedEvidenceRead(()=>bigquery.query({...q,maximumBytesBilled:String(bounds.maximum_bytes_per_query),jobTimeoutMs:Math.min(10000,deadline-Date.now())}),{maximumMs:Math.max(1,Math.min(12000,deadline-Date.now()))});
  }};
  const knowledgeService=createKnowledgeService({bigquery:guarded,project,dataset:env.ORACLE_KNOWLEDGE_DATASET||'oracle_knowledge'});
  const {historicalEventComparison}=createHistoricalEventDependencies({bigquery:guarded,project,knowledgeService,now});
  try{
    const r=await boundedEvidenceRead(()=>executeGovernedAgentAnalysis({message:question,baselineOverview:createOracleBaselineDispatcher({historicalEventComparison}),now:now().getTime(),baselineOptions:{onProviderStage:stage=>{if(stage.stage==='evidence_validation')write({read_only:true,...stage});}}}),{maximumMs:bounds.deadline_ms});
    const e=r.evidence;
    write({read_only:true,status:r.partial?'partial':'validated',queries,delivery:r.delivery?.status,period_structure:e?.analytical_plan?.event_selection?.period_structure,selected:e?.resolved_scope?.events.map(ev=>({identity_hash:hash(ev.id),start_date:ev.start_date,end_date:ev.end_date,duration_days:ev.duration_days,phases:ev.phases.length})),missing:e?.resolved_scope?.missing.map(x=>({year:x.year})),invalid_records:e?.resolved_scope?.invalid.length,sources:e?.sections.flatMap(s=>(s.report?.source_components||[]).map(c=>({event_hash:hash(s.event.id),platform:c.platform,status:c.status,error_code:c.error_code,actual_period:c.evidence?.period,actual_source_scope:c.evidence?.source_scope,currencies:[...new Set((c.evidence?.rows||[]).map(r=>r.currency))],aggregate_rows:c.evidence?.rows?.length}))),production_delivery:'not_verified; diagnostic only'});
  }catch(error){write({read_only:true,status:'unverified',queries,code:/^[A-Z0-9_]{1,64}$/.test(String(error.code))?String(error.code):'DEPENDENCY_READ_FAILED',scope_field:error.scope_field||null,scope_differences:error.scope_differences||[],production_delivery:'not_verified'});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const timer=setTimeout(()=>{console.log(JSON.stringify({read_only:true,status:'unverified',code:'DIAGNOSTIC_DEADLINE'}));process.exit(1);},27000);
  inspectNamedEventScope({execute:process.argv.includes('--execute-read-only')}).catch(()=>{console.log(JSON.stringify({read_only:true,status:'unverified',code:'CONFIGURATION_UNAVAILABLE'}));process.exitCode=1;}).finally(()=>clearTimeout(timer));
}
