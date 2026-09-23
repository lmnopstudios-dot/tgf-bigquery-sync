import {BigQuery} from '@google-cloud/bigquery';

export const SHOPIFY_CATALOGUE_DATASET='shopify_catalogue';
const PRODUCTS_QUERY=`query CatalogueProducts($cursor:String){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id title productType vendor tags status createdAt updatedAt}}}`;
const COLLECTIONS_QUERY=`query CatalogueCollections($cursor:String){collections(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id title handle updatedAt productsCount{count}}}}`;
const COLLECTION_PRODUCTS_QUERY=`query CatalogueCollectionProducts($id:ID!,$cursor:String){collection(id:$id){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id}}}}`;
const stableId=value=>String(value||'').split('/').pop();

// BigQuery cannot infer an ARRAY's element type when either @rows or a nested
// repeated field (notably product tags) is empty. Keep these types alongside
// the catalogue writes so every nullable/repeated value has a stable schema.
export const CATALOGUE_QUERY_TYPES={
  products:{rows:[{product_id:'STRING',title:'STRING',product_type:'STRING',vendor:'STRING',tags:['STRING'],status:'STRING',created_at:'TIMESTAMP',updated_at:'TIMESTAMP',catalogue_synced_at:'TIMESTAMP'}]},
  collections:{rows:[{collection_id:'STRING',title:'STRING',handle:'STRING',product_count:'INT64',updated_at:'TIMESTAMP',catalogue_synced_at:'TIMESTAMP'}]},
  memberships:{rows:[{product_id:'STRING',collection_id:'STRING',catalogue_synced_at:'TIMESTAMP'}]}
};

export function catalogueDdl(project,dataset=SHOPIFY_CATALOGUE_DATASET){return [
  `CREATE SCHEMA IF NOT EXISTS \`${project}.${dataset}\``,
  `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.products\` (product_id STRING NOT NULL,title STRING,product_type STRING,vendor STRING,tags ARRAY<STRING>,status STRING,created_at TIMESTAMP,updated_at TIMESTAMP,catalogue_synced_at TIMESTAMP NOT NULL) CLUSTER BY product_id,status`,
  `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.collections\` (collection_id STRING NOT NULL,title STRING,handle STRING,product_count INT64,updated_at TIMESTAMP,catalogue_synced_at TIMESTAMP NOT NULL) CLUSTER BY collection_id`,
  `CREATE TABLE IF NOT EXISTS \`${project}.${dataset}.product_collections\` (product_id STRING NOT NULL,collection_id STRING NOT NULL,catalogue_synced_at TIMESTAMP NOT NULL) CLUSTER BY product_id,collection_id`
]}

async function page(graphql,query,path,variables={}){const out=[];let cursor=null;do{const data=await graphql(query,{...variables,cursor});const connection=path.reduce((v,k)=>v?.[k],data);if(!connection)throw new Error(`Shopify catalogue response missing ${path.join('.')}`);out.push(...connection.nodes);cursor=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;}while(cursor);return out}
export async function fetchShopifyCatalogue(graphql){
  const products=(await page(graphql,PRODUCTS_QUERY,['products'])).map(p=>({product_id:stableId(p.id),title:p.title||null,product_type:p.productType||null,vendor:p.vendor||null,tags:p.tags||[],status:String(p.status||'').toLowerCase()||null,created_at:p.createdAt||null,updated_at:p.updatedAt||null}));
  const rawCollections=await page(graphql,COLLECTIONS_QUERY,['collections']);const memberships=[];
  for(const collection of rawCollections){const nodes=await page(graphql,COLLECTION_PRODUCTS_QUERY,['collection','products'],{id:collection.id});for(const product of nodes)memberships.push({product_id:stableId(product.id),collection_id:stableId(collection.id)});}
  return {products,collections:rawCollections.map(c=>({collection_id:stableId(c.id),title:c.title||null,handle:c.handle||null,product_count:Number(c.productsCount?.count||0),updated_at:c.updatedAt||null})),memberships};
}

