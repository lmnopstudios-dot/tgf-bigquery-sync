import {BigQuery} from '@google-cloud/bigquery';
import {auditCatalogueSchema,CATALOGUE_QUERY_TYPES,catalogueSourceProjectionSql,catalogueTransportRows,inspectSerializedRows,validateCatalogueRows} from '../shopify/catalogue.js';

export function representativeCatalogueRows(){const syncedAt='2026-01-01T00:00:00.000Z';return {
  products:[
    {product_id:'contract-product-empty-tags',title:null,product_type:null,vendor:null,tags:[],status:null,created_at:null,updated_at:null,catalogue_synced_at:syncedAt},
    {product_id:'contract-product-populated-tags',title:null,product_type:null,vendor:null,tags:['Collaboration','Ready, "Set"','Café & 東京'],status:null,created_at:'2025-01-01T00:00:00.000Z',updated_at:'2025-02-01T00:00:00.000Z',catalogue_synced_at:syncedAt}
  ],
  collections:[
    {collection_id:'contract-collection-nullable',title:null,handle:null,product_count:0,updated_at:null,catalogue_synced_at:syncedAt},
    {collection_id:'contract-collection-timestamp',title:null,handle:null,product_count:0,updated_at:'2025-03-01T00:00:00.000Z',catalogue_synced_at:syncedAt}
  ],
  memberships:[{product_id:'contract-product-nullable',collection_id:'contract-collection-nullable',catalogue_synced_at:syncedAt}]
}}

function bindingValidationSql(kind){
  const nullableChecks=kind==='products'?`, COUNTIF(created_at IS NULL)=1 AS nullable_created_at_remains_null, COUNTIF(created_at IS NOT NULL)=1 AS present_created_at_converts, COUNTIF(updated_at IS NULL)=1 AS nullable_updated_at_remains_null, COUNTIF(updated_at IS NOT NULL)=1 AS present_updated_at_converts, COUNTIF(product_id='contract-product-empty-tags' AND tags IS NOT NULL AND ARRAY_LENGTH(tags)=0)=1 AS empty_tags_non_null_and_empty, COUNTIF(product_id='contract-product-populated-tags' AND ARRAY_LENGTH(tags)=3 AND tags[SAFE_OFFSET(0)]='Collaboration' AND tags[SAFE_OFFSET(1)]='Ready, "Set"' AND tags[SAFE_OFFSET(2)]='Café & 東京')=1 AS populated_tags_round_trip`:kind==='collections'?', COUNTIF(updated_at IS NULL)=1 AS nullable_updated_at_remains_null, COUNTIF(updated_at IS NOT NULL)=1 AS present_updated_at_converts':'';
  return `WITH bound AS (SELECT * FROM UNNEST(@rows)), projected AS (${catalogueSourceProjectionSql(kind,'bound')}) SELECT (SELECT LOGICAL_AND(catalogue_synced_at IS NOT NULL) FROM bound) AND TYPEOF((SELECT catalogue_synced_at FROM bound LIMIT 1))='STRING' AS bound_catalogue_synced_at_string_survives, LOGICAL_AND(catalogue_synced_at IS NOT NULL) AS converted_catalogue_synced_at_non_null, TYPEOF((SELECT catalogue_synced_at FROM projected LIMIT 1))='TIMESTAMP' AS converted_catalogue_synced_at_is_timestamp${nullableChecks} FROM projected`;
}

export async function validateShopifyCatalogueWriteContract({bigquery,project,dataset='shopify_catalogue'}){
  const schema=await auditCatalogueSchema(bigquery,project,dataset);const normalizedRows=representativeCatalogueRows();validateCatalogueRows(normalizedRows);const rows=catalogueTransportRows(normalizedRows);const binding={};
  for(const kind of ['products','collections','memberships']){
    const serialized=inspectSerializedRows(rows[kind],CATALOGUE_QUERY_TYPES[kind]);
    const survives=serialized.every(row=>row.catalogue_synced_at?.value!==undefined);
    if(!survives)throw new Error(`${kind} catalogue_synced_at was lost during BigQuery client parameter serialization`);
    if(kind==='products'&&!serialized.every((row,index)=>row.tags_json?.value===rows.products[index].tags_json))throw new Error('products tags JSON was lost during BigQuery client parameter serialization');
    const projection=catalogueSourceProjectionSql(kind);
    const [results]=await bigquery.query({query:bindingValidationSql(kind),params:{rows:rows[kind]},types:CATALOGUE_QUERY_TYPES[kind],labels:{component:'shopify_catalogue',operation:`${kind}_binding_validation`}});
    const assertions=results[0]||{};
    const failed=Object.entries(assertions).filter(([,passed])=>passed!==true).map(([name])=>name);
    if(failed.length)throw new Error(`${kind} catalogue binding validation failed: ${failed.join(', ')}`);
    binding[kind]={status:'PASS',parameter_type:'STRING',target_type:'TIMESTAMP',client_serialization_survives:true,server_binding_survives:true,...assertions,source_projection:projection};
  }
  return {valid:true,read_only:true,schema,binding};
}

async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data';if(!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');const bigquery=new BigQuery({projectId:project,credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)});console.log(JSON.stringify(await validateShopifyCatalogueWriteContract({bigquery,project}),null,2))}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(error=>{console.error(JSON.stringify({validation_failed:true,error_class:error?.name||'Error',message:String(error?.message||error).slice(0,1000)}));process.exitCode=1});
