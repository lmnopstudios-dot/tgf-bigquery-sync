import {BigQuery} from '@google-cloud/bigquery';

export const SHOPIFY_CATALOGUE_DATASET='shopify_catalogue';
const PRODUCTS_QUERY=`query CatalogueProducts($cursor:String){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id title productType vendor tags status createdAt updatedAt}}}`;
const COLLECTIONS_QUERY=`query CatalogueCollections($cursor:String){collections(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id title handle updatedAt productsCount{count}}}}`;
const COLLECTION_PRODUCTS_QUERY=`query CatalogueCollectionProducts($id:ID!,$cursor:String){collection(id:$id){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id}}}}`;
const stableId=value=>String(value||'').split('/').pop();

// Keep transport types alongside the catalogue writes. Nested timestamps and
// product tags cross this boundary as strings and are reconstructed in SQL.
export const CATALOGUE_QUERY_TYPES={
  products:{rows:[{product_id:'STRING',title:'STRING',product_type:'STRING',vendor:'STRING',tags_json:'STRING',status:'STRING',created_at:'STRING',updated_at:'STRING',catalogue_synced_at:'STRING'}]},
  collections:{rows:[{collection_id:'STRING',title:'STRING',handle:'STRING',product_count:'INT64',updated_at:'STRING',catalogue_synced_at:'STRING'}]},
  memberships:{rows:[{product_id:'STRING',collection_id:'STRING',catalogue_synced_at:'STRING'}]}
};

export const CATALOGUE_TABLE_SCHEMAS={
  products:{product_id:['STRING','NO'],title:['STRING','YES'],product_type:['STRING','YES'],vendor:['STRING','YES'],tags:['ARRAY<STRING>','NO'],status:['STRING','YES'],created_at:['TIMESTAMP','YES'],updated_at:['TIMESTAMP','YES'],catalogue_synced_at:['TIMESTAMP','NO']},
  collections:{collection_id:['STRING','NO'],title:['STRING','YES'],handle:['STRING','YES'],product_count:['INT64','YES'],updated_at:['TIMESTAMP','YES'],catalogue_synced_at:['TIMESTAMP','NO']},
  product_collections:{product_id:['STRING','NO'],collection_id:['STRING','NO'],catalogue_synced_at:['TIMESTAMP','NO']}
};

export function catalogueDdl(project,dataset=SHOPIFY_CATALOGUE_DATASET){return [
  `CREATE SCHEMA IF NOT EXISTS \`${project}.${dataset}\``,
  `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.products\` (product_id STRING NOT NULL,title STRING,product_type STRING,vendor STRING,tags ARRAY<STRING> NOT NULL,status STRING,created_at TIMESTAMP,updated_at TIMESTAMP,catalogue_synced_at TIMESTAMP NOT NULL) CLUSTER BY product_id,status`,
  `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.collections\` (collection_id STRING NOT NULL,title STRING,handle STRING,product_count INT64,updated_at TIMESTAMP,catalogue_synced_at TIMESTAMP NOT NULL) CLUSTER BY collection_id`,
  `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.product_collections\` (product_id STRING NOT NULL,collection_id STRING NOT NULL,catalogue_synced_at TIMESTAMP NOT NULL) CLUSTER BY product_id,collection_id`
]}

async function page(graphql,query,path,variables={}){const out=[];let cursor=null;do{const data=await graphql(query,{...variables,cursor});const connection=path.reduce((v,k)=>v?.[k],data);if(!connection)throw new Error(`Shopify catalogue response missing ${path.join('.')}`);out.push(...connection.nodes);cursor=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;}while(cursor);return out}
export async function fetchShopifyCatalogue(graphql){
  const products=(await page(graphql,PRODUCTS_QUERY,['products'])).map(p=>({product_id:stableId(p.id),title:p.title||null,product_type:p.productType||null,vendor:p.vendor||null,tags:p.tags??[],status:String(p.status||'').toLowerCase()||null,created_at:p.createdAt||null,updated_at:p.updatedAt||null}));
  const rawCollections=await page(graphql,COLLECTIONS_QUERY,['collections']);const memberships=[];
  for(const collection of rawCollections){const nodes=await page(graphql,COLLECTION_PRODUCTS_QUERY,['collection','products'],{id:collection.id});for(const product of nodes)memberships.push({product_id:stableId(product.id),collection_id:stableId(collection.id)});}
  return {products,collections:rawCollections.map(c=>({collection_id:stableId(c.id),title:c.title||null,handle:c.handle||null,product_count:Number(c.productsCount?.count||0),updated_at:c.updatedAt||null})),memberships};
}

