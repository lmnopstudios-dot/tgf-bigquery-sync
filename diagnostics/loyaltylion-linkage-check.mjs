// Explicit small-sample read; never a roster/history sync or activation.
import {pathToFileURL} from 'node:url';
import {createLoyaltyClient} from '../loyaltylion/client.js';
import {gid} from '../loyaltylion/contracts.js';
import {loadShopifyConfig,getShopifyAccessToken,createShopifyGraphql} from '../shopify/admin-client.js';
export function sampleLinks(customers,transactions){
 const customerIds=new Set(),orderIds=new Set();
 let invalidCustomers=0,invalidOrders=0;
 for(const c of customers){
   let id;try{id=gid('Customer',c.merchant_id);}catch{}
   if(id)customerIds.add(id);else invalidCustomers++;
 }
 for(const t of transactions){
   const merchant=t.activity?.order?.merchant_id;if(merchant==null)continue;
   let id;try{id=gid('Order',merchant);}catch{}
   if(id)orderIds.add(id);else invalidOrders++;
 }
 return {customerIds:[...customerIds],orderIds:[...orderIds],invalidCustomers,invalidOrders};
}
export async function checkLinkage({env=process.env,fetchImpl=fetch}={}){
 const signal=AbortSignal.timeout(60000);
 const vendor=createLoyaltyClient({key:env.LOYALTYLION_API_KEY,fetchImpl,signal,
   limits:{max_calls:4,max_pages:1,max_rows:20,max_ms:55000,requests_per_second:4,retries:0}});
 const identity=(await vendor.get('identity/whoami')).identity;
 if(!identity?.scopes?.includes('read_customers')||!identity.scopes.includes('read_orders'))throw Error('LINKAGE_SCOPE_UNVERIFIED');
 const sites=(await vendor.get('sites')).sites;
 const config=loadShopifyConfig(env),token=await getShopifyAccessToken(config,fetchImpl,signal);
 const graphql=createShopifyGraphql({shop:config.shop,token,fetchImpl});
 const shop=(await graphql('query LinkageShop {shop{myshopifyDomain primaryDomain{host}}}',{},signal)).shop;
 const domains=new Set([shop?.myshopifyDomain,shop?.primaryDomain?.host].filter(Boolean));
 const matching=(sites??[]).filter(s=>{
   try{return String(s.program_id)===String(identity.program_id)&&s.platform==='shopify'&&domains.has(new URL(s.url).hostname);}catch{return false;}
 });
 if(matching.length!==1)throw Error('LINKAGE_SITE_UNVERIFIED');
 const c=await vendor.get('customers',{limit:5}),t=await vendor.get('transactions',{limit:20});
 if(!Array.isArray(c.customers)||c.customers.length>5||!Array.isArray(t.transactions)||t.transactions.length>20)
   throw Error('LINKAGE_RESPONSE_UNVERIFIED');
 const links=sampleLinks(c.customers,t.transactions),ids=[...links.customerIds,...links.orderIds];
 const nodes=ids.length?(await graphql('query LinkageNodes($ids:[ID!]!){nodes(ids:$ids){id __typename}}',{ids},signal)).nodes:[];
 if(!Array.isArray(nodes)||nodes.length!==ids.length)throw Error('LINKAGE_SHOPIFY_UNVERIFIED');
 const matches=(list,type)=>list.filter(id=>nodes.some(n=>n?.id===id&&n.__typename===type)).length;
 return {read_only:true,collection_enabled:false,reporting_enabled:false,warehouse_writes:false,
   sample_only:true,roster_or_history_complete:false,account_site_correspondence:'verified',
   sampled_customers:c.customers.length,sampled_transactions:t.transactions.length,
   valid_customer_ids:links.customerIds.length,matched_customer_ids:matches(links.customerIds,'Customer'),
   valid_order_ids:links.orderIds.length,matched_order_ids:matches(links.orderIds,'Order'),
   invalid_customer_ids:links.invalidCustomers,invalid_order_ids:links.invalidOrders,
   merchant_id_contract_review_required:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
 checkLinkage().then(x=>console.log(JSON.stringify(x))).catch(()=>{
   console.error(JSON.stringify({read_only:true,status:'unverified',collection_enabled:false,reporting_enabled:false,
     reason:'scope_site_transport_or_sample_unavailable'}));process.exitCode=1;
 });
