import test from 'node:test';
import assert from 'node:assert/strict';
import {preparePrivateLoyaltyConfig} from '../diagnostics/loyaltylion-private-preflight.mjs';

const env={LOYALTYLION_API_KEY:'SECRET_API_KEY',SHOPIFY_SHOP:'fixture',SHOPIFY_CLIENT_ID:'SECRET_CLIENT',SHOPIFY_CLIENT_SECRET:'SECRET_SECRET'};
function fixture({multi=false,mismatch=false,region='US',targetCode=null,exportsCode=null,write=false}={}){
 const calls=[],datasets=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});assert.equal(options.redirect,'error');
  let body;
  if(url.endsWith('/identity/whoami'))body={identity:{kind:'api_key',account_id:1,program_id:2,scopes:['read_customers','read_orders',...(write?['write_customers']:[])]}};
  else if(url.endsWith('/sites'))body={sites:Array.from({length:multi?2:1},(_,i)=>({id:i+3,account_id:1,program_id:2,platform:'shopify',url:mismatch?'https://different.example':'https://store.example'}))};
  else if(url.includes('/customers/exports?')){if(exportsCode)return new Response('{}',{status:exportsCode});body={exports:[{status:'completed',row_count:12000,completed_at:'2026-11-05T12:00:00Z',download_url:'SECRET_URL',filters:{email:'PRIVATE_EMAIL'}}]};}
  else if(url.endsWith('/oauth/access_token'))body={access_token:'SECRET_SHOP_TOKEN'};
  else{const query=JSON.parse(options.body).query;assert.equal(query,'query LoyaltyPreflightShop { shop { myshopifyDomain primaryDomain { host } } }');body={data:{shop:{myshopifyDomain:'fixture.myshopify.com',primaryDomain:{host:'store.example'}}}};}
  return new Response(JSON.stringify(body),{status:200});
 };
 const bigquery={dataset:name=>{datasets.push(name);return{getMetadata:async()=>{if(name==='loyaltylion'&&targetCode)throw Object.assign(Error('PRIVATE_INTERNAL'),{code:targetCode});return[{location:name==='loyaltylion'?region:'US'}]}}}};
 return {fetchImpl,bigquery,calls,datasets};
}
test('metadata correspondence and colocation prepare a private disabled config, never approval or source collection',async()=>{
 const f=fixture(),r=await preparePrivateLoyaltyConfig({env,...f});
 assert.equal(r.summary.account_site_shopify_correspondence,'verified_by_metadata');assert.equal(r.summary.warehouse_colocation,'verified');assert.equal(f.calls.length,5);
 assert.deepEqual(f.datasets,['shopify_data','loyaltylion']);assert.equal(r.privateDocument.config.account_id,'1');assert.equal(r.privateDocument.config.site_id,'3');
 assert.equal(r.privateDocument.config.access_status,'unverified');assert.equal(r.privateDocument.config.merchant_ids_verified,false);assert.equal(r.privateDocument.config.initial_sync,null);assert.equal(r.summary.ready_to_sync,false);
 assert.equal(r.summary.latest_export_snapshot_rows,12000);assert.equal(r.summary.roster_current_count,null);assert.equal(r.summary.roster_current_count_verified,false);
 assert.doesNotMatch(JSON.stringify(r),/SECRET_|PRIVATE_EMAIL|PRIVATE_INTERNAL|download_url/);
 assert.doesNotMatch(JSON.stringify(r.summary),/account_id|program_id|site_id|store\.example|fixture\.myshopify/);
 assert(f.calls.every(c=>!new URL(c.url).pathname.endsWith('/customers')&&!new URL(c.url).pathname.endsWith('/transactions')));
});
for(const [name,options,expected] of [
 ['multiple sites',{multi:true},'vendor_identity_or_site_unverified'],
 ['wrong Shopify site',{mismatch:true},'site_shopify_domain_correspondence_unverified'],
 ['region mismatch',{region:'EU'},'destination_region_or_access_unverified'],
 ['inaccessible destination',{targetCode:403},'destination_region_or_access_unverified'],
 ['missing or hidden destination',{targetCode:404},'destination_region_or_access_unverified'],
 ['write-scoped key',{write:true},'vendor_identity_or_site_unverified']
])test(name+' cannot become verified sync access',async()=>{const f=fixture(options),r=await preparePrivateLoyaltyConfig({env,...f});assert(r.summary.blocking_findings.includes(expected));assert.equal(r.summary.ready_to_sync,false);assert.equal(r.privateDocument.config.access_status,'unverified');});
test('unavailable export metadata is unknown coverage; no customer/count/export fallback',async()=>{const f=fixture({exportsCode:403}),r=await preparePrivateLoyaltyConfig({env,...f});assert.equal(r.summary.export_metadata_access,'unavailable');assert.equal(r.summary.roster_current_count,null);assert.equal(f.calls.length,5);});
test('missing credentials make no vendor or Shopify requests',async()=>{const f=fixture();const r=await preparePrivateLoyaltyConfig({env:{},...f});assert.equal(f.calls.length,0);assert.equal(r.summary.ready_to_sync,false);});