const REQUIRED_FIELDS={product:['product_id','catalogue_synced_at'],collection:['collection_id','catalogue_synced_at'],membership:['product_id','collection_id','catalogue_synced_at']};
const missing=value=>value===null||value===undefined||value==='';
export function validateCatalogueRows(catalogue){
  for(const [kind,rows] of [['product',catalogue.products],['collection',catalogue.collections],['membership',catalogue.memberships]])for(const row of rows){
    for(const field of REQUIRED_FIELDS[kind])if(missing(row[field]))throw new Error(`Invalid Shopify catalogue ${kind} row: ${field} is required${row.product_id?` (product_id: ${row.product_id})`:row.collection_id?` (collection_id: ${row.collection_id})`:''}`);
    if(kind==='product'&&(!Array.isArray(row.tags)||row.tags.some(tag=>typeof tag!=='string')))throw new Error(`Invalid Shopify catalogue product row: tags must be an array of strings${row.product_id?` (product_id: ${row.product_id})`:''}`);
  }
}
const isoTimestamp=value=>{if(value===null||value===undefined||value==='')return null;const parsed=new Date(value);if(Number.isNaN(parsed.valueOf()))throw new Error(`Invalid Shopify catalogue timestamp: ${value}`);return parsed.toISOString()};
function materializeCatalogue(catalogue,catalogueSyncedAt){const syncedAt=isoTimestamp(catalogueSyncedAt);return {
  products:catalogue.products.map(row=>({...row,created_at:isoTimestamp(row.created_at),updated_at:isoTimestamp(row.updated_at),catalogue_synced_at:syncedAt})),
  collections:catalogue.collections.map(row=>({...row,updated_at:isoTimestamp(row.updated_at),catalogue_synced_at:syncedAt})),
  memberships:catalogue.memberships.map(row=>({...row,catalogue_synced_at:syncedAt}))
}}

export function catalogueTransportRows(catalogue){return {
  ...catalogue,
  products:catalogue.products.map(({tags,...row})=>({...row,tags_json:JSON.stringify(tags)}))
}}

export function catalogueSchemaAuditQuery(project,dataset=SHOPIFY_CATALOGUE_DATASET){return `SELECT table_name,column_name,data_type,is_nullable FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\` WHERE table_name IN ('products','collections','product_collections') ORDER BY table_name,ordinal_position`}
export async function auditCatalogueSchema(bigquery,project,dataset=SHOPIFY_CATALOGUE_DATASET){
  const [columns]=await bigquery.query({query:catalogueSchemaAuditQuery(project,dataset),labels:{component:'shopify_catalogue',operation:'schema_audit'}});
  const actual=Object.fromEntries(Object.keys(CATALOGUE_TABLE_SCHEMAS).map(table=>[table,{}]));
  for(const column of columns)if(actual[column.table_name])actual[column.table_name][column.column_name]=[column.data_type,column.is_nullable];
  const differences=[];
  for(const [table,expected] of Object.entries(CATALOGUE_TABLE_SCHEMAS))for(const [column,contract] of Object.entries(expected))if(JSON.stringify(actual[table][column])!==JSON.stringify(contract))differences.push({table,column,expected:{data_type:contract[0],is_nullable:contract[1]},actual:actual[table][column]?{data_type:actual[table][column][0],is_nullable:actual[table][column][1]}:null});
  const report={operation:'shopify_catalogue_schema_audit',tables:actual,differences};
  console.log(JSON.stringify(report));
  if(differences.length)throw new Error(`Shopify catalogue production schema differs from the write contract: ${JSON.stringify(differences)}`);
  return report;
}

