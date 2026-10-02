const ID=/^\d{10}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
export function loadGoogleAdsConfig(env=process.env){
  if(!env.GOOGLE_ADS_ACCOUNTS_JSON)throw new Error('GOOGLE_ADS_ACCOUNTS_JSON is required: configure exactly two reviewed Google Ads accounts; no customer IDs are inferred');
  let accounts;try{accounts=JSON.parse(env.GOOGLE_ADS_ACCOUNTS_JSON)}catch{throw new Error('GOOGLE_ADS_ACCOUNTS_JSON must be valid JSON')}
  if(!Array.isArray(accounts)||accounts.length!==2)throw new Error('GOOGLE_ADS_ACCOUNTS_JSON must contain exactly two accounts');
  const seen=new Set();
  accounts=accounts.map((a,i)=>{const customer_id=String(a.customer_id||'').replace(/-/g,'');if(!ID.test(customer_id))throw new Error(`Google Ads account ${i+1} has invalid customer_id (expected 10 digits)`);if(seen.has(customer_id))throw new Error('Google Ads customer IDs must be distinct');seen.add(customer_id);const login_customer_id=a.login_customer_id?String(a.login_customer_id).replace(/-/g,''):null;if(login_customer_id&&!ID.test(login_customer_id))throw new Error(`Google Ads account ${customer_id} has invalid login_customer_id`);if(!a.display_name)throw new Error(`Google Ads account ${customer_id} requires display_name`);if(!DATE.test(a.history_start||''))throw new Error(`Google Ads account ${customer_id} requires history_start YYYY-MM-DD`);if(a.history_end&&!DATE.test(a.history_end))throw new Error(`Google Ads account ${customer_id} has invalid history_end`);if(!['active','historical_only','disabled'].includes(a.collection_status))throw new Error(`Google Ads account ${customer_id} collection_status must be active, historical_only, or disabled`);return{customer_id,display_name:String(a.display_name),collection_status:a.collection_status,history_start:a.history_start,history_end:a.history_end||null,timezone:a.timezone||null,currency:a.currency||null,login_customer_id};});
  return{api_version:env.GOOGLE_ADS_API_VERSION||'v22',auth_project_id:env.GOOGLE_ADS_AUTH_PROJECT_ID||null,bigquery_project_id:env.GOOGLE_PROJECT_ID||null,accounts};
}
export const activeAccounts=config=>config.accounts.filter(a=>a.collection_status==='active');
