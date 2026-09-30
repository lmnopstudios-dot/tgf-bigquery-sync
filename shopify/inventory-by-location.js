const chunk=(values,size)=>{const out=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;};
const tail=value=>String(value??'').replace(/^shopify:shopify:/,'').replace(/^gid:\/\/shopify\/Product\//,'');
const productGid=value=>`gid://shopify/Product/${tail(value)}`;
const throttled=error=>error?.errors?.find(item=>item?.extensions?.code==='THROTTLED');

const PRODUCTS=`query InventoryProducts($ids:[ID!]!){nodes(ids:$ids){... on Product{id title handle status tags variants(first:100){pageInfo{hasNextPage endCursor}nodes{id title sku availableForSale inventoryItem{id}}}}}}`;
const VARIANTS=`query InventoryVariants($id:ID!,$cursor:String!){product(id:$id){variants(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title sku availableForSale inventoryItem{id}}}}}`;
export const LOCATIONS_QUERY=`query InventoryLocations($cursor:String){locations(first:100,after:$cursor,includeLegacy:true){pageInfo{hasNextPage endCursor}nodes{id name isActive fulfillsOnlineOrders}}}`;
const LEVELS=`query InventoryLevels($ids:[ID!]!,$location:ID!){nodes(ids:$ids){... on InventoryItem{id inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}}}`;
const locationGid=value=>{const text=String(value??'').trim();if(!text)return null;return /^gid:\/\/shopify\/Location\/\d+$/.test(text)?text:/^\d+$/.test(text)?`gid://shopify/Location/${text}`:text;};

export function inventoryLocationSelector(env=process.env){
  const configuredId=env.SHOPIFY_INVENTORY_LOCATION_ID||env.SHOPIFY_LOCATION_ID;
  if(configuredId)return{type:'id',value:locationGid(configuredId),configured_by:env.SHOPIFY_INVENTORY_LOCATION_ID?'SHOPIFY_INVENTORY_LOCATION_ID':'SHOPIFY_LOCATION_ID'};
  return{type:'exact_name',value:env.SHOPIFY_INVENTORY_LOCATION_NAME?.trim()||'Online',configured_by:env.SHOPIFY_INVENTORY_LOCATION_NAME?'SHOPIFY_INVENTORY_LOCATION_NAME':'default'};
}

export function resolveInventoryLocation(locations,selector=inventoryLocationSelector({})){
  const candidates=Array.isArray(locations)?locations:[];
  const identityMatches=candidates.filter(location=>selector.type==='id'?location.id===selector.value:location.name===selector.value);
  const eligible=identityMatches.filter(location=>location.isActive&&location.fulfillsOnlineOrders===true);
  if(eligible.length===1)return{location:eligible[0],selector,reason:'one exact configured selector match is active and eligible to fulfil online orders'};
  let reason;
  if(!identityMatches.length)reason=`no location has the configured ${selector.type==='id'?'ID':'exact name'}`;
  else if(identityMatches.length>1)reason='configured selector is not unique';
  else if(!identityMatches[0].isActive)reason='the exact configured location is inactive';
  else reason='the exact configured location is not eligible to fulfil online orders';
  return{location:null,selector,reason,identity_match_count:identityMatches.length};
}

export async function listAndResolveInventoryLocations({call,selector=inventoryLocationSelector(),maxPages=5}){
  const locations=[];let cursor=null,pages=0,truncated=false;
  do{
    const data=await call(LOCATIONS_QUERY,{cursor},'location_page_calls');pages++;
    const connection=data?.locations;if(!connection||!Array.isArray(connection.nodes))throw new Error('Shopify locations response was invalid');
    locations.push(...connection.nodes.map(({id,name,isActive,fulfillsOnlineOrders})=>({id,name,isActive:Boolean(isActive),fulfillsOnlineOrders:Boolean(fulfillsOnlineOrders)})));
    if(!connection.pageInfo?.hasNextPage){cursor=null;break;}
    cursor=connection.pageInfo.endCursor;if(!cursor)throw new Error('Shopify location pagination returned an invalid cursor');
    if(pages>=maxPages){truncated=true;break;}
  }while(cursor);
  return{...resolveInventoryLocation(locations,selector),locations,pages,truncated};
}

/** Exact, read-only Online inventory retrieval. Parent and inventory-item `nodes`
 * queries are genuine batched GraphQL calls; only products with >100 variants
 * need a product-specific pagination call. Diagnostics contain aggregate counts only. */
export function createBatchedInventoryByLocation({graphql,getToken,locationSelector=inventoryLocationSelector(),now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),log=()=>{},parentBatchSize=20,itemBatchSize=100,concurrency=2}){
  return async(parentIds,{deadlineAt=Infinity,signal}={})=>{
    const started=now(),stats={requested_parents:parentIds.length,returned_parents:0,variants:0,network_calls:0,parent_batch_calls:0,variant_page_calls:0,inventory_batch_calls:0,location_page_calls:0,pages:0,throttle_waits:0,throttle_wait_ms:0};
    if(!parentIds.length)return{products:[],requested_count:0,completed_count:0,missing_ids:[],complete:true,diagnostics:{...stats,duration_ms:0,complete:true},as_of:new Date().toISOString(),location:'Online'};
    const token=await getToken();
    const call=async(query,variables,kind)=>{for(let attempt=0;attempt<2;attempt++){if(signal?.aborted)throw Object.assign(new Error('inventory request aborted'),{name:'AbortError'});stats.network_calls++;stats[kind]++;try{return await graphql(token,query,variables);}catch(error){const detail=throttled(error);if(!detail||attempt)return Promise.reject(error);const reset=Date.parse(detail.extensions?.cost?.windowResetAt),waitMs=Number.isFinite(reset)?Math.max(0,reset-now())+350:null,remaining=Number.isFinite(deadlineAt)?deadlineAt-now():Infinity;if(waitMs===null||waitMs>30_000||waitMs+5_000>=remaining)throw Object.assign(error,{code:'INVENTORY_THROTTLE_BUDGET_EXHAUSTED'});stats.throttle_waits++;stats.throttle_wait_ms+=waitMs;await sleep(waitMs);}}};
    const resolution=await listAndResolveInventoryLocations({call,selector:locationSelector});stats.pages+=resolution.pages;
    if(!resolution.location){const diagnostic={selector:resolution.selector,reason:resolution.reason,identity_match_count:resolution.identity_match_count,locations:resolution.locations,truncated:resolution.truncated};log({event:'historical_inventory_location_not_found',...diagnostic});throw Object.assign(new Error('Configured Online inventory location was not found or eligible'),{code:'ONLINE_LOCATION_NOT_FOUND',diagnostic});}
    const onlineLocation=resolution.location;
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
    log({...stats,location_selector:resolution.selector,resolved_location:{id:onlineLocation.id,name:onlineLocation.name,isActive:onlineLocation.isActive,fulfillsOnlineOrders:onlineLocation.fulfillsOnlineOrders}});return{products,requested_count:parentIds.length,completed_count:products.length,missing_ids:parentIds.filter(id=>!products.some(p=>tail(p.id)===tail(id))),complete:stats.complete,diagnostics:stats,as_of:new Date().toISOString(),location:onlineLocation.name,location_id:onlineLocation.id};
  };
}