const TYPE_FIELDS=types=>Object.keys(types.rows[0]);
export function inspectSerializedRows(rows,types){
  const converted=BigQuery.valueToQueryParameter_(rows,types.rows);
  return converted.parameterValue.arrayValues.map(value=>value.structValues);
}
function writeDiagnostic(operation,rows,types,syncTimestamp,requiredFields){
  const first=rows[0];
  const diagnostic={operation,row_count:rows.length,sync_timestamp:syncTimestamp,required_field_names:requiredFields,null_counts:Object.fromEntries(requiredFields.map(field=>[field,rows.filter(row=>missing(row[field])).length])),parameter_type_names:TYPE_FIELDS(types),catalogue_synced_at_parameter_type:types.rows[0].catalogue_synced_at,catalogue_synced_at_target_type:'TIMESTAMP',first_row_object_keys:first?Object.keys(first):[],first_row_catalogue_synced_at_non_null:first?!missing(first.catalogue_synced_at):null,timestamp_runtime_type:typeof first?.catalogue_synced_at};
  console.log(JSON.stringify(diagnostic));
  return diagnostic;
}
async function runWrite(bigquery,operation,options){try{return await bigquery.query({...options,labels:{component:'shopify_catalogue',operation}})}catch(error){throw new Error(`${operation}: ${error?.message||error}`,{cause:error})}}

export function catalogueSourceProjectionSql(kind,source='UNNEST(@rows)'){
  const projections={
    products:'product_id,title,product_type,vendor,COALESCE(JSON_VALUE_ARRAY(tags_json),ARRAY<STRING>[]) AS tags,status,SAFE_CAST(created_at AS TIMESTAMP) AS created_at,SAFE_CAST(updated_at AS TIMESTAMP) AS updated_at,TIMESTAMP(catalogue_synced_at) AS catalogue_synced_at',
    collections:'collection_id,title,handle,product_count,SAFE_CAST(updated_at AS TIMESTAMP) AS updated_at,TIMESTAMP(catalogue_synced_at) AS catalogue_synced_at',
    memberships:'product_id,collection_id,TIMESTAMP(catalogue_synced_at) AS catalogue_synced_at'
  };
  if(!projections[kind])throw new Error(`Unknown Shopify catalogue projection: ${kind}`);
  return `SELECT ${projections[kind]} FROM ${source}`;
}
export const catalogueMergeSql={
  products:(project,dataset)=>`MERGE \`${project}.${dataset}.products\` t USING (${catalogueSourceProjectionSql('products')}) s ON t.product_id=s.product_id WHEN MATCHED THEN UPDATE SET title=s.title,product_type=s.product_type,vendor=s.vendor,tags=s.tags,status=s.status,created_at=s.created_at,updated_at=s.updated_at,catalogue_synced_at=s.catalogue_synced_at WHEN NOT MATCHED THEN INSERT (product_id,title,product_type,vendor,tags,status,created_at,updated_at,catalogue_synced_at) VALUES (s.product_id,s.title,s.product_type,s.vendor,s.tags,s.status,s.created_at,s.updated_at,s.catalogue_synced_at)`,
  collections:(project,dataset)=>`MERGE \`${project}.${dataset}.collections\` t USING (${catalogueSourceProjectionSql('collections')}) s ON t.collection_id=s.collection_id WHEN MATCHED THEN UPDATE SET title=s.title,handle=s.handle,product_count=s.product_count,updated_at=s.updated_at,catalogue_synced_at=s.catalogue_synced_at WHEN NOT MATCHED THEN INSERT (collection_id,title,handle,product_count,updated_at,catalogue_synced_at) VALUES (s.collection_id,s.title,s.handle,s.product_count,s.updated_at,s.catalogue_synced_at)`,
  memberships:(project,dataset)=>`MERGE \`${project}.${dataset}.product_collections\` t USING (${catalogueSourceProjectionSql('memberships')}) s ON t.product_id=s.product_id AND t.collection_id=s.collection_id WHEN MATCHED THEN UPDATE SET catalogue_synced_at=s.catalogue_synced_at WHEN NOT MATCHED THEN INSERT (product_id,collection_id,catalogue_synced_at) VALUES (s.product_id,s.collection_id,s.catalogue_synced_at) WHEN NOT MATCHED BY SOURCE THEN DELETE`
};

