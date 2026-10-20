#!/usr/bin/env node
import {safeReadFailure} from '../oracle/read-failure.js';
import {pathToFileURL} from 'node:url';
import {loadBigQueryConfig,createBigQueryClient} from '../bigquery/client.js';
import {options} from './collect.js';
import {preflight,provision,setup,enrich,verify,publish,selectedIds,verifyLinkage,activationCheck} from './operations.js';

export async function main(argv=process.argv.slice(2),env=process.env) {
  const [command,...raw] = argv;
  if (!['plan','preflight','provision','setup','enrich','verify','verify-linkage','activation-check','publish'].includes(command)) throw Error('Select plan/preflight/setup/enrich/verify/publish');
  const snapshotArg = raw.find(a=>a.startsWith('--snapshot='));
  const snapshot = snapshotArg?.slice('--snapshot='.length);
  if (snapshotArg && !['publish','activation-check'].includes(command)) throw Error('Snapshot only valid for publication');
  if (['publish','activation-check'].includes(command) && !/^[A-Za-z0-9_-]{1,100}$/.test(snapshot||'')) throw Error('Explicit snapshot ID required');
  const args = raw.filter(a=>a!==snapshotArg);
  if (!args.some(a=>a.startsWith('--source='))) {
    if (['provision','setup','verify-linkage','activation-check','publish'].includes(command)) args.push('--source=ww');
    else throw Error('Explicit source required');
  }
  const o=options(args), writes=['provision','setup','enrich','publish'].includes(command);
  if (writes!==o.apply) throw Error('Writes require --apply; read-only operations reject it');
  const {bigquery,project}=createBigQueryClient(env);
  if(command==='plan')return {read_only:true,source:o.source,selected_orders:(await selectedIds(bigquery,project,o)).length,scope:{start:o.start,end:o.end}};
  if(command==='preflight'){
    const result=await preflight({bigquery,project,o,env});
    if(!result.destination?.ready||result.source_access!=='sampled'||!result.location_matches)process.exitCode=2;
    return result;
  }
  if(command==='provision')return provision({bigquery,project,dataset:o.dataset,principal:loadBigQueryConfig(env).credentials?.client_email});
  if(command==='setup')return setup({bigquery,project,dataset:o.dataset});
  if(command==='enrich')return enrich({bigquery,project,o,env});
  if(command==='verify-linkage')return verifyLinkage({bigquery,project,dataset:o.dataset});
  if(command==='activation-check'){const result=await activationCheck({bigquery,project,dataset:o.dataset,snapshot,env});if(!result.valid)process.exitCode=1;return result;}
  if(command==='verify') {
    const result=await verify({bigquery,project,o});
    if(!result.valid)process.exitCode=1;
    return result;
  }
  return publish({bigquery,project,dataset:o.dataset,snapshot});
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().then(result=>console.log(JSON.stringify(result))).catch(error=>{
  console.error(JSON.stringify({status:'failed',message:'Identity operation failed; no customer values logged',failure:safeReadFailure(error,'diagnostic')}));process.exitCode=1;
});
