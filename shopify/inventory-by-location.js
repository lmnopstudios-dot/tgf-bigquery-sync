import {createInventoryReadBudget,inventoryDiagnostic} from './inventory-budget.js';
const chunk=(values,size)=>{const out=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;};
const tail=value=>String(value??'').replace(/^shopify:shopify:/,'').replace(/^gid:\/\/shopify\/Product\//,'');
const productGid=value=>`gid://shopify/Product/${tail(value)}`;

// `publishedOnCurrentPublication` is not present in the Admin API schema used by
// the deployed 2026-07 endpoint. Keeping it in this otherwise valid operation
// makes GraphQL reject the whole request before returning any product. Do not
// substitute a publication claim: the MTO presentation layer treats it as
// unknown until a publication-scoped query is deliberately implemented.
export const INVENTORY_PRODUCTS_QUERY=`query InventoryProducts($ids:[ID!]!){nodes(ids:$ids){... on Product{id title handle status tags onlineStoreUrl variants(first:20){pageInfo{hasNextPage endCursor}nodes{id title sku availableForSale inventoryPolicy inventoryItem{id tracked}}}}}}`;
const VARIANTS=`query InventoryVariants($id:ID!,$cursor:String!){product(id:$id){variants(first:50,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id title sku availableForSale inventoryPolicy inventoryItem{id tracked}}}}}`;
export const LOCATIONS_QUERY=`query InventoryLocations($cursor:String){locations(first:100,after:$cursor,includeLegacy:true){pageInfo{hasNextPage endCursor}nodes{id name isActive fulfillsOnlineOrders}}}`;
const LEVELS=`query InventoryLevels($ids:[ID!]!,$location:ID!){nodes(ids:$ids){... on InventoryItem{id inventoryLevel(locationId:$location){quantities(names:["available","on_hand","committed"]){name quantity}}}}}`;
const locationGid=value=>{const text=String(value??'').trim();if(!text)return null;return /^gid:\/\/shopify\/Location\/\d+$/.test(text)?text:/^\d+$/.test(text)?`gid://shopify/Location/${text}`:text;};

export function inventoryLocationSelector(env=process.env){
  const configuredId=env.SHOPIFY_INVENTORY_LOCATION_ID||env.SHOPIFY_LOCATION_ID;
  if(configuredId)return{type:'id',value:locationGid(configuredId),configured_by:env.SHOPIFY_INVENTORY_LOCATION_ID?'SHOPIFY_INVENTORY_LOCATION_ID':'SHOPIFY_LOCATION_ID'};
  return{type:'exact_name',value:env.SHOPIFY_INVENTORY_LOCATION_NAME?.trim()||'Online',configured_by:env.SHOPIFY_INVENTORY_LOCATION_NAME?'SHOPIFY_INVENTORY_LOCATION_NAME':'default'};
}

/** Convert an Oracle location argument into the same strict selector used by
 * durable inventory analysis. `null` and the legacy UI label "Online" mean
 * the configured fulfilment location; they never mean every location. */
export function inventoryLocationSelectorForRequest(requestedLocation,configured=inventoryLocationSelector()){
  if(requestedLocation==null||/^online$/i.test(String(requestedLocation).trim()))return configured;
  const value=String(requestedLocation).trim();
  if(!value)throw new Error('location must be null or a non-empty string');
  return{type:'exact_name',value,configured_by:'request',eligibility:'active'};
}

export function resolveInventoryLocation(locations,selector=inventoryLocationSelector({})){
  const candidates=Array.isArray(locations)?locations:[];
  const identityMatches=candidates.filter(location=>selector.type==='id'?location.id===selector.value:location.name===selector.value);
  const eligible=identityMatches.filter(location=>location.isActive&&(selector.eligibility==='active'||location.fulfillsOnlineOrders===true));
  if(eligible.length===1)return{location:eligible[0],selector,reason:selector.eligibility==='active'?'one exact requested location is active':'one exact configured selector match is active and eligible to fulfil online orders'};
  let reason;
  if(!identityMatches.length)reason=`no location has the configured ${selector.type==='id'?'ID':'exact name'}`;
  else if(identityMatches.length>1)reason='configured selector is not unique';
  else if(!identityMatches[0].isActive)reason='the exact configured location is inactive';
  else reason=selector.eligibility==='active'?'the exact requested location is inactive':'the exact configured location is not eligible to fulfil online orders';
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
 * queries are genuine batched GraphQL calls; only products with >20 variants
 * need a product-specific pagination call. Diagnostics contain aggregate counts only. */
export function createBatchedInventoryByLocation({graphql,getToken,locationSelector=inventoryLocationSelector(),now=Date.now,sleep,log=()=>{},parentBatchSize=5,itemBatchSize=50,concurrency=2}){
  // Keep nested parent query cost below Shopify's 1,000-point ceiling.
  parentBatchSize=Math.max(1,Math.min(5,parentBatchSize));itemBatchSize=Math.max(1,Math.min(50,itemBatchSize));concurrency=Math.max(1,Math.min(2,concurrency));
  return async(parentIds,{deadlineAt=now()+45_000,signal,allLocations=false,variantIds=null,maxRequests=40,maxVariantPages=5,maxVariants=500,maxLocations=10}={})=>{
    deadlineAt=Math.min(deadlineAt,now()+45_000);
    maxRequests=Math.max(1,Math.min(40,maxRequests));maxVariantPages=Math.max(1,Math.min(5,maxVariantPages));maxVariants=Math.max(1,Math.min(500,maxVariants));maxLocations=Math.max(1,Math.min(10,maxLocations));
    parentIds=[...new Set(parentIds)];
    if(parentIds.length>25)throw Object.assign(new Error('Inventory product bound exceeded'),{code:'INVENTORY_PRODUCT_LIMIT'});
    const budget=createInventoryReadBudget({deadlineAt,signal,maxRequests,now,...(sleep?{sleep}:{})}),stats={requested_parents:parentIds.length,returned_parents:0,variants:0,network_calls:0,parent_batch_calls:0,variant_page_calls:0,inventory_batch_calls:0,location_page_calls:0,pages:0,throttle_waits:0,throttle_wait_ms:0};
    const products=[],failures=[],observed=new Map();let locations=[],resolution=null,token;
    const call=(query,vars,kind)=>budget.call(async child=>{stats.network_calls++;stats[kind]++;const data=await graphql(token,query,vars,child);stats.pages++;return data;},kind);
    const mapConcurrent=async(values,fn)=>{let next=0;await Promise.all(Array.from({length:Math.min(concurrency,values.length)},async()=>{while(next<values.length){const value=values[next++];try{await fn(value);}catch(error){failures.push({...inventoryDiagnostic(error,'evidence_retrieval'),...(value?.location?{location_id:value.location.id}:{})});}}}));};
    try{
      if(parentIds.length){
        token=await budget.call(child=>getToken(child),'authentication');
        resolution=await listAndResolveInventoryLocations({call,selector:locationSelector,maxPages:2});
        if(resolution.truncated)failures.push({stage:'location_resolution',code:'INVENTORY_LOCATION_PAGE_LIMIT'});
        locations=allLocations?resolution.locations.filter(l=>l.isActive).slice(0,maxLocations):resolution.location?[resolution.location]:[];
        if(allLocations&&resolution.locations.filter(l=>l.isActive).length>maxLocations)failures.push({stage:'location_resolution',code:'INVENTORY_LOCATION_LIMIT'});
        if(!locations.length)throw Object.assign(new Error('Inventory location unavailable'),{code:'ONLINE_LOCATION_NOT_FOUND'});
        await mapConcurrent(chunk(parentIds,parentBatchSize),async ids=>{
          const data=await call(INVENTORY_PRODUCTS_QUERY,{ids:ids.map(productGid)},'parent_batch_calls');
          if(!Array.isArray(data?.nodes))throw Object.assign(new Error('Invalid parent response'),{code:'INVENTORY_INVALID_RESPONSE'});
          products.push(...data.nodes.filter(Boolean).map(p=>({...p,variants:p.variants.nodes,variant_page_info:p.variants.pageInfo})));
        });
        // Pagination failure retains already observed variants, never claims completeness.
        for(const product of products){
          let info=product.variant_page_info,pages=1;const seen=new Set();
          try{while(info?.hasNextPage){
            if(pages>=maxVariantPages||product.variants.length>=maxVariants)throw Object.assign(new Error('Variant bound'),{code:'INVENTORY_VARIANT_PAGE_LIMIT'});
            if(!info.endCursor||seen.has(info.endCursor))throw Object.assign(new Error('Invalid cursor'),{code:'INVENTORY_INVALID_CURSOR'});
            seen.add(info.endCursor);const page=await call(VARIANTS,{id:product.id,cursor:info.endCursor},'variant_page_calls');pages++;
            if(!Array.isArray(page?.product?.variants?.nodes))throw Object.assign(new Error('Missing product'),{code:'INVENTORY_PRODUCT_UNAVAILABLE'});
            product.variants.push(...page.product.variants.nodes);info=page.product.variants.pageInfo;
          }}catch(error){failures.push(inventoryDiagnostic(error,'variant_pagination'));}
          delete product.variant_page_info;
          if(variantIds)product.variants=product.variants.filter(v=>variantIds.includes(v.id));
        }
        let retained=0;
        for(const p of products){const keep=Math.max(0,maxVariants-retained);if(p.variants.length>keep){failures.push({stage:'inventory_retrieval',code:'INVENTORY_VARIANT_LIMIT',omitted_variant_count:p.variants.length-keep});p.variants=p.variants.slice(0,keep);}retained+=p.variants.length;}
        let items=[...new Set(products.flatMap(p=>p.variants.filter(v=>v.inventoryItem?.tracked!==false).map(v=>v.inventoryItem?.id).filter(Boolean)))];
        if(items.length>maxVariants){items=items.slice(0,maxVariants);failures.push({stage:'inventory_retrieval',code:'INVENTORY_VARIANT_LIMIT'});}
        // Location-specific nodes avoid fetching all inventory levels per variant.
        await mapConcurrent(locations.flatMap(location=>chunk(items,itemBatchSize).map(ids=>({location,ids}))),async({location,ids})=>{
          const data=await call(LEVELS,{ids,location:location.id},'inventory_batch_calls');
          if(!Array.isArray(data?.nodes))throw Object.assign(new Error('Invalid levels'),{code:'INVENTORY_INVALID_RESPONSE'});
          const at=new Date(now()).toISOString();
          for(const item of data.nodes.filter(Boolean))observed.set(`${item.id}|${location.id}`,{level:item.inventoryLevel,observed_at:at});
        });
      }
    }catch(error){failures.push(inventoryDiagnostic(error,'evidence_retrieval'));}
    for(const p of products){p.is_made_to_order=(p.tags||[]).some(t=>/^made[- ]to[- ]order$/i.test(t));p.variants=p.variants.map(v=>({...v,inventory_tracked:v.inventoryItem?.tracked??null,inventory_item_id:v.inventoryItem?.id??null,locations:locations.map(l=>{
      const value=observed.get(`${v.inventoryItem?.id}|${l.id}`),quantities=value?.level?.quantities;
      const quantity=name=>{const n=quantities?.find(q=>q.name===name)?.quantity;return typeof n==='number'&&Number.isFinite(n)?n:null;};
      const available=quantity('available');
      return {location_id:l.id,location_name:l.name,available,on_hand:quantity('on_hand'),committed:quantity('committed'),observed_at:value?.observed_at??null,evidence_state:v.inventoryItem?.tracked===false?'untracked':available!=null?'observed':value?'unavailable':'failed'};
    })}));}
    const missing=parentIds.filter(id=>!products.some(p=>tail(p.id)===tail(id)));
    if(missing.length)failures.push({stage:'product_retrieval',code:'INVENTORY_PRODUCTS_MISSING'});
    const rows=products.flatMap(p=>p.variants.flatMap(v=>v.locations));
    const complete=parentIds.length>0&&products.length>0&&rows.length>0&&!failures.length&&rows.every(r=>r.evidence_state==='observed'||r.evidence_state==='untracked');
    stats.returned_parents=products.length;stats.variants=products.reduce((n,p)=>n+p.variants.length,0);
    const diagnostics={...stats,...budget.finish(),complete};diagnostics.throttle_waits=diagnostics.retry_count;
    log(diagnostics);
    return {products,requested_count:parentIds.length,completed_count:products.length,missing_ids:missing,complete,availability:complete?'complete':rows.some(r=>r.evidence_state==='observed')?'partial':failures.length?'failed':'unavailable',failures,diagnostics,as_of:new Date(now()).toISOString(),source:'live_shopify_admin',location:allLocations?null:locations[0]?.name??null,location_id:allLocations?null:locations[0]?.id??null,resolved_location:allLocations?null:locations[0]??null,location_coverage:{requested:allLocations?'all_active':locationSelector,resolved:locations.map(l=>({id:l.id,name:l.name})),observed:locations.filter(l=>rows.some(r=>r.location_id===l.id&&r.evidence_state==='observed')).map(l=>({id:l.id,name:l.name})),complete}};
  };
}
