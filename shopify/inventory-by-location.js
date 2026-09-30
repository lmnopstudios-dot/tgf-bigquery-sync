const chunk=(values,size)=>{const out=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;};
const tail=value=>String(value??'').replace(/^shopify:shopify:/,'').replace(/^gid:\/\/shopify\/Product\//,'');
const productGid=value=>`gid://shopify/Product/${tail(value)}`;
const throttled=error=>error?.errors?.find(item=>item?.extensions?.code==='THROTTLED');

const PRODUCTS=`query InventoryProducts($ids:[ID!]!){nodes(ids:$ids){... on Product{id title handle status tags variants(first:100){pageInfo{hasNextPage endCursor}nodes{id title sku availableForSale inventoryItem{id}}}}}}`;
const VARIANTS=`query InventoryVariants($id:ID!,$cursor:String!){product(id:$id){variants(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title sku availableForSale inventoryItem{id}}}}}`;
const LOCATION=`query OnlineLocation($cursor:String){locations(first:100,after:$cursor,query:"name:Online AND active:true"){pageInfo{hasNextPage endCursor}nodes{id name isActive}}}`;
const LEVELS=`query InventoryLevels($ids:[ID!]!,$location:ID!){nodes(ids:$ids){... on InventoryItem{id inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}}}`;

/** Exact, read-only Online inventory retrieval. Parent and inventory-item `nodes`
 * queries are genuine batched GraphQL calls; only products with >100 variants
 * need a product-specific pagination call. Diagnostics contain aggregate counts only. */
export function createBatchedInventoryByLocation({graphql,getToken,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{},parentBatchSize=20,itemBatchSize=100,concurrency=2}){
  return async(parentIds,{deadlineAt=Infinity,signal}={})=>{
    const started=now(),stats={requested_parents:parentIds.length,returned_parents:0,variants:0,network_calls:0,parent_batch_calls:0,variant_page_calls:0,inventory_batch_calls:0,location_page_calls:0,pages:0,throttle_waits:0,throttle_wait_ms:0};
    if(!parentIds.length)return{products:[],requested_count:0,completed_count:0,missing_ids:[],complete:true,diagnostics:{...stats,duration_ms:0,complete:true},as_of:new Date().toISOString(),location:'Online'};
    const token=await getToken();
    const call=async(query,variables,kind)=>{for(let attempt=0;attempt<2;attempt++){if(signal?.aborted)throw Object.assign(new Error('inventory request aborted'),{name:'AbortError'});stats.network_calls++;stats[kind]++;try{return await graphql(token,query,variables);}catch(error){const detail=throttled(error);if(!detail||attempt)return Promise.reject(error);const reset=Date.parse(detail.extensions?.cost?.windowResetAt),waitMs=Number.isFinite(reset)?Math.max(0,reset-now())+350:null,remaining=Number.isFinite(deadlineAt)?deadlineAt-now():Infinity;if(waitMs===null||waitMs>30_000||waitMs+5_000>=remaining)throw Object.assign(error,{code:'INVENTORY_THROTTLE_BUDGET_EXHAUSTED'});stats.throttle_waits++;stats.throttle_wait_ms+=waitMs;await sleep(waitMs);}}};
    let locationCursor=null,onlineLocation=null;do{const page=await call(LOCATION,{cursor:locationCursor},'location_page_calls');stats.pages++;const connection=page.locations;onlineLocation=connection.nodes.find(x=>x.isActive&&x.name.toLowerCase()==='online')||onlineLocation;locationCursor=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;}while(!onlineLocation&&locationCursor);
    if(!onlineLocation)throw Object.assign(new Error('Active Online location was not found'),{code:'ONLINE_LOCATION_NOT_FOUND'});
    const products=[];
    const mapConcurrent=async(values,fn)=>{const out=new Array(values.length);let next=0;await Promise.all(Array.from({length:Math.min(concurrency,values.length)},async()=>{while(next<values.length){const i=next++;out[i]=await fn(values[i]);}}));return out;};
    const parentPages=await mapConcurrent(chunk(parentIds,parentBatchSize),async ids=>{const data=await call(PRODUCTS,{ids:ids.map(productGid)},'parent_batch_calls');stats.pages++;return data.nodes;});
    for(const product of parentPages.flat().filter(Boolean)){
      const variants=[...product.variants.nodes];let info=product.variants.pageInfo,seen=new Set();
      while(info.hasNextPage){if(!info.endCursor||seen.has(info.endCursor))throw new Error('Invalid Shopify variant pagination cursor');seen.add(info.endCursor);const page=await call(VARIANTS,{id:product.id,cursor:info.endCursor},'variant_page_calls');stats.pages++;if(!page.product)throw new Error('Shopify product disappeared during pagination');variants.push(...page.product.variants.nodes);info=page.product.variants.pageInfo;}
      products.push({...product,variants});
    }
    const items=products.flatMap(p=>p.variants.map(v=>v.inventoryItem?.id).filter(Boolean));
    const levelPages=await mapConcurrent(chunk(items,itemBatchSize),async ids=>{const data=await call(LEVELS,{ids,location:onlineLocation.id},'inventory_batch_calls');stats.pages++;return data.nodes;});
    const levels=new Map(levelPages.flat().filter(Boolean).map(x=>[x.id,x.inventoryLevel]));
    for(const product of products)product.variants=product.variants.map(v=>({...v,locations:[{location_id:onlineLocation.id,location_name:onlineLocation.name,available:levels.get(v.inventoryItem?.id)?.quantities?.find(q=>q.name==='available')?.quantity??null}]}));
    stats.returned_parents=products.length;stats.variants=products.reduce((n,p)=>n+p.variants.length,0);stats.duration_ms=now()-started;stats.complete=products.length===parentIds.length;
    log({...stats});return{products,requested_count:parentIds.length,completed_count:products.length,missing_ids:parentIds.filter(id=>!products.some(p=>tail(p.id)===tail(id))),complete:stats.complete,diagnostics:stats,as_of:new Date().toISOString(),location:'Online'};
  };
}