export async function persistShopifyCatalogue(bigquery,project,catalogue,{dataset=SHOPIFY_CATALOGUE_DATASET,catalogueSyncedAt,now}={}){
  // `now` remains an option alias for callers deployed with the earlier API.
  const syncTimestamp=catalogueSyncedAt||now||new Date().toISOString();
  if(Number.isNaN(Date.parse(syncTimestamp)))throw new Error('Invalid Shopify catalogue sync timestamp: catalogue_synced_at is required');
  const normalizedRows=materializeCatalogue(catalogue,syncTimestamp);
  validateCatalogueRows(normalizedRows);
  const rows=catalogueTransportRows(normalizedRows);
  for(const query of catalogueDdl(project,dataset))await bigquery.query({query});
  await auditCatalogueSchema(bigquery,project,dataset);
  const specs=[
    ['shopify_catalogue_products_merge',rows.products,CATALOGUE_QUERY_TYPES.products,REQUIRED_FIELDS.product,catalogueMergeSql.products],
    ['shopify_catalogue_collections_merge',rows.collections,CATALOGUE_QUERY_TYPES.collections,REQUIRED_FIELDS.collection,catalogueMergeSql.collections]
  ];
  for(const [operation,tableRows,types,required,sql] of specs)if(tableRows.length){writeDiagnostic(operation,tableRows,types,syncTimestamp,required);await runWrite(bigquery,operation,{query:sql(project,dataset),params:{rows:tableRows},types});}
  writeDiagnostic('shopify_catalogue_memberships_merge',rows.memberships,CATALOGUE_QUERY_TYPES.memberships,syncTimestamp,REQUIRED_FIELDS.membership);
  await runWrite(bigquery,'shopify_catalogue_memberships_merge',{query:catalogueMergeSql.memberships(project,dataset),params:{rows:rows.memberships},types:CATALOGUE_QUERY_TYPES.memberships});
  return {products:rows.products.length,collections:rows.collections.length,memberships:rows.memberships.length};
}
export async function syncShopifyCatalogue({bigquery,project,graphql,dataset,now=()=>new Date().toISOString()}={}){const catalogueSyncedAt=now();const catalogue=await fetchShopifyCatalogue(graphql);return persistShopifyCatalogue(bigquery,project,catalogue,{dataset,catalogueSyncedAt});}

async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data',shop=process.env.SHOPIFY_SHOP;if(!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');if(!shop)throw new Error('Missing SHOPIFY_SHOP');let token=process.env.SHOPIFY_ACCESS_TOKEN;if(!token){if(!process.env.SHOPIFY_CLIENT_ID||!process.env.SHOPIFY_CLIENT_SECRET)throw new Error('Missing Shopify access token or client credentials');const auth=await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:process.env.SHOPIFY_CLIENT_ID,client_secret:process.env.SHOPIFY_CLIENT_SECRET})});const payload=await auth.json();if(!auth.ok||!payload.access_token)throw new Error(`Shopify OAuth failed with HTTP ${auth.status}`);token=payload.access_token}const graphql=async(query,variables)=>{const response=await fetch(`https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'content-type':'application/json','x-shopify-access-token':token},body:JSON.stringify({query,variables})});if(response.status===429){await new Promise(r=>setTimeout(r,1000));return graphql(query,variables)}const payload=await response.json();if(!response.ok||payload.errors)throw new Error(`Shopify catalogue request failed: ${response.status} ${JSON.stringify(payload.errors||[]).slice(0,500)}`);return payload.data};const bigquery=new BigQuery({projectId:project,credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)});console.log(JSON.stringify(await syncShopifyCatalogue({bigquery,project,graphql}),null,2));}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(error=>{console.error(error);process.exitCode=1});
