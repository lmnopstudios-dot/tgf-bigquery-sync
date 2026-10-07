import {BigQuery} from '@google-cloud/bigquery';
import {createShopifyGraphql,getShopifyAccessToken,loadShopifyConfig} from '../shopify/admin-client.js';
import {createCurrentStockService,createStockGroupLookup} from '../oracle/current-stock.js';
import {createInventoryReadBudget,inventoryDiagnostic} from '../shopify/inventory-budget.js';

// Explicit read-only provider acceptance. No collector, refresh or setup DDL.
export async function diagnoseCurrentStock({env=process.env,fetchImpl=fetch,lookupGroup=null}={}) {
  const deadlineAt=Date.now()+45_000,budget=createInventoryReadBudget({deadlineAt,maxRequests:3});
  try{
    const config=loadShopifyConfig(env),token=await budget.call(signal=>getShopifyAccessToken(config,fetchImpl,signal),'authentication');
    const native=createShopifyGraphql({shop:config.shop,token,fetchImpl});
    const grants=await budget.call(signal=>native('{currentAppInstallation{accessScopes{handle}}}',{},signal),'permission_probe');
    const scopes=(grants?.currentAppInstallation?.accessScopes||[]).map(s=>s.handle).filter(s=>['read_products','read_inventory','read_locations'].includes(s));
    if(!lookupGroup){
      const bigquery=new BigQuery({projectId:env.GOOGLE_PROJECT_ID||'gf-full-data',...(env.GOOGLE_SERVICE_ACCOUNT_JSON?{credentials:JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)}:{})});
      lookupGroup=createStockGroupLookup({bigquery,project:env.GOOGLE_PROJECT_ID||'gf-full-data'});
    }
    const service=createCurrentStockService({graphql:(_token,query,variables,signal)=>native(query,variables,signal),getToken:async()=>token,lookupGroup});
    const result=await service('What is the current stock levels for eye rings?',{deadlineAt});
    const e=result.evidence;
    return{diagnostic:'oracle_current_stock',read_only:true,live_acceptance:true,availability:e.availability,complete:e.complete,ambiguous:e.ambiguous,granted_inventory_scopes:scopes,resolution:e.resolution,product_variant_ids:e.products.map(p=>({product_id:p.id,variant_ids:p.variants.map(v=>v.id),inventory_item_ids:p.variants.map(v=>v.inventory_item_id)})),location_coverage:e.location_coverage,observation_times:[...new Set(e.products.flatMap(p=>p.variants.flatMap(v=>v.locations.map(l=>l.observed_at))).filter(Boolean))],failures:e.failures,diagnostics:e.diagnostics,preflight:budget.finish()};
  }catch(error){return{diagnostic:'oracle_current_stock',read_only:true,live_acceptance:false,availability:'failed',failure:inventoryDiagnostic(error,'production_preflight'),preflight:budget.finish()};}
}
if(import.meta.url===new URL(`file://${process.argv[1]}`).href){
  if(process.argv.length!==2){console.error('This diagnostic accepts no arguments; it only reads current eye-ring inventory.');process.exitCode=1;}
  else diagnoseCurrentStock().then(result=>{console.log(JSON.stringify(result,null,2));if(!result.complete)process.exitCode=1;}).catch(()=>{console.error(JSON.stringify({diagnostic:'oracle_current_stock',read_only:true,code:'DIAGNOSTIC_CONFIGURATION_FAILED'}));process.exitCode=1;});
}
