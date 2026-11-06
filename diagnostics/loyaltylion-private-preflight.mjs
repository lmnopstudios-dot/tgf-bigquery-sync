// Operator-only metadata preflight. No collection, dataset provisioning or activation.
import {BigQuery} from '@google-cloud/bigquery';
import {mkdtemp,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export async function preparePrivateLoyaltyConfig({env,fetchImpl=fetch,bigquery,now=()=>new Date().toISOString()}={}) {
 const config={version:1,access_status:'unverified',reviewed_by:null,reviewed_at:null,
  account_id:null,program_id:null,site_id:null,shopify_shop:null,site_url:null,
  merchant_ids_verified:false,dataset:'loyaltylion',timezone:'Europe/London',initial_sync:null,
  limits:{max_calls:40,max_pages:30,max_rows:10000,max_ms:120000,requests_per_second:4,retries:2},
  historical_exports:{status:'unverified',tier_history:'unavailable',reward_usage:'unavailable'}};
 const summary={authentication:'unverified',required_read_scopes:false,write_scopes_present:null,
  account_site_shopify_correspondence:'unverified',warehouse_colocation:'unverified',
  shopify_dataset_access:'unverified',destination_dataset_access:'unverified',
  roster_current_count:null,roster_current_count_verified:false,latest_export_snapshot_rows:null,
  export_metadata_access:'unverified',collection_enabled:false,reporting_enabled:false,
  customer_records_downloaded:false,warehouse_queries_executed:false,setup_or_sync_started:false};
 const failures=[];let calls=0,identity,site,shop;
 const fail=code=>{throw Object.assign(Error(code),{code});};
 const id=value=>{if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0)return String(value);if(typeof value==='string'&&/^\d+$/.test(value))return value;fail('UNSAFE_ID');};
 const host=value=>{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port||url.pathname!=='/')fail('SITE_URL_UNSUPPORTED');return url.hostname.toLowerCase();};
 const json=async(url,options={})=>{
  if(++calls>5)fail('CALL_BOUND');
  const r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok){await r.body?.cancel();fail(r.status===401?'AUTH_REJECTED':r.status===403?'PERMISSION_UNAVAILABLE':'HTTP_UNAVAILABLE');}
  const chunks=[];let bytes=0;for await(const c of r.body){bytes+=c.byteLength;if(bytes>1000000)fail('METADATA_SIZE_BOUND');chunks.push(c);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 };
 const vendor=path=>json('https://api.loyaltylion.com/v2/'+path,{method:'GET',headers:{Authorization:`Bearer ${env.LOYALTYLION_API_KEY}`}});
 if(env.LOYALTYLION_API_KEY){
  try{identity=(await vendor('identity/whoami')).identity;config.account_id=id(identity.account_id);config.program_id=id(identity.program_id);
   const scopes=identity.scopes;if(!Array.isArray(scopes)||scopes.some(s=>typeof s!=='string'))fail('SCOPES_UNAVAILABLE');
   summary.authentication='verified';summary.required_read_scopes=['read_customers','read_orders'].every(s=>scopes.includes(s));summary.write_scopes_present=scopes.some(s=>s==='all'||s.startsWith('write_'));
   if(!summary.required_read_scopes||summary.write_scopes_present)fail('READ_ONLY_SCOPE_REVIEW_REQUIRED');
   const sites=(await vendor('sites')).sites;
   if(!Array.isArray(sites)||sites.length!==1)fail('SINGLE_SITE_REQUIRED');
   site=sites[0];if(id(site.account_id)!==config.account_id||id(site.program_id)!==config.program_id||site.platform!=='shopify')fail('SITE_IDENTITY_MISMATCH');
   host(site.url);config.site_id=id(site.id);config.site_url=new URL(site.url).origin;
  }catch(e){failures.push('vendor_identity_or_site_unverified');site=null;}
  try{const exports=await vendor('customers/exports?limit=5');if(!Array.isArray(exports.exports)||exports.exports.length>5)fail('EXPORT_METADATA_INVALID');
   summary.export_metadata_access='accessible';
   // Historical metadata is never certified as a current complete-roster count.
   const candidates=exports.exports.filter(e=>['completed','complete'].includes(e.status)&&Number.isSafeInteger(e.row_count)&&e.row_count>=0&&Number.isFinite(Date.parse(e.completed_at)))
    .sort((a,b)=>Date.parse(b.completed_at)-Date.parse(a.completed_at));
   summary.latest_export_snapshot_rows=candidates[0]?.row_count??null;
  }catch{summary.export_metadata_access='unavailable';}
 }else failures.push('loyalty_key_unavailable_in_this_process');
 const slug=env.SHOPIFY_SHOP;
 if(/^[a-z0-9-]+$/.test(slug||'')&&(env.SHOPIFY_ACCESS_TOKEN||(env.SHOPIFY_CLIENT_ID&&env.SHOPIFY_CLIENT_SECRET))){
  try{let token=env.SHOPIFY_ACCESS_TOKEN;
   if(!token){const auth=await json(`https://${slug}.myshopify.com/admin/oauth/access_token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:env.SHOPIFY_CLIENT_ID,client_secret:env.SHOPIFY_CLIENT_SECRET})});token=auth.access_token;if(typeof token!=='string'||!token)fail('SHOPIFY_AUTH_UNAVAILABLE');}
   const body=await json(`https://${slug}.myshopify.com/admin/api/2026-07/graphql.json`,{method:'POST',headers:{'content-type':'application/json','x-shopify-access-token':token},body:JSON.stringify({query:'query LoyaltyPreflightShop { shop { myshopifyDomain primaryDomain { host } } }'})});
   if(body.errors||!body.data?.shop)fail('SHOPIFY_METADATA_UNAVAILABLE');shop=body.data.shop;
   if(shop.myshopifyDomain!==`${slug}.myshopify.com`)fail('SHOPIFY_CONFIG_MISMATCH');
   config.shopify_shop=shop.myshopifyDomain;
   if(site&&[shop.myshopifyDomain,shop.primaryDomain?.host].includes(host(site.url)))summary.account_site_shopify_correspondence='verified_by_metadata';
   else failures.push('site_shopify_domain_correspondence_unverified');
  }catch{failures.push('shopify_shop_metadata_unavailable');}
 }else failures.push('shopify_credentials_unavailable');
 const metadata=async name=>{
  let timer;try{const [m]=await Promise.race([bigquery.dataset(name).getMetadata(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('deadline')),10000);})]);return {status:'accessible',location:m.location};}
  catch(e){return {status:e.code===404?'not_found_or_hidden':e.code===403?'permission_unavailable':'unavailable',location:null};}finally{clearTimeout(timer);}
 };
 const source=await metadata('shopify_data'),target=await metadata(config.dataset);
 summary.shopify_dataset_access=source.status;summary.destination_dataset_access=target.status;
 if(source.status==='accessible'&&target.status==='accessible'&&typeof source.location==='string'&&typeof target.location==='string')summary.warehouse_colocation=source.location===target.location?'verified':'mismatch';
 if(summary.warehouse_colocation!=='verified')failures.push('destination_region_or_access_unverified');
 const proposal={status:'proposed_not_authorized',resources:['customers','transactions'],
  start_at:'2026-11-01T00:00:00.000Z',end_exclusive:'2026-11-06T00:00:00.000Z',
  expected_customer_count:null,expected_transaction_count:null,collection_enabled:false,reporting_enabled:false,
  complete_roster_policy:'No sampling. Exceeding 10000 rows, page/call/time/payload bounds or invalid pagination stops before customer promotion; points are then not attempted.',
  transaction_failure_policy:'A later points failure preserves any committed complete roster; no automatic replay or coverage certification for the failed resource.',
  shared_attempt_budget:40,max_rows_per_resource:10000,max_pages_per_resource:30,page_size:500,
  max_ms:120000,requests_per_second:4,retries:2,payload_bytes_per_resource:4000000};
 return {privateDocument:{config,proposal,evidence:{checked_at:now(),...summary,source_location:source.location,target_location:target.location}},
  summary:{...summary,metadata_http_calls:calls,blocking_findings:[...new Set([...failures,'merchant_id_contract_review_required','initial_sync_approval_required'])],pilot_count_policy:'bounded_complete_roster_or_fail_closed',ready_to_sync:false}};
}

async function main(){
 if(process.argv.slice(2).some(a=>a!=='--prepare'))throw Error('Invalid mode');
 const env={...process.env,LOYALTYLION_COLLECTION_ENABLED:'false',LOYALTYLION_REPORTING_ENABLED:'false'};
 const credentials=env.GOOGLE_SERVICE_ACCOUNT_JSON?JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON):undefined;
 const project=env.GOOGLE_PROJECT_ID||credentials?.project_id;if(!project)throw Error('Missing project');
 const bigquery=new BigQuery({projectId:project,credentials,autoRetry:false,maxRetries:0});
 const result=await preparePrivateLoyaltyConfig({env,bigquery});
 const dir=await mkdtemp(join(tmpdir(),'tgf-loyaltylion-presync-'));await chmod(dir,0o700);
 const path=join(dir,'config.disabled.json');await writeFile(path,JSON.stringify(result.privateDocument,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({...result.summary,private_config_file:path},null,2));
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)main().catch(()=>{console.error(JSON.stringify({status:'preflight_unavailable',ready_to_sync:false,collection_enabled:false,reporting_enabled:false}));process.exitCode=1;});
