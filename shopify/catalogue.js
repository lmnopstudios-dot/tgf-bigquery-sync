import {BigQuery} from '@google-cloud/bigquery';

export const SHOPIFY_CATALOGUE_DATASET='shopify_catalogue';
const PRODUCTS_QUERY=`query CatalogueProducts($cursor:String){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id title productType vendor tags status createdAt updatedAt}}}`;
const COLLECTIONS_QUERY=`query CatalogueCollections($cursor:String){collections(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id title handle updatedAt productsCount{count}}}}`;
const COLLECTION_PRODUCTS_QUERY=`query CatalogueCollectionProducts($id:ID!,$cursor:String){collection(id:$id){products(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id}}}}`;
const stableId=value=>String(value||'').split('/').pop();

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
export async function persistShopifyCatalogue(bigquery,project,catalogue,{dataset=SHOPIFY_CATALOGUE_DATASET,now=new Date().toISOString()}={}){
  for(const query of catalogueDdl(project,dataset))await bigquery.query({query});
  const specs=[['products','product_id',catalogue.products],['collections','collection_id',catalogue.collections]];
  for(const [table,key,rows] of specs)if(rows.length)await bigquery.query({query:`MERGE \`${project}.${dataset}.${table}\` t USING (SELECT r.*,TIMESTAMP(@now) catalogue_synced_at FROM UNNEST(@rows) r) s ON t.${key}=s.${key} WHEN MATCHED THEN UPDATE SET ${Object.keys(rows[0]).filter(k=>k!==key).map(k=>`${k}=s.${k}`).join(',')},catalogue_synced_at=s.catalogue_synced_at WHEN NOT MATCHED THEN INSERT ROW`,params:{rows,now}});
  await bigquery.query({query:`CREATE TEMP TABLE current_memberships AS SELECT r.product_id,r.collection_id,TIMESTAMP(@now) catalogue_synced_at FROM UNNEST(@rows) r; MERGE \`${project}.${dataset}.product_collections\` t USING current_memberships s ON t.product_id=s.product_id AND t.collection_id=s.collection_id WHEN MATCHED THEN UPDATE SET catalogue_synced_at=s.catalogue_synced_at WHEN NOT MATCHED THEN INSERT ROW WHEN NOT MATCHED BY SOURCE THEN DELETE`,params:{rows:catalogue.memberships,now}});
  return {products:catalogue.products.length,collections:catalogue.collections.length,memberships:catalogue.memberships.length};
}
export async function syncShopifyCatalogue({bigquery,project,graphql,dataset}={}){const catalogue=await fetchShopifyCatalogue(graphql);return persistShopifyCatalogue(bigquery,project,catalogue,{dataset});}

async function main(){const project=process.env.GOOGLE_PROJECT_ID||'gf-full-data',shop=process.env.SHOPIFY_SHOP;if(!process.env.GOOGLE_SERVICE_ACCOUNT_JSON)throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON');if(!shop)throw new Error('Missing SHOPIFY_SHOP');let token=process.env.SHOPIFY_ACCESS_TOKEN;if(!token){if(!process.env.SHOPIFY_CLIENT_ID||!process.env.SHOPIFY_CLIENT_SECRET)throw new Error('Missing Shopify access token or client credentials');const auth=await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:process.env.SHOPIFY_CLIENT_ID,client_secret:process.env.SHOPIFY_CLIENT_SECRET})});const payload=await auth.json();if(!auth.ok||!payload.access_token)throw new Error(`Shopify OAuth failed with HTTP ${auth.status}`);token=payload.access_token}const graphql=async(query,variables)=>{const response=await fetch(`https://${shop}.myshopify.com/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'content-type':'application/json','x-shopify-access-token':token},body:JSON.stringify({query,variables})});if(response.status===429){await new Promise(r=>setTimeout(r,1000));return graphql(query,variables)}const payload=await response.json();if(!response.ok||payload.errors)throw new Error(`Shopify catalogue request failed: ${response.status} ${JSON.stringify(payload.errors||[]).slice(0,500)}`);return payload.data};const bigquery=new BigQuery({projectId:project,credentials:JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)});console.log(JSON.stringify(await syncShopifyCatalogue({bigquery,project,graphql}),null,2));}
if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href)main().catch(error=>{console.error(error);process.exitCode=1});
