// Shopify reads and a local file only. Local recovery deliberately does not
// depend on conversational routing or the durable JSON artifact storage limit.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql} from '../shopify/admin-client.js';
import {readInventoryReport,inventoryReportWorkbook,assertInventoryArtifact} from '../oracle/inventory-report.js';
const token=value=>/^[A-Za-z0-9_.:-]{1,100}$/.test(String(value??''))?String(value):null;
export function inventoryExportError(error,stage){return {stage,status:'failed',code:token(error?.code)||token(error?.name)||'READ_FAILED',http_status:error?.http_status??error?.response?.status??null,cause_code:token(error?.cause?.code),graphql_codes:(error?.errors||[]).map(e=>token(e?.extensions?.code)).filter(Boolean),...(error?.integrity?{integrity:error.integrity}:{})};}
export async function runInventoryExport({getToken,graphql,output='/tmp/oracle-inventory.xlsx',expectedLocations=null,emit=()=>{},write=writeFile,read=readInventoryReport,workbook=inventoryReportWorkbook,validate=assertInventoryArtifact}={}){
  let stage='shopify_reads',calls=0;
  try{
    if(!output.endsWith('.xlsx'))throw Object.assign(new Error(),{code:'XLSX_OUTPUT_REQUIRED'});
    const e=await read({getToken:async signal=>{emit({stage:'shopify_auth',status:'started'});try{const t=await getToken(signal);emit({stage:'shopify_auth',status:'success'});return t;}catch(error){emit(inventoryExportError(error,'shopify_auth'));throw error;}},graphql:async(t,q,v,s)=>{const operation=q.match(/query\s+(\w+)/)?.[1]||'shopify_read',started=Date.now();try{const d=await graphql(t,q,v,s);calls++;if(calls===1||calls%25===0)emit({stage:operation,status:'success',calls,elapsed_ms:Date.now()-started});return d;}catch(error){emit({...inventoryExportError(error,operation),elapsed_ms:Date.now()-started});throw error;}}});
    if(expectedLocations!==null&&e.locations.length!==expectedLocations){e.complete=false;e.failures.push({stage:'location_expectation',code:'INVENTORY_LOCATION_COUNT_MISMATCH',expected:expectedLocations,observed:e.locations.length});}
    emit({stage:'shopify_read_complete',complete:e.complete,products:e.products.length,variants:e.products.reduce((n,p)=>n+p.variants.length,0),locations:e.locations,catalogue_complete:e.population?.catalogue_complete??e.tag_convention.catalogue_complete,catalogue_status_counts:e.population?.status_counts??null,eligible_statuses:e.population?.eligible_statuses??null,catalogue_scanned_count:e.population?.audit.length??null,related_tags:e.tag_convention.observed_tags.filter(t=>/made|order/i.test(t.tag)),failures:e.failures,started_at:e.started_at,as_of:e.as_of});
    stage='workbook_generation';emit({stage,status:'started'});const bytes=await workbook(e),sha256=createHash('sha256').update(bytes).digest('hex');
    stage='workbook_validation';await validate({envelope:e,xlsx_base64:bytes.toString('base64'),sha256});
    stage='local_file_write';await write(output,bytes);
    const convention=e.tag_convention.observed_tags.some(t=>t.tag.trim().toLowerCase()==='made-to-order');
    const result={stage:'export_complete',path:output,bytes:bytes.length,sha256,complete:e.complete,tag_convention_verified:convention,live_validation:e.complete&&convention?'verified':'partial',durable_storage:'not_attempted',chat_delivery:'not_attempted'};emit(result);return result;
  }catch(error){const result=inventoryExportError(error,stage);emit(result);return result;}
}
async function main(){
  const emit=value=>console.log(JSON.stringify(value)),requestId=process.argv.find(a=>a.startsWith('--request-id='))?.slice(13),output=resolve(process.argv.find(a=>a.startsWith('--output='))?.slice(9)||'/tmp/oracle-inventory.xlsx');
  if(requestId&&!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId))throw Object.assign(new Error(),{code:'INVALID_REQUEST_ID'});
  // Read retained evidence independently; an unavailable warehouse must not
  // prevent the urgently requested Shopify workbook from being recovered.
  const retained=requestId?(async()=>{try{const [{createBigQueryClient},{inspectAnalysisIncident},{ORACLE_JOB_DEFAULTS}]=await Promise.all([import('../bigquery/client.js'),import('./oracle-analysis-incident.js'),import('../oracle/analysis-jobs.js')]);const {bigquery,project}=createBigQueryClient();const dataset=process.env.ORACLE_JOB_DATASET||ORACLE_JOB_DEFAULTS.dataset;
      await Promise.allSettled([
        (async()=>emit(await inspectAnalysisIncident({bigquery,project,dataset,table:process.env.ORACLE_JOB_TABLE||ORACLE_JOB_DEFAULTS.table,requestId,revision:process.env.RENDER_GIT_COMMIT})))(),
        (async()=>{try{const [{inspectRetainedInventoryExport},{exportOwnerKey}]=await Promise.all([import('./inventory-retained-export.js'),import('../oracle/product-priority-storage.js')]);if(!process.env.ORACLE_UI_SESSION_SECRET)throw Object.assign(new Error(),{code:'OWNER_CONFIGURATION_MISSING'});emit(await inspectRetainedInventoryExport({bigquery,project,dataset,requestId,owner:exportOwnerKey(process.env.ORACLE_UI_ADMIN_NAME||'oracle-admin',process.env.ORACLE_UI_SESSION_SECRET)}));}catch(error){emit(inventoryExportError(error,'retained_inventory_export'));}})()
      ]);}catch(e){emit(inventoryExportError(e,'retained_evidence'));}})():Promise.resolve();
  const expectedArg=process.argv.find(a=>a.startsWith('--expected-locations='))?.slice(21);const expectedLocations=expectedArg===undefined?null:Number(expectedArg);if(expectedLocations!==null&&(!Number.isInteger(expectedLocations)||expectedLocations<0))throw Object.assign(new Error(),{code:'INVALID_LOCATION_EXPECTATION'});
  let result;try{const config=loadShopifyConfig();result=await runInventoryExport({output,expectedLocations,emit,getToken:signal=>getShopifyAccessToken(config,fetch,signal),graphql:(t,q,v,s)=>createShopifyGraphql({shop:config.shop,token:t})(q,v,s)});}catch(e){emit(inventoryExportError(e,'configuration'));process.exitCode=1;}
  await retained;if(result?.status==='failed')process.exitCode=1;else if(result?.live_validation!=='verified')process.exitCode=2;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(e=>{console.error(JSON.stringify(inventoryExportError(e,'diagnostic')));process.exitCode=1;});
