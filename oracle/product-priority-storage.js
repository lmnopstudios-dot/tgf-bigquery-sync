import { createHash, createHmac } from 'node:crypto';

export const priorityArtifactId=(owner,request)=>createHash('sha256').update(JSON.stringify([owner,request])).digest('hex');
export const exportOwnerKey=(identity,secret)=>createHmac('sha256',secret).update(`oracle-export:${identity}`).digest('hex');
const identifier=value=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('Invalid export storage identifier');return value;};
// Reuse Oracle's durable BigQuery storage and IAM, not Render's ephemeral disk.
// Bytes are persisted once; downloads return those exact bytes after restart.
export function createBigQueryExportStore({bigquery,project,dataset='commerce',table='oracle_exports_v1'}){
  const fq=`\`${identifier(project)}.${identifier(dataset)}.${identifier(table)}\``;let readiness,location;
  const run=async(query,params={})=>{location??=(await bigquery.dataset(dataset).getMetadata())[0].location;return (await bigquery.query({query,params,location,useLegacySql:false,maximumBytesBilled:'5000000000',labels:{component:'oracle_exports'}}))[0];};
  const ready=()=>readiness??=(async()=>{await run(`CREATE TABLE IF NOT EXISTS ${fq} (artifact_id STRING NOT NULL,owner_key STRING NOT NULL,artifact_json JSON NOT NULL,created_at TIMESTAMP NOT NULL) CLUSTER BY owner_key,artifact_id`);})().catch(error=>{readiness=null;throw error;});
  return{
    async get(id,owner){await ready();const row=(await run(`SELECT artifact_json FROM ${fq} WHERE artifact_id=@id AND owner_key=@owner LIMIT 1`,{id,owner}))[0];return row?typeof row.artifact_json==='string'?JSON.parse(row.artifact_json):row.artifact_json:null;},
    async put(id,owner,artifact){const json=JSON.stringify(artifact);if(Buffer.byteLength(json)>8_000_000)throw Object.assign(new Error('Export exceeds durable storage request size; no rows truncated'),{code:'EXPORT_STORAGE_SIZE_EXCEEDED',failed_stage:'export_persistence'});await ready();await run(`MERGE ${fq} t USING (SELECT @id artifact_id,@owner owner_key) s ON t.artifact_id=s.artifact_id AND t.owner_key=s.owner_key WHEN NOT MATCHED THEN INSERT (artifact_id,owner_key,artifact_json,created_at) VALUES (@id,@owner,PARSE_JSON(@artifact),CURRENT_TIMESTAMP())`,{id,owner,artifact:json});}
  };
}
export function createMemoryExportStore(){const rows=new Map();return{async get(id,owner){return structuredClone(rows.get(`${owner}:${id}`)||null);},async put(id,owner,artifact){const key=`${owner}:${id}`;if(!rows.has(key))rows.set(key,structuredClone(artifact));}};}
export async function sendPriorityDownload(store,id,owner,res){
  if(!/^[a-f0-9]{64}$/.test(id))return res.status(404).json({success:false,error:'Export not found'});
  const artifact=await store.get(id,owner);if(!artifact)return res.status(404).json({success:false,error:'Export not found'});
  res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');const filename=/^oracle-product-(?:priorities|report)(?:-(?:incomplete|provisional|unavailable))?\.xlsx$/.test(artifact.filename)?artifact.filename:'oracle-product-priorities.xlsx';res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);res.send(Buffer.from(artifact.xlsx_base64,'base64'));
}
