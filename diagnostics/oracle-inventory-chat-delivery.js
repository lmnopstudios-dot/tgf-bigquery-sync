// Deployment, HTTP planning and optional live job/download validation are
// separate checks. No Shopify mutation; no model/tool retry or POST replay.
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import {filteredInventoryScope,inventoryReportConfigKey,resolveInventoryGroups} from '../oracle/inventory-report-config.js';
const REQUIRED_405='93a6822769069aca6a572a4bf7c84a7ba179e7bf';
const token=v=>/^[A-Za-z0-9_.:-]{1,100}$/.test(String(v??''))?String(v):null;
const failure=code=>Object.assign(new Error(code),{code});
export function deploymentContains405(revision){
 if(!/^[0-9a-f]{40}$/.test(revision||''))return null;if(revision===REQUIRED_405)return true;
 const cwd=fileURLToPath(new URL('..',import.meta.url)),git=(...args)=>spawnSync('git',args,{cwd,stdio:'ignore'});
 if(git('cat-file','-e',REQUIRED_405+'^{commit}').status!==0||git('cat-file','-e',revision+'^{commit}').status!==0)return null;
 return git('merge-base','--is-ancestor',REQUIRED_405,revision).status===0;
}
export async function validateInventoryChatDelivery({message,origin,password,execute=false,output='/tmp/oracle-inventory-multiline.xlsx',fetchImpl=fetch,emit=()=>{},write=writeFile,contains405=deploymentContains405,pause=ms=>new Promise(r=>setTimeout(r,ms)),maxPolls=600}={}){
 let stage='deployment',requestId=null;
 const json=async(url,options={})=>{const r=await fetchImpl(url,{...options,signal:AbortSignal.timeout(30000)});let data;try{data=await r.json();}catch{throw failure('NON_JSON_SERVICE_RESPONSE');}if(!r.ok)throw Object.assign(failure(token(data.code)||'SERVICE_HTTP_FAILED'),{http_status:r.status});return{data,response:r};};
 try{
  const {data:health}=await json(origin+'/'),revision=token(health.revision),ancestor=contains405(revision);emit({stage,status:'read',running_revision:revision,contains_405:ancestor});
  stage='request_scope';const expected=filteredInventoryScope(message)?.inventory_report;if(!expected)throw failure('INVENTORY_SCOPE_UNRESOLVED');
  stage='authentication';if(!password)throw failure('UI_AUTH_CONFIGURATION_MISSING');const login=await json(origin+'/api/oracle/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})}),cookie=login.response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; '),headers={cookie,origin,'content-type':'application/json','x-csrf-token':login.data.csrf};
  stage='route_preflight';const {data:route}=await json(origin+'/api/oracle/analysis/route',{method:'POST',headers,body:JSON.stringify({message,new_question:true})});
  const correct=route.route==='job'&&route.tool_route==='get_shopify_inventory_by_location'&&inventoryReportConfigKey(route.inventory_report)===inventoryReportConfigKey(expected);
  emit({stage,route:route.route,resolved_subject:route.resolved_subject||null,tool_route:route.tool_route||null,inventory_report:route.inventory_report||null,scope_verified:correct,providers_attempted:route.providers_attempted??null});
  if(!execute){const result={stage:'trace_complete',status:correct&&ancestor===true?'verified':'unverified',deployment_contains_405:ancestor,planning_verified:correct,chat_delivery:'not_attempted',shopify_reads:'not_requested'};emit(result);return result;}
  if(route.deployed_revision&&route.deployed_revision!==revision)throw failure('DEPLOYMENT_REVISION_MISMATCH');
  if(ancestor!==true)throw failure('DEPLOYMENT_ANCESTRY_UNVERIFIED');if(!correct)throw failure('INVENTORY_EXPORT_ROUTE_NOT_VERIFIED');
  stage='background_submission';requestId=randomUUID();const {data:submitted}=await json(origin+'/api/oracle/jobs',{method:'POST',headers:{...headers,'x-request-id':requestId},body:JSON.stringify({message,new_question:true})});if(!submitted.job_id)throw failure('JOB_ID_MISSING');emit({stage,request_id:requestId,job_id:token(submitted.job_id),status:'submitted'});
  stage='background_polling';let result;
  for(let i=0;i<maxPolls;i++){result=(await json(origin+'/api/oracle/jobs/'+encodeURIComponent(submitted.job_id),{headers:{cookie}})).data;if(['completed','failed','cancelled'].includes(result.status))break;await pause(1000);}
  if(result?.status!=='completed')throw failure(token(result?.code)||'JOB_NOT_COMPLETED');
  if(result.evidence?.kind!=='inventory_report'||!result.artifact?.download_url)throw failure('WRONG_RESULT_PIPELINE');
  if(inventoryReportConfigKey(result.evidence.inventory_report)!==inventoryReportConfigKey(expected))throw failure('EVIDENCE_SCOPE_MISMATCH');
  stage='authenticated_download';const url=result.artifact.download_url;if(!/^\/api\/oracle\/exports\/[a-f0-9]{64}$/.test(url))throw failure('INVALID_DOWNLOAD_URL');const download=await fetchImpl(origin+url,{headers:{cookie},signal:AbortSignal.timeout(30000)});if(!download.ok)throw Object.assign(failure('DOWNLOAD_FAILED'),{http_status:download.status});const bytes=Buffer.from(await download.arrayBuffer());
  stage='workbook_validation';const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes);const sheet=wb.getWorksheet('Inventory');if(!sheet||sheet.rowCount!==result.artifact.row_count+1)throw failure('WORKBOOK_ROW_COUNT_MISMATCH');
  const binding=resolveInventoryGroups(expected,result.evidence.locations);if(binding.failures.length)throw failure('LOCATION_BINDING_MISMATCH');
  const keys=sheet.getRow(1).values,pos=keys.indexOf('Total POS available'),stores=keys.map((k,i)=>String(k).startsWith('Available:')?i:null).filter(i=>i!==null),online=keys.findIndex(k=>String(k).startsWith('Online RTS available:'));
  if(binding.groups.pos.some(l=>!keys.includes(`Available: ${l.name} [${l.id}]`))||!keys.includes(`Online RTS available: ${binding.groups.online[0].name} [${binding.groups.online[0].id}]`))throw failure('WORKBOOK_LOCATION_MISMATCH');
  const status=keys.indexOf('Status'),tags=keys.indexOf('Tags');if(status<1||tags<1)throw failure('WORKBOOK_ELIGIBILITY_COLUMNS_MISSING');
  if(pos<1||online<1||stores.length!==expected.pos.names.length)throw failure('WORKBOOK_COLUMN_MISMATCH');let prior=Infinity;
  for(let i=2;i<=sheet.rowCount;i++){const r=sheet.getRow(i);if(!expected.statuses.includes(r.getCell(status).value)||String(r.getCell(tags).value||'').split(',').some(t=>expected.excluded_tags.includes(t.trim().toLowerCase())))throw failure('WORKBOOK_ELIGIBILITY_MISMATCH');const numbers=[...stores.map(c=>r.getCell(c).value),r.getCell(online).value];if(numbers.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw failure('UNKNOWN_QUALIFYING_QUANTITY');const total=numbers.slice(0,-1).reduce((a,n)=>a+n,0),rts=numbers.at(-1),compare=(n,g)=>({gt:n>g.threshold,gte:n>=g.threshold,lt:n<g.threshold,lte:n<=g.threshold})[g.operator];if(total!==r.getCell(pos).value||!compare(total,expected.pos)||!compare(rts,expected.online)||expected.sort.direction==='desc'&&total>prior)throw failure('WORKBOOK_PREDICATE_MISMATCH');prior=total;}
  stage='local_file';await write(output,bytes);const summary={stage:'chat_delivery_complete',running_revision:revision,request_id:requestId,job_id:token(submitted.job_id),download_path:url,path:output,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),rows:result.artifact.row_count,complete:result.evidence.complete,live_chat_delivery:'verified',inventory_changes:false};emit(summary);return summary;
 }catch(error){const result={stage,status:'unverified',code:token(error.code)||token(error.name)||'VALIDATION_FAILED',http_status:typeof error.http_status==='number'?error.http_status:null,request_id:requestId};emit(result);return result;}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
 const requestFile=process.argv.find(a=>a.startsWith('--request-file='))?.slice(15)||fileURLToPath(new URL('../test/fixtures/inventory-multiline/failed-submission.txt',import.meta.url)),output=resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)||'/tmp/oracle-inventory-multiline.xlsx');
 try{const result=await validateInventoryChatDelivery({message:(await readFile(requestFile,'utf8')).trimEnd(),origin:`http://127.0.0.1:${process.env.PORT||3000}`,password:process.env.ORACLE_UI_PASSWORD,execute:process.argv.includes('--execute'),output,emit:v=>console.log(JSON.stringify(v))});if(result.status==='unverified')process.exitCode=1;else if(result.live_chat_delivery==='verified'&&result.complete!==true)process.exitCode=2;}catch{console.error(JSON.stringify({stage:'configuration',status:'unverified',code:'REQUEST_FILE_UNAVAILABLE'}));process.exitCode=1;}
}
