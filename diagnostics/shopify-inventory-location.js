import {createShopifyGraphql,getShopifyAccessToken,loadShopifyConfig} from '../shopify/admin-client.js';
import {inventoryLocationSelector,listAndResolveInventoryLocations} from '../shopify/inventory-by-location.js';

export async function diagnoseShopifyInventoryLocation({env=process.env,fetchImpl=fetch}={}){
  const config=loadShopifyConfig(env);
  const token=await getShopifyAccessToken(config,fetchImpl);
  const graphql=createShopifyGraphql({shop:config.shop,token,fetchImpl});
  const selector=inventoryLocationSelector(env);
  const result=await listAndResolveInventoryLocations({call:(query,variables)=>graphql(query,variables),selector,maxPages:5});
  return{
    diagnostic:'shopify_inventory_location',
    read_only:true,
    bounded:{page_size:100,max_pages:5,returned_locations:result.locations.length,truncated:result.truncated},
    configured_selector:result.selector,
    resolution:{matched:Boolean(result.location),reason:result.reason,location:result.location},
    locations:result.locations
  };
}

if(import.meta.url===new URL(`file://${process.argv[1]}`).href){
  diagnoseShopifyInventoryLocation().then(result=>{console.log(JSON.stringify(result,null,2));if(!result.resolution.matched)process.exitCode=1;}).catch(error=>{console.error(JSON.stringify({diagnostic:'shopify_inventory_location',read_only:true,status:'failed',code:error.code||error.name||'DIAGNOSTIC_FAILED',message:String(error.message||error).slice(0,200)},null,2));process.exitCode=1;});
}
