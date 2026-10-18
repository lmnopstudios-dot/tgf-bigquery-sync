// Read-only request-to-plan probe. Does not start a server or execute providers.
import {readFileSync} from 'node:fs';
import {transitionAnalysisContext} from '../oracle/analysis-context.js';
import {resolveExecutionPlan} from '../oracle/analytical-capabilities.js';
import {createOracleProviderDependencies} from '../oracle/provider-dependencies.js';
const questions=JSON.parse(readFileSync(new URL('../test/fixtures/oracle-basket-incidents.json',import.meta.url)));
const providers=createOracleProviderDependencies();
const now=Date.parse('2026-10-18T12:00:00Z');
const checks=questions.map((message,index)=>{
 let stage='planning';
 try{
  const context=transitionAnalysisContext(null,message,{now}).context;
  const execution=resolveExecutionPlan(context);
  stage='serialization';const wire=JSON.parse(JSON.stringify(context));
  if(wire.start_date!=='2026-01-01'||wire.end_date!=='2026-10-17'||wire.request_detail?.bands?.length!==4||wire.request_detail?.bands?.at(-1).upper!==null||wire.request_detail?.overlap?.lower!==20000||wire.request_detail?.subset?.total_at_least!==25000||execution.limitation)throw Error('Scope contract failed');
  return {incident:index+1,status:'fulfilled',stages:['planning','serialization'],route:wire.tool_route,report:{start_date:wire.start_date,end_date:wire.end_date},exclusions:wire.promotion_context.supplied_periods,detail:wire.request_detail,production_basket_binding:typeof providers.basketComposition==='function'};
 }catch{return {incident:index+1,status:'rejected',failed_stage:stage};}
});
console.log(JSON.stringify({read_only:true,provider_calls:0,scope_runtime:new Date(now).toISOString(),deployed_revision:process.env.RENDER_GIT_COMMIT||null,checks},null,2));
if(checks.some(c=>c.status!=='fulfilled'))process.exitCode=1;
