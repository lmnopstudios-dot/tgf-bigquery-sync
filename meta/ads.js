import {createHash} from 'node:crypto';
import {date} from './config.js';
export const BREAKDOWNS=Object.freeze({base:[],country:['country'],placement:['publisher_platform','platform_position'],device:['impression_device']});
export const ADS_FIELDS='account_id,account_name,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,date_start,date_stop,spend,impressions,clicks,inline_link_clicks,outbound_clicks,actions,action_values';
const numeric=v=>v!=null&&v!==''&&Number.isFinite(Number(v))?String(v):null;
const action=(values,type)=>{if(!Array.isArray(values))return null;const matched=values.filter(x=>x.action_type===type);if(matched.length>1)throw Object.assign(new Error('Ambiguous duplicate native action type'),{code:'DUPLICATE_NATIVE_ACTION'});return numeric(matched[0]?.value??0);};
export function adsParams(account,start,end,grain='base'){
  date(start);date(end);if(!BREAKDOWNS[grain])throw new Error('Unsupported breakdown');
  return {async:true,level:'ad',time_increment:1,time_range:{since:start,until:end},fields:ADS_FIELDS,breakdowns:BREAKDOWNS[grain].join(',')||null,action_report_time:account.action_report_time,...(account.attribution_windows?{action_attribution_windows:account.attribution_windows}:{use_unified_attribution_setting:true})};
}
export async function verifyAdAccount(client,account){
  const native=await client.request(`act_${account.account_id}`,{fields:'account_id,name,currency,timezone_name,account_status'});
  if(String(native.account_id)!==account.account_id||native.currency!==account.currency||native.timezone_name!==account.timezone)throw Object.assign(new Error('Native account identity/currency/timezone differs from reviewed configuration'),{code:'ACCOUNT_CONFIGURATION_MISMATCH'});
  return native;
}
export function normalizeAds(rows,{config,account,start,end,grain,observedAt,metadata=[]}){
  const ads=new Map(metadata.map(m=>[String(m.id),m]));const seen=new Set();
  return rows.map(row=>{
    if(String(row.account_id)!==account.account_id||!row.ad_id||!row.campaign_id||!row.adset_id||row.date_start!==row.date_stop||row.date_start<start||row.date_stop>end)throw Object.assign(new Error('Meta row violates daily account/window contract'),{code:'INVALID_INSIGHTS_ROW'});
    const breakdown=Object.fromEntries(BREAKDOWNS[grain].map(k=>{if(row[k]==null)throw new Error('Missing requested breakdown');return[k,row[k]];}));
    const key=[row.date_start,row.ad_id,JSON.stringify(breakdown)].join('|');if(seen.has(key))throw new Error('Duplicate daily ad/breakdown row');seen.add(key);
    const ad=ads.get(String(row.ad_id)),creative=ad?.creative||null;
    return {account_id:account.account_id,account_name:row.account_name||account.display_name,report_date:row.date_start,campaign_id:String(row.campaign_id),campaign_name:row.campaign_name||null,adset_id:String(row.adset_id),adset_name:row.adset_name||null,ad_id:String(row.ad_id),ad_name:row.ad_name||null,currency:account.currency,reporting_timezone:account.timezone,spend:numeric(row.spend),impressions:numeric(row.impressions),clicks:numeric(row.clicks),link_clicks:numeric(row.inline_link_clicks),outbound_clicks:action(row.outbound_clicks,'outbound_click'),landing_page_views:action(row.actions,'landing_page_view'),purchase_count:action(row.actions,account.purchase_action_type),purchase_value:action(row.action_values,account.purchase_action_type),purchase_action_type:account.purchase_action_type,actions_json:JSON.stringify(row.actions??null),action_values_json:JSON.stringify(row.action_values??null),breakdown_json:JSON.stringify(breakdown),creative_id:creative?.id||null,creative_json:JSON.stringify(creative),attribution_json:JSON.stringify({requested_windows:account.attribution_windows,unified_adset_setting:!account.attribution_windows,observed_adset_spec:ad?.adset?.attribution_spec||null,settings_observed_at:observedAt,historical_settings_verified:false}),attribution_contract_id:createHash('sha256').update(JSON.stringify({api_version:config.api_version,purchase_action_type:account.purchase_action_type,action_report_time:account.action_report_time,windows:account.attribution_windows,adset_spec:ad?.adset?.attribution_spec||null})).digest('hex').slice(0,24),action_report_time:account.action_report_time,api_version:config.api_version,requested_start:start,requested_end:end,observed_at:observedAt};
  });
}
export async function creativeEvidence(client,account){
  return client.pages(`act_${account.account_id}/ads`,{fields:'id,adset{attribution_spec},creative{id,name,object_type,object_url,object_story_spec,asset_feed_spec}'});
}