const REQUIRED_FIELDS={product:['product_id','catalogue_synced_at'],collection:['collection_id','catalogue_synced_at'],membership:['product_id','collection_id','catalogue_synced_at']};
const missing=value=>value===null||value===undefined||value==='';
export function validateCatalogueRows(catalogue){
  for(const [kind,rows] of [['product',catalogue.products],['collection',catalogue.collections],['membership',catalogue.memberships]])for(const row of rows)for(const field of REQUIRED_FIELDS[kind])if(missing(row[field]))throw new Error(`Invalid Shopify catalogue ${kind} row: ${field} is required${row.product_id?` (product_id: ${row.product_id})`:row.collection_id?` (collection_id: ${row.collection_id})`:''}`);
}
function materializeCatalogue(catalogue,catalogueSyncedAt){return {
  products:catalogue.products.map(row=>({...row,catalogue_synced_at:catalogueSyncedAt})),
  collections:catalogue.collections.map(row=>({...row,catalogue_synced_at:catalogueSyncedAt})),
  memberships:catalogue.memberships.map(row=>({...row,catalogue_synced_at:catalogueSyncedAt}))
}}
export async function persistShopifyCatalogue(bigquery,project,catalogue,{dataset=SHOPIFY_CATALOGUE_DATASET,catalogueSyncedAt,now}={}){
  // `now` remains an option alias for callers deployed with the earlier API.
  const syncTimestamp=catalogueSyncedAt||now||new Date().toISOString();
  if(Number.isNaN(Date.parse(syncTimestamp)))throw new Error('Invalid Shopify catalogue sync timestamp: catalogue_synced_at is required');
  const rows=materializeCatalogue(catalogue,syncTimestamp);
  validateCatalogueRows(rows);
  for(const query of catalogueDdl(project,dataset))await bigquery.query({query});
  const specs=[['products','product_id',rows.products,CATALOGUE_QUERY_TYPES.products],['collections','collection_id',rows.collections,CATALOGUE_QUERY_TYPES.collections]];
  for(const [table,key,tableRows,types] of specs)if(tableRows.length){const columns=Object.keys(tableRows[0]);await bigquery.query({query:`MERGE \`${project}.${dataset}.${table}\` t USING UNNEST(@rows) s ON t.${key}=s.${key} WHEN MATCHED THEN UPDATE SET ${columns.filter(column=>column!==key).map(column=>`${column}=s.${column}`).join(',')} WHEN NOT MATCHED THEN INSERT (${columns.join(',')}) VALUES (${columns.map(column=>`s.${column}`).join(',')})`,params:{rows:tableRows},types});}
  await bigquery.query({query:`CREATE TEMP TABLE current_memberships AS SELECT * FROM UNNEST(@rows); MERGE \`${project}.${dataset}.product_collections\` t USING current_memberships s ON t.product_id=s.product_id AND t.collection_id=s.collection_id WHEN MATCHED THEN UPDATE SET catalogue_synced_at=s.catalogue_synced_at WHEN NOT MATCHED THEN INSERT (product_id,collection_id,catalogue_synced_at) VALUES (s.product_id,s.collection_id,s.catalogue_synced_at) WHEN NOT MATCHED BY SOURCE THEN DELETE`,params:{rows:rows.memberships},types:CATALOGUE_QUERY_TYPES.memberships});
  return {products:rows.products.length,collections:rows.collections.length,memberships:rows.memberships.length};
}
export async function syncShopifyCatalogue({bigquery,project,graphql,dataset,now=()=>new Date().toISOString()}={}){const catalogueSyncedAt=now();const catalogue=await fetchShopifyCatalogue(graphql);return persistShopifyCatalogue(bigquery,project,catalogue,{dataset,catalogueSyncedAt});}

async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data',shop=process.env.SHOPIFY_SHOP;if(!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');if(!shop)throw new Error('Missing SHOPIFY_SHOP');let token=process.env.SHOPIFY_ACCESS_TOKEN;if(!token){if(!process.env.SHOPIFY_CLIENT_ID||!process.env.SHOPIFY_CLIENT_SECRET)throw new Error('Missing Shopify access token or client credentials');const auth=await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:process.env.SHOPIFY_CLIENT_ID,client_secret:process.env.SHOPIFY_CLIENT_SECRET})});const payload=await auth.json();if(!auth.ok||!payload.access_token)throw new Error(`Shopify OAuth failed with HTTP ${auth.status}`);token=payload.access_token}const graphql=async(query,variables)=>{const response=await fetch(`https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'content-type':'application/json','x-shopify-access-token':token},body:JSON.stringify({query,variables})});if(response.status===429){await new Promise(r=>setTimeout(r,1000));return graphql(query,variables)}const payload=await response.json();if(!response.ok||payload.errors)throw new Error(`Shopify catalogue request failed: ${response.status} ${JSON.stringify(payload.errors||[]).slice(0,500)}`);return payload.data};const bigquery=new BigQuery({projectId:project,credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)});console.log(JSON.stringify(await syncShopifyCatalogue({bigquery,project,graphql}),null,2));}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(error=>{console.error(error);process.exitCode=1});
