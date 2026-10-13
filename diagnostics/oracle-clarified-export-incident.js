#!/usr/bin/env node
import { BigQuery } from '@google-cloud/bigquery';
import { pathToFileURL } from 'node:url';
import { loadOracleJobReadinessConfig } from './oracle-job-readiness.js';
import { exportOwnerKey, priorityArtifactId } from '../oracle/product-priority-storage.js';
import { assertProductArtifact } from '../oracle/product-artifact-validation.js';
import { productReportConfigKey } from '../oracle/product-report-config.js';
import { categoryToken } from '../oracle/product-catalogue-filter.js';
const identifier=v=>{if(!/^[A-Za-z0-9_-]+$/.test(v||''))throw Error('Invalid identifier');return v;};
// One owner-scoped read of an existing Oracle artifact. No table creation,
// catalogue, collection, inventory, source write, regeneration or delivery.
export async function inspectClarifiedExport({bigquery,project,dataset,location,requestId,owner,expectedReportConfig=null}){
  if(!/^[0-9a-f-]{36}$/i.test(requestId||''))throw Error('Invalid request ID');
  const id=priorityArtifactId(owner,requestId);
  try{
    const [rows]=await bigquery.query({query:`SELECT artifact_json FROM \`${identifier(project)}.${identifier(dataset)}.oracle_exports_v1\` WHERE artifact_id=@id AND owner_key=@owner LIMIT 1`,params:{id,owner},location,useLegacySql:false,maximumBytesBilled:'100000000',jobTimeoutMs:'10000',labels:{component:'oracle_incident'}});
    if(!rows.length)return {status:'not_found',owner_scoped:true,request_id:requestId};
    const a=typeof rows[0].artifact_json==='string'?JSON.parse(rows[0].artifact_json):rows[0].artifact_json,e=a.envelope;
    const base={status:'found',owner_scoped:true,request_id:requestId,row_count:e?.rows?.length,complete_catalogue:e?.manifest?.complete_catalogue,filter_key_order:Object.keys(e?.catalogue_selection?.filter||{}).slice(0,4),config_filter_key_order:Object.keys(e?.report_config?.catalogue_filter||{}).slice(0,4)};
    try{await assertProductArtifact(a);}catch(error){return {...base,recoverable:false,scope_field:error.scope_field||'artifact.validation'};}
    const ids=e.rows.map(p=>p.product_id),collectionId='gid://shopify/Collection/658285396295';
    const collectionScopeMatches=e.report_config?.catalogue_filter?.source==='collection'&&categoryToken(e.report_config.catalogue_filter.term)==='pendant'&&e.catalogue_selection?.bindings?.every(b=>b.source==='collection'&&b.collection_id===collectionId)&&e.rows.every(p=>p.collections?.some(c=>c.id===collectionId));
    const originalScopeAgrees=Boolean(expectedReportConfig)&&productReportConfigKey(expectedReportConfig)===productReportConfigKey(e.report_config);
    return {...base,artifact_valid:true,recoverable:collectionScopeMatches&&originalScopeAgrees,recovery_condition:expectedReportConfig?'expected_scope_checked':'original_resolved_report_config_required',collection_scope_matches:collectionScopeMatches,collection_id:collectionId,all_rows_in_collection:e.rows.every(p=>p.collections?.some(c=>c.id===collectionId)),all_rows_product_type_pendants:e.rows.every(p=>categoryToken(p.product_type)==='pendant'),product_id_count:new Set(ids).size};
  }catch(error){return {status:'unverified',owner_scoped:true,request_id:requestId,error_code:String(error.code||'READ_FAILED').slice(0,40),reason:/domain forbidden/i.test(error.message||'')?'EGRESS_FORBIDDEN':'READ_FAILED'};}
}
async function main(){const c=loadOracleJobReadinessConfig(),secret=process.env.ORACLE_UI_SESSION_SECRET;if(!secret)throw Error('Owner configuration missing');return inspectClarifiedExport({...c,bigquery:new BigQuery({projectId:c.project,credentials:c.credentials}),location:c.expectedLocation,requestId:process.argv[2],owner:exportOwnerKey(process.env.ORACLE_UI_ADMIN_NAME||'oracle-admin',secret)});}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const timer=setTimeout(()=>{process.stdout.write(JSON.stringify({status:'unverified',reason:'BOUNDED_READ_TIMEOUT'})+'\n');process.exit(1);},15000);main().then(result=>{clearTimeout(timer);process.stdout.write(JSON.stringify(result)+'\n');if(result.status==='unverified')process.exitCode=1;}).catch(()=>{clearTimeout(timer);process.stdout.write(JSON.stringify({status:'unverified',reason:'CONFIGURATION_UNAVAILABLE'})+'\n');process.exitCode=1;});}
