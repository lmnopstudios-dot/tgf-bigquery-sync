import {createHash} from 'node:crypto';
export const fail=code=>Object.assign(Error(code),{code});
export const identifier=value=>{if(typeof value!=='string'||!value||value.length>200)throw fail('LOYALTY_INVALID_ID');return value;};
export const instant=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw fail('LOYALTY_INVALID_TIMESTAMP');return new Date(value).toISOString();};
export const exactId=value=>{if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)throw fail('LOYALTY_UNSAFE_ID');return String(value);}return identifier(value);};
export const points=value=>{if(!Number.isSafeInteger(value))throw fail('LOYALTY_INVALID_POINTS');return value;};
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const gid=(type,value)=>{if(value==null||value==='')return null;const s=exactId(value);if(new RegExp(`^gid://shopify/${type}/[1-9][0-9]*$`).test(s))return s;if(/^[1-9][0-9]*$/.test(s))return `gid://shopify/${type}/${s}`;return null;};
export function validateConfig(c,{reviewed=false}={}){
 if(!c||c.version!==1||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.dataset||'')||c.timezone!=='Europe/London')throw fail('LOYALTY_INVALID_CONFIG');
 const caps={max_calls:200,max_pages:100,max_rows:50000,max_ms:300000,requests_per_second:4,retries:3};
 for(const [k,max]of Object.entries(caps))if(!Number.isInteger(c.limits?.[k])||c.limits[k]<(k==='retries'?0:1)||c.limits[k]>max)throw fail('LOYALTY_INVALID_BOUNDS');
 if(reviewed&&(c.access_status!=='reviewed'||!c.reviewed_by||!Number.isFinite(Date.parse(c.reviewed_at))||!/^\d+$/.test(c.account_id||'')||!/^\d+$/.test(c.program_id||'')||!/^\d+$/.test(c.site_id||'')||!/^[a-z0-9-]+\.myshopify\.com$/.test(c.shopify_shop||'')||!/^https:\/\/[^/]+\/?$/.test(c.site_url||'')||c.merchant_ids_verified!==true))throw fail('LOYALTY_ACCESS_NOT_REVIEWED');
 return c;
}
export function rosterStagingPlan(c){return stagingPlan(c.roster_staging);}
export function transactionStagingPlan(c){return stagingPlan(c.transaction_staging);}
function stagingPlan(p){
 if(!p)return null;
 const caps={max_rows:100000,max_pages:250,max_calls:300,max_ms:900000,max_bytes:64000000,page_bytes:2000000};
 if(!p.reviewed_by||!Number.isFinite(Date.parse(p.reviewed_at)))throw fail('LOYALTY_STAGING_PLAN_NOT_REVIEWED');
 for(const [k,cap]of Object.entries(caps))if(!Number.isInteger(p[k])||p[k]<1||p[k]>cap)throw fail('LOYALTY_STAGING_BOUNDS');
 return p;
}
export function collectionGate(c,env,{apply=false}={}){
 validateConfig(c,{reviewed:true});rosterStagingPlan(c);transactionStagingPlan(c);
 if(!apply||env.LOYALTYLION_COLLECTION_ENABLED!=='true')throw fail('LOYALTY_COLLECTION_DISABLED');
 const plan=c.initial_sync;
 if(!plan||!plan.reviewed_by||!Number.isFinite(Date.parse(plan.reviewed_at))||!Array.isArray(plan.resources)||!plan.resources.length||plan.resources.some(r=>!['customers','transactions'].includes(r))||new Set(plan.resources).size!==plan.resources.length)throw fail('LOYALTY_SYNC_PLAN_NOT_REVIEWED');
 const start=instant(plan.start_at),end=instant(plan.end_exclusive);
 if(start>=end||Date.parse(end)-Date.parse(start)>32*86400000)throw fail('LOYALTY_SYNC_WINDOW_INVALID');
 return {...plan,start_at:start,end_exclusive:end};
}
export function normalizeCustomer(c,run){
 const row={program_id:run.program_id,customer_ref_id:exactId(c.id),merchant_id:typeof c.merchant_id==='string'?c.merchant_id:null,shopify_customer_gid:gid('Customer',c.merchant_id),enrolled:c.enrolled,guest:c.guest,blocked:c.blocked,enrolled_at:c.enrolled_at==null?null:instant(c.enrolled_at),approved:points(c.points_approved),pending:points(c.points_pending),spent:points(c.points_spent),tier_id:c.loyalty_tier_membership?.loyalty_tier?.id==null?null:exactId(c.loyalty_tier_membership.loyalty_tier.id),tier_name:c.loyalty_tier_membership?.loyalty_tier?.name??null,source_updated_at:instant(c.updated_at),observed_at:run.observed_at,run_id:run.run_id};
 if(['enrolled','guest','blocked'].some(k=>typeof row[k]!=='boolean')||row.tier_name!=null&&(typeof row.tier_name!=='string'||row.tier_name.length>160))throw fail('LOYALTY_INVALID_CUSTOMER');
 // Aliases and PII are deliberately not used to merge profiles in this release.
 return row;
}
export function normalizeTransaction(t,run){
 if(!['activity','adjustment','expiry','claimed_reward'].includes(t.resource))throw fail('LOYALTY_UNSUPPORTED_TRANSACTION');
 const activity=t.activity,order=activity?.order,claim=t.claimed_reward;
 const row={program_id:run.program_id,transaction_id:exactId(t.id),customer_ref_id:exactId(t.customer?.id),shopify_customer_gid:gid('Customer',t.customer?.merchant_id),created_at:instant(t.created_at),approved_delta:points(t.points_approved),pending_delta:points(t.points_pending),resource:t.resource,activity_id:activity?.id==null?null:exactId(activity.id),shopify_order_gid:order?.merchant_id==null?null:gid('Order',order.merchant_id),observed_at:run.observed_at,run_id:run.run_id};
 const immutable={...row};delete immutable.observed_at;delete immutable.run_id;row.delta_hash=hash(immutable);
 const reward=claim?{program_id:run.program_id,claim_id:exactId(claim.id),customer_ref_id:row.customer_ref_id,claimed_at:instant(claim.claimed_at),point_cost:points(claim.point_cost),reward_kind:claim.reward?.kind||'unknown',state_observed:claim.state||'unknown',observed_at:run.observed_at,run_id:run.run_id}:null;
 if(reward&&(!['approved','declined','expired','pending','void','unknown'].includes(reward.state_observed)||!/^[a-z_]{1,80}$/.test(reward.reward_kind)))throw fail('LOYALTY_INVALID_REWARD');
 return {transaction:row,claim:reward};
}
const fields=spec=>spec.split(' ').map(p=>{const [name,type]=p.split(':');return {name,type};});
export const TABLES={
 customer_snapshots:fields('program_id:STRING customer_ref_id:STRING merchant_id:STRING shopify_customer_gid:STRING enrolled:BOOL guest:BOOL blocked:BOOL enrolled_at:TIMESTAMP approved:INT64 pending:INT64 spent:INT64 tier_id:STRING tier_name:STRING source_updated_at:TIMESTAMP observed_at:TIMESTAMP run_id:STRING'),
 points_transactions:fields('program_id:STRING transaction_id:STRING customer_ref_id:STRING shopify_customer_gid:STRING created_at:TIMESTAMP approved_delta:INT64 pending_delta:INT64 resource:STRING activity_id:STRING shopify_order_gid:STRING observed_at:TIMESTAMP run_id:STRING delta_hash:STRING'),
 reward_claim_observations:fields('program_id:STRING claim_id:STRING customer_ref_id:STRING claimed_at:TIMESTAMP point_cost:INT64 reward_kind:STRING state_observed:STRING observed_at:TIMESTAMP run_id:STRING'),
 coverage_windows:fields('program_id:STRING resource:STRING start_at:TIMESTAMP end_exclusive:TIMESTAMP observed_at:TIMESTAMP run_id:STRING row_count:INT64 status:STRING'),
 sync_checkpoints:fields('program_id:STRING resource:STRING end_exclusive:TIMESTAMP run_id:STRING observed_at:TIMESTAMP'),
 sync_guard:fields('program_id:STRING holder:STRING acquired_at:TIMESTAMP')
};
