import {BigQuery} from '@google-cloud/bigquery';
import {auditCatalogueSchema,CATALOGUE_QUERY_TYPES,catalogueMergeSql,inspectSerializedRows} from '../shopify/catalogue.js';

export function representativeCatalogueRows(){const syncedAt=BigQuery.timestamp('2026-01-01T00:00:00.000Z');return {
  products:[{product_id:'contract-product',title:null,product_type:null,vendor:null,tags:[],status:null,created_at:null,updated_at:null,catalogue_synced_at:syncedAt}],
  collections:[{collection_id:'contract-collection',title:null,handle:null,product_count:0,updated_at:null,catalogue_synced_at:syncedAt}],
  memberships:[{product_id:'contract-product',collection_id:'contract-collection',catalogue_synced_at:syncedAt}]
}}

export async function validateShopifyCatalogueWriteContract({bigquery,project,dataset='shopify_catalogue'}){
  const schema=await auditCatalogueSchema(bigquery,project,dataset);const rows=representativeCatalogueRows();const binding={};
  for(const kind of ['products','collections','memberships']){
    const serialized=inspectSerializedRows(rows[kind],CATALOGUE_QUERY_TYPES[kind]);
    const survives=serialized[0]?.catalogue_synced_at?.value!==undefined;
    if(!survives)throw new Error(`${kind} catalogue_synced_at was lost during BigQuery client parameter serialization`);
    const projection=catalogueMergeSql[kind](project,dataset).match(/USING \((.*?)\) s/s)?.[1];
    const [bound]=await bigquery.query({query:`SELECT catalogue_synced_at IS NOT NULL AS survives FROM UNNEST(@rows)`,params:{rows:rows[kind]},types:CATALOGUE_QUERY_TYPES[kind],labels:{component:'shopify_catalogue',operation:`${kind}_binding_validation`}});
    if(bound.length!==1||bound[0].survives!==true)throw new Error(`${kind} catalogue_synced_at did not survive BigQuery parameter binding`);
    binding[kind]={client_serialization_survives:true,server_binding_survives:true,source_projection:projection};
  }
  return {valid:true,read_only:true,schema,binding};
}

async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';if(!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');const bigquery=new BigQuery({projectId:project,credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)});console.log(JSON.stringify(await validateShopifyCatalogueWriteContract({bigquery,project}),null,2))}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(error=>{console.error(JSON.stringify({validation_failed:true,error_class:error?.name||'Error',message:String(error?.message||error).slice(0,1000)}));process.exitCode=1});
